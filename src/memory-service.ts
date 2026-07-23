import { requestAiReply } from './ai-service'
import type { AiMessage, ModelConfig } from './ai-service'
import type { ExtractionOutput, MemoryAdjustment, MemoryCategory, MemoryInput } from './chat-types'
import {
  getImportantMemories,
  getMemoriesByRole,
  libraryDb,
  saveMemory,
  updateMemory,
  type StoredMemory,
} from './data-library'
import { loadMemoryModelConfig } from './preferences'

const MEMORY_EXTRACTION_SYSTEM_PROMPT = `你是长期记忆维护器。请根据最新对话和已有记忆，维护关于用户的稳定、可复用信息。

规则：
1. 只记录未来对话中仍有帮助的信息，例如长期偏好、习惯、重要经历、持续关系和明确计划。
2. 不记录寒暄、临时情绪、一次性请求、模型自己的回复，或无法从对话确认的推测。
3. 新记忆应简洁、独立、以用户为主体，避免重复已有内容。
4. 已有记忆被加强或削弱时，可调整重要性；明确过时、冲突或不再有效时可归档。
5. 不要直接修改或归档不属于当前角色的记忆。

只返回合法 JSON，不要使用 Markdown 代码块或附加说明：
{
  "newMemories": [
    {"category":"preference|habit|event|person|other","content":"10-80字的记忆内容","importance":1-5}
  ],
  "memoryAdjustments": [
    {"memoryId":"已有记忆ID","newImportance":1-5,"reason":"调整原因"}
  ],
  "archiveIds": ["需要归档的已有记忆ID"]
}

- importance：1=弱相关，2=一般，3=重要，4=很重要，5=核心信息。
- 没有对应操作时，数组必须为空。
`

export type ExtractionResult = {
  category: MemoryCategory
  content: string
  importance: number
}

/** 使用独立记忆模型配置；空字段继承聊天模型。 */
export function resolveMemoryModelConfig(config: ModelConfig): ModelConfig {
  const memoryConfig = loadMemoryModelConfig()
  if (!memoryConfig.baseUrl.trim() && !memoryConfig.apiKey.trim() && !memoryConfig.model.trim()) {
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
    contextMessageCount: config.contextMessageCount,
  }
}

/** 让模型比较最近对话和现有记忆，返回结构化维护操作。 */
export async function extractMemoriesFromConversation(
  config: ModelConfig,
  role: { name: string; persona: string },
  recentConversation: AiMessage[],
  roleId: number,
): Promise<ExtractionOutput> {
  const memoryConfig = resolveMemoryModelConfig(config)
  if (!memoryConfig.model.trim()) return { newMemories: [], memoryAdjustments: [], archiveIds: [] }

  const existingMemories = await getMemoriesByRole(roleId)
  const existingMemoriesText = existingMemories.length > 0
    ? existingMemories
        .map(memory => `ID:${memory.id} | 分类:${memory.category} | 重要性:${memory.importance} | 内容:${memory.content}${memory.archived ? ' [已归档]' : ''}`)
        .join('\n')
    : '当前没有已有记忆'

  const conversationLimit = Math.max(1, memoryConfig.contextMessageCount - 2)
  const contextMessages: AiMessage[] = [
    { from: 'me', text: `以下内容用于维护角色「${role.name}」对应的用户长期记忆。` },
    { from: 'me', text: `已有记忆：\n${existingMemoriesText}` },
    ...recentConversation.slice(-conversationLimit),
  ]

  try {
    const reply = await requestAiReply(
      memoryConfig,
      { name: '长期记忆整理器', signature: '', persona: MEMORY_EXTRACTION_SYSTEM_PROMPT },
      contextMessages,
      [],
    )
    const cleaned = reply.replace(/^```(?:json)?\s*/i, '').replace(/\s*```$/, '').trim()
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
            typeof item.reason === 'string' &&
            existingMemories.some(memory => memory.id === item.memoryId),
        )
      : []
    const archiveIds = Array.isArray(result.archiveIds)
      ? result.archiveIds.filter(
          (id): id is string => typeof id === 'string' && existingMemories.some(memory => memory.id === id),
        )
      : []

    return {
      newMemories: newMemories.map(memory => ({
        ...memory,
        content: memory.content.trim().slice(0, 500),
        importance: Math.max(1, Math.min(5, Math.round(memory.importance))),
      })).filter(memory => Boolean(memory.content)),
      memoryAdjustments: memoryAdjustments.map(adjustment => ({
        ...adjustment,
        newImportance: Math.max(1, Math.min(5, Math.round(adjustment.newImportance))),
      })),
      archiveIds,
    }
  } catch (error) {
    console.warn('长期记忆提取失败', error)
    return { newMemories: [], memoryAdjustments: [], archiveIds: [] }
  }
}

function memoryTokens(content: string) {
  return new Set(content.toLowerCase().split(/[\s\p{P}\p{S}]+/u).filter(Boolean))
}

/** 应用归档、重要性调整，并对新记忆做轻量去重。 */
export async function deduplicateAndSaveMemories(
  roleId: number,
  results: ExtractionResult[],
  adjustments: MemoryAdjustment[] = [],
  archiveIds: string[] = [],
): Promise<number> {
  let saved = 0

  for (const id of archiveIds) {
    const memory = await libraryDb.memories.get(id)
    if (memory && memory.roleId === roleId && !memory.archived) {
      await libraryDb.memories.update(id, { archived: true, updatedAt: Date.now() })
    }
  }

  for (const adjustment of adjustments) {
    const memory = await libraryDb.memories.get(adjustment.memoryId)
    if (memory && memory.roleId === roleId) {
      await updateMemory(adjustment.memoryId, { importance: adjustment.newImportance })
    }
  }

  if (!results.length) return saved
  const existing = await getMemoriesByRole(roleId)

  for (const result of results) {
    const normalizedContent = result.content.trim()
    if (!normalizedContent) continue

    const similar = existing.find(memory => {
      if (memory.archived) return false
      const a = memory.content.toLowerCase()
      const b = normalizedContent.toLowerCase()
      if (a.includes(b) || b.includes(a)) return true
      const wordsA = memoryTokens(a)
      const wordsB = memoryTokens(b)
      if (!wordsA.size || !wordsB.size) return false
      const intersection = [...wordsA].filter(word => wordsB.has(word) && word.length >= 2)
      return intersection.length >= Math.min(wordsA.size, wordsB.size) * 0.4
    })

    if (similar) {
      const mergedContent = normalizedContent.length > similar.content.length
        ? normalizedContent
        : similar.content
      const mergedImportance = Math.min(5, Math.max(similar.importance, result.importance) + 1)
      const updated = await updateMemory(similar.id, {
        category: result.category,
        content: mergedContent,
        importance: mergedImportance,
      })
      if (updated) Object.assign(similar, updated)
    } else {
      const created = await saveMemory(roleId, {
        category: result.category,
        content: normalizedContent,
        importance: Math.max(1, Math.min(5, Math.round(result.importance))),
      })
      existing.push(created)
      saved += 1
    }
  }

  return saved
}

export async function loadRelevantMemories(roleId: number): Promise<StoredMemory[]> {
  return getImportantMemories(roleId, 20)
}

const ROUND_COUNTS_KEY = 'jinyu-memory-round-counts'

function loadConversationRoundCounts() {
  try {
    const stored = JSON.parse(localStorage.getItem(ROUND_COUNTS_KEY) ?? '{}') as Record<string, unknown>
    return new Map(Object.entries(stored).flatMap(([roleId, value]) => {
      const parsedRoleId = Number(roleId)
      const count = Number(value)
      return Number.isFinite(parsedRoleId) && Number.isFinite(count) && count >= 0
        ? [[parsedRoleId, Math.round(count)] as const]
        : []
    }))
  } catch {
    return new Map<number, number>()
  }
}

const conversationRoundCounts = loadConversationRoundCounts()

function persistConversationRoundCounts() {
  try {
    localStorage.setItem(ROUND_COUNTS_KEY, JSON.stringify(Object.fromEntries(conversationRoundCounts)))
  } catch {
    // Storage can be unavailable in restricted WebViews.
  }
}

export function getConversationRoundCount(roleId: number): number {
  return conversationRoundCounts.get(roleId) ?? 0
}

export function incrementConversationRound(roleId: number): number {
  const current = (conversationRoundCounts.get(roleId) ?? 0) + 1
  conversationRoundCounts.set(roleId, current)
  persistConversationRoundCounts()
  return current
}

export function resetConversationRoundCount(roleId: number) {
  conversationRoundCounts.delete(roleId)
  persistConversationRoundCounts()
}

export function shouldExtractMemory(roleId: number, interval: number): boolean {
  if (interval <= 0) return false
  const count = getConversationRoundCount(roleId)
  return count > 0 && count % interval === 0
}

/** 标记本轮实际注入模型上下文的记忆。 */
export async function updateMemoryRoundAccess(roleId: number, roundCount: number, memoryIds?: string[]): Promise<void> {
  const memories = memoryIds?.length
    ? (await libraryDb.memories.bulkGet(memoryIds)).filter((memory): memory is StoredMemory => Boolean(memory))
    : await getMemoriesByRole(roleId)
  for (const memory of memories) {
    if (memory.roleId === roleId && !memory.archived) {
      await libraryDb.memories.update(memory.id, { lastRoundAccessed: roundCount })
    }
  }
}
