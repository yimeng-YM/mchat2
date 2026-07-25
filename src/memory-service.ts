import { requestStructuredAiReply } from './ai-service'
import type { AiMessage, ModelConfig } from './ai-service'
import { MEMORY_CATEGORIES } from './chat-types'
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

/** 以角色第一人称视角构建记忆维护提示词，注入角色设定。 */
function buildMemoryExtractionSystemPrompt(role: { name: string; persona: string }): string {
  const personaSection = role.persona.trim()
    ? `你的角色设定如下，请始终以这个身份来观察、记忆和表达：\n${role.persona.trim()}\n\n`
    : ''
  return `你正在扮演"${role.name}"。这是你在私聊中记录对方（用户）的长期记忆。请以你（${role.name}）的第一人称视角，维护关于对方的稳定、可复用信息。

${personaSection}规则：
1. 始终用第一人称"我"来写，把用户称为"对方""ta"或其名字，就像你在自己的记事本里记下关于ta的事，可以带上你作为"${role.name}"对这件事的感受或态度。
2. 只记录未来聊天中仍然有用的信息，例如对方的长期偏好、习惯、重要经历、持续的关系，以及明确的数值信息（年龄、生日、纪念日、数量、金额等）。
3. 不记录寒暄、临时情绪、一次性请求、你自己说过的话，或无法从对话确认的猜测。
4. 每条新记忆要简洁、独立，避免与已有记忆重复。
5. 已有记忆被加强或削弱时可调整重要性；明确过时、冲突或不再成立时可归档。
6. 不要修改或归档不属于当前角色的记忆。

只返回合法 JSON，不要使用 Markdown 代码块或附加说明：
{
  "newMemories": [
    {"category":"preference|habit|event|person|numeric|other","content":"10-80字、以你第一人称写的记忆","importance":1-5}
  ],
  "memoryAdjustments": [
    {"memoryId":"已有记忆ID","newImportance":1-5,"reason":"调整原因"}
  ],
  "archiveIds": ["需要归档的已有记忆ID"]
}

- category：preference=偏好，habit=习惯，event=事件，person=人际，numeric=数值信息（年龄/日期/数量/金额等具体数字），other=其他。
- importance：1=弱相关，2=一般，3=重要，4=很重要，5=核心信息。
- 没有对应操作时，数组必须为空。
`
}

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

  const systemPrompt = buildMemoryExtractionSystemPrompt(role)
  const existingMemories = await getMemoriesByRole(roleId)
  const existingMemoriesText = existingMemories.length > 0
    ? existingMemories
        .map(memory => `ID:${memory.id} | 分类:${memory.category} | 重要性:${memory.importance} | 内容:${memory.content}${memory.archived ? ' [已归档]' : ''}`)
        .join('\n')
    : '当前没有已有记忆'

  const conversationLimit = Math.max(1, memoryConfig.contextMessageCount - 2)
  const contextMessages: AiMessage[] = [
    { from: 'me', text: `以下内容用于维护你（${role.name}）记录的、关于对方的长期记忆。` },
    { from: 'me', text: `已有记忆：\n${existingMemoriesText}` },
    ...recentConversation.slice(-conversationLimit),
  ]

  try {
    const reply = await requestStructuredAiReply(memoryConfig, systemPrompt, contextMessages)
    let result: Partial<ExtractionOutput>
    try {
      result = parseExtractionObject(reply)
    } catch (firstError) {
      console.warn('记忆模型首次输出无法解析，正在自动纠正', firstError)
      const retryReply = await requestStructuredAiReply(
        { ...memoryConfig, temperature: 0 },
        `${systemPrompt}\n这是格式纠错重试。必须直接输出一个 JSON 对象，首字符为 {，末字符为 }。不要输出思考过程、XML 标签、Markdown 或解释。`,
        [
          ...contextMessages,
          { from: 'me', text: '上一轮输出格式不合格。请重新完成记忆维护，并严格按指定 JSON 对象格式返回。' },
        ],
      )
      try {
        result = parseExtractionObject(retryReply)
      } catch {
        throw new Error('记忆模型连续两次未返回可识别的 JSON，请更换支持结构化输出的记忆模型')
      }
    }
    const newMemories: MemoryInput[] = Array.isArray(result.newMemories)
      ? result.newMemories.filter(
          (item): item is MemoryInput =>
            typeof item === 'object' && item !== null &&
            typeof item.content === 'string' &&
            (MEMORY_CATEGORIES as readonly string[]).includes(item.category) &&
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
    throw error
  }
}

function balancedJsonObjects(value: string): string[] {
  const candidates: string[] = []
  let start = -1
  let depth = 0
  let inString = false
  let escaped = false

  for (let index = 0; index < value.length; index += 1) {
    const character = value[index]
    if (inString) {
      if (escaped) escaped = false
      else if (character === '\\') escaped = true
      else if (character === '"') inString = false
      continue
    }
    if (character === '"') {
      inString = true
      continue
    }
    if (character === '{') {
      if (depth === 0) start = index
      depth += 1
    } else if (character === '}' && depth > 0) {
      depth -= 1
      if (depth === 0 && start >= 0) {
        candidates.push(value.slice(start, index + 1))
        start = -1
      }
    }
  }
  return candidates
}

function unwrapJsonObject(value: unknown, depth = 0): Record<string, unknown> | null {
  if (depth > 3) return null
  if (typeof value === 'string') {
    try {
      return unwrapJsonObject(JSON.parse(value), depth + 1)
    } catch {
      return null
    }
  }
  if (!value || typeof value !== 'object' || Array.isArray(value)) return null
  const object = value as Record<string, unknown>
  if (['newMemories', 'memoryAdjustments', 'archiveIds'].some(key => key in object)) return object
  for (const key of ['result', 'data', 'json', 'content', 'output']) {
    if (key in object) {
      const nested = unwrapJsonObject(object[key], depth + 1)
      if (nested) return nested
    }
  }
  return null
}

function parseExtractionObject(reply: string): Partial<ExtractionOutput> {
  const cleaned = reply
    .replace(/^\uFEFF/, '')
    .replace(/<think\b[^>]*>[\s\S]*?<\/think>/gi, ' ')
    .replace(/<analysis\b[^>]*>[\s\S]*?<\/analysis>/gi, ' ')
    .trim()
  const fenced = [...cleaned.matchAll(/```(?:json)?\s*([\s\S]*?)```/gi)].map(match => match[1].trim())
  const candidates = [cleaned, ...fenced, ...balancedJsonObjects(cleaned).reverse()]

  for (const candidate of [...new Set(candidates)].filter(Boolean)) {
    try {
      const object = unwrapJsonObject(JSON.parse(candidate))
      if (object) return object as Partial<ExtractionOutput>
    } catch {
      // Continue through fenced and balanced candidates.
    }
  }
  throw new Error('记忆模型没有返回可识别的 JSON 对象')
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

const ROUND_COUNTS_KEY = 'mchat2-memory-round-counts'

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
