import { requestAiReply } from './ai-service'
import type { AiMessage, ModelConfig } from './ai-service'
import type { Memory, MemoryCategory, MemoryInput, MemoryAdjustment, ExtractionOutput, Role } from './chat-types'
import {
  getImportantMemories,
  getMemoriesByRole,
  saveMemory,
  updateMemory,
  deleteMemory,
  libraryDb,
  type StoredMemory,
} from './data-library'
import { loadMemoryModelConfig, type MemoryModelConfig } from './preferences'

const MEMORY_EXTRACTION_SYSTEM_PROMPT = `???????????????????????????????????

=== ???? ===
1. ??????????????????????????????????????????????
2. ?????????????????????????????????????
   - ???????????????
   - ????????????????????/??????????????????????
   - ??????????????????????
3. ????????????????????

=== ???? ===
?????? JSON ????????
{
  "newMemories": [
    {"category":"preference|habit|event|person|other","content":"?????10-50??","importance":1-5}
  ],
  "memoryAdjustments": [
    {"memoryId":"?????id","newImportance":?????1-5,"reason":"????"}
  ],
  "archiveIds": ["??????id??"]
}

- importance: 1=??, 2=??, 3=??, 4=???, 5=????
- ?????????????newMemories ?? []
- ???????????????memoryAdjustments ?? []
- ????????????archiveIds ?? []
- ???????????? JSON?
`

export type ExtractionResult = {
  category: MemoryCategory
  content: string
  importance: number
}

/**
 * ???????????
 * ??????????????????????????????
 */
export function resolveMemoryModelConfig(config: ModelConfig): ModelConfig {
  const memoryConfig = loadMemoryModelConfig()
  if (!memoryConfig.baseUrl.trim() && !memoryConfig.apiKey.trim() && !memoryConfig.model.trim()) {
    // ???????????????
    return { ...config, temperature: Math.min(config.temperature, 0.3) }
  }
  return {
    baseUrl: memoryConfig.baseUrl || config.baseUrl,
    apiKey: memoryConfig.apiKey || config.apiKey,
    model: memoryConfig.model || config.model,
    models: [],
    temperature: memoryConfig.temperature,
    maxTokens: 2000,
    queueMode: 'auto',
    queueDelaySeconds: 4,
    contextMessageCount: 20,
  }
}

/**
 * ??????????? AI ?????????
 * AI ???????????????????????????
 */
export async function extractMemoriesFromConversation(
  config: ModelConfig,
  role: { name: string; persona: string },
  recentConversation: AiMessage[],
  roleId: number,
): Promise<ExtractionOutput> {
  if (!config.model.trim()) return { newMemories: [], memoryAdjustments: [], archiveIds: [] }

  // ?????????
  const existingMemories = await getMemoriesByRole(roleId)
  const existingMemoriesText = existingMemories.length > 0
    ? existingMemories.map(m => `ID:${m.id} | ??:${m.category} | ???:${m.importance} | ??:${m.content}${m.archived ? ' [???]' : ''}`).join('\\n')
    : '???????'

  const contextMessages: AiMessage[] = [
    { from: 'them', text: `????????????????"${role.name}"????` },
    { from: 'them', text: `??????????????\\n${existingMemoriesText}` },
    ...recentConversation.slice(-10),
  ]

  try {
    const memoryConfig = resolveMemoryModelConfig(config)
    const reply = await requestAiReply(
      memoryConfig,
      { name: '??????', signature: '', persona: MEMORY_EXTRACTION_SYSTEM_PROMPT },
      contextMessages,
      [],
    )

    // ???? JSON
    const cleaned = reply.replace(/^\`\`\`(?:json)?\s*/i, '').replace(/\s*\`\`\`$/, '').trim()
    const parsed = JSON.parse(cleaned) as unknown

    if (typeof parsed !== 'object' || parsed === null) {
      return { newMemories: [], memoryAdjustments: [], archiveIds: [] }
    }

    const result = parsed as Partial<ExtractionOutput>

    const newMemories: MemoryInput[] = Array.isArray(result.newMemories)
      ? result.newMemories.filter(
          (item): item is MemoryInput =>
            typeof item === 'object' && item !== null &&
            typeof item.content === 'string' &&
            ['preference', 'habit', 'event', 'person', 'other'].includes(item.category) &&
            typeof item.importance === 'number' && item.importance >= 1 && item.importance <= 5,
        )
      : []

    const memoryAdjustments: MemoryAdjustment[] = Array.isArray(result.memoryAdjustments)
      ? result.memoryAdjustments.filter(
          (item): item is MemoryAdjustment =>
            typeof item === 'object' && item !== null &&
            typeof item.memoryId === 'string' &&
            typeof item.newImportance === 'number' && item.newImportance >= 1 && item.newImportance <= 5 &&
            typeof item.reason === 'string',
        )
      : []

    const archiveIds: string[] = Array.isArray(result.archiveIds)
      ? result.archiveIds.filter(id => typeof id === 'string' && existingMemories.some(m => m.id === id))
      : []

    return { newMemories, memoryAdjustments, archiveIds }
  } catch {
    // ??????????????????
    return { newMemories: [], memoryAdjustments: [], archiveIds: [] }
  }
}

/**
 * ?????????????????????????
 */
export async function deduplicateAndSaveMemories(
  roleId: number,
  results: ExtractionResult[],
  adjustments: MemoryAdjustment[] = [],
  archiveIds: string[] = [],
): Promise<number> {
  let saved = 0

  // 1. ????
  for (const id of archiveIds) {
    const memory = await libraryDb.memories.get(id)
    if (memory && !memory.archived) {
      await libraryDb.memories.update(id, { archived: true, updatedAt: Date.now() })
    }
  }

  // 2. ?????????????
  for (const adj of adjustments) {
    const memory = await libraryDb.memories.get(adj.memoryId)
    if (memory && memory.roleId === roleId) {
      await updateMemory(adj.memoryId, { importance: adj.newImportance })
    }
  }

  // 3. ????????????
  if (!results.length) return saved

  const existing = await getMemoriesByRole(roleId)

  for (const result of results) {
    const normalizedContent = result.content.trim()
    if (!normalizedContent) continue

    // ?????????????????????
    const similar = existing.find(memory => {
      if (memory.archived) return false
      const a = memory.content.toLowerCase()
      const b = normalizedContent.toLowerCase()
      if (a.includes(b) || b.includes(a)) return true
      const wordsA = new Set(a.split(/[?????\s]+/))
      const wordsB = new Set(b.split(/[?????\s]+/))
      const intersection = [...wordsA].filter(w => wordsB.has(w) && w.length >= 2)
      return intersection.length >= Math.min(wordsA.size, wordsB.size) * 0.4
    })

    if (similar) {
      const mergedContent = normalizedContent.length > similar.content.length
        ? normalizedContent
        : similar.content
      const mergedImportance = Math.min(5, Math.max(similar.importance, result.importance) + 1)
      await updateMemory(similar.id, {
        category: result.category,
        content: mergedContent,
        importance: mergedImportance,
      })
    } else {
      await saveMemory(roleId, {
        category: result.category,
        content: normalizedContent,
        importance: result.importance,
      })
      saved += 1
    }
  }

  return saved
}

/**
 * ???????????????????
 */
export async function loadRelevantMemories(roleId: number): Promise<StoredMemory[]> {
  return getImportantMemories(roleId, 20)
}

/**
 * ??????????????????????
 */
const conversationRoundCounts = new Map<number, number>()

export function getConversationRoundCount(roleId: number): number {
  return conversationRoundCounts.get(roleId) ?? 0
}

export function incrementConversationRound(roleId: number): number {
  const current = (conversationRoundCounts.get(roleId) ?? 0) + 1
  conversationRoundCounts.set(roleId, current)
  return current
}

export function resetConversationRoundCount(roleId: number) {
  conversationRoundCounts.set(roleId, 0)
}

export function shouldExtractMemory(roleId: number, interval: number): boolean {
  if (interval <= 0) return false
  const count = getConversationRoundCount(roleId)
  return count > 0 && count % interval === 0
}

/**
 * ???????????????? AI ?????
 */
export async function updateMemoryRoundAccess(roleId: number, roundCount: number): Promise<void> {
  const memories = await getMemoriesByRole(roleId)
  for (const memory of memories) {
    if (!memory.archived) {
      await libraryDb.memories.update(memory.id, { lastRoundAccessed: roundCount })
    }
  }
}
