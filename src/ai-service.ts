import { CapacitorHttp, type HttpResponse } from '@capacitor/core'
import { buildChatSystemPrompt, formatConversationTime } from './chat-protocol'
import { completeDebugRequest, recordDebugRequest } from './debug-log'
import { getAttachmentImageDataUrl } from './device-features'
import type { ChatAttachment } from './chat-types'
import type { StoredMemory } from './data-library'

type LoggedRequestOptions = Parameters<typeof CapacitorHttp.request>[0]

// 统一入口发起 HTTP 请求，调试模式开启时记录原始请求与响应。
async function loggedRequest(label: string, options: LoggedRequestOptions): Promise<HttpResponse> {
  const startedAt = Date.now()
  const recordId = recordDebugRequest({
    label,
    method: String(options.method ?? 'GET'),
    url: String(options.url ?? ''),
    requestHeaders: options.headers as Record<string, string> | undefined,
    requestBody: options.data,
  })
  try {
    const response = await CapacitorHttp.request(options)
    completeDebugRequest(recordId, {
      status: response.status,
      responseBody: response.data,
      durationMs: Date.now() - startedAt,
    })
    return response
  } catch (error) {
    completeDebugRequest(recordId, {
      durationMs: Date.now() - startedAt,
      error: error instanceof Error ? error.message : String(error),
    })
    throw error
  }
}

export type QueueMode = 'auto' | 'manual'

export type ModelConfig = {
  baseUrl: string
  apiKey: string
  model: string
  models: string[]
  temperature: number
  maxTokens: number
  queueMode: QueueMode
  queueDelaySeconds: number
  contextMessageCount: number
}

export type AiMessage = {
  from: 'me' | 'them'
  text: string
  kind?: 'text' | 'emoji' | 'attachment'
  groupId?: string
  attachment?: ChatAttachment
}

const STORAGE_KEY = 'mchat2-model-config'

export const defaultModelConfig: ModelConfig = {
  baseUrl: 'https://api.openai.com/v1',
  apiKey: '',
  model: '',
  models: [],
  temperature: 0.85,
  maxTokens: 800,
  queueMode: 'auto',
  queueDelaySeconds: 4,
  contextMessageCount: 60,
}

export function loadModelConfig(): ModelConfig {
  try {
    const stored = JSON.parse(localStorage.getItem(STORAGE_KEY) ?? '{}') as Partial<ModelConfig>
    const storedDelay = Number(stored.queueDelaySeconds)
    return {
      baseUrl: String(stored.baseUrl ?? defaultModelConfig.baseUrl),
      apiKey: String(stored.apiKey ?? ''),
      model: stored.model === 'gpt-4.1-mini' ? '' : String(stored.model ?? ''),
      models: Array.isArray(stored.models) ? stored.models.filter((item): item is string => typeof item === 'string') : [],
      temperature: Number(stored.temperature ?? defaultModelConfig.temperature),
      maxTokens: Number(stored.maxTokens ?? defaultModelConfig.maxTokens),
      queueMode: stored.queueMode === 'manual' ? 'manual' : 'auto',
      queueDelaySeconds: Number.isFinite(storedDelay) ? Math.min(15, Math.max(1, storedDelay)) : defaultModelConfig.queueDelaySeconds,
      contextMessageCount: (() => {
        const value = Number(stored.contextMessageCount)
        return Number.isFinite(value) ? Math.max(10, Math.min(120, Math.round(value))) : defaultModelConfig.contextMessageCount
      })(),
    }
  } catch {
    return defaultModelConfig
  }
}

export function saveModelConfig(config: ModelConfig) {
  localStorage.setItem(STORAGE_KEY, JSON.stringify(config))
}

function chatEndpoint(baseUrl: string) {
  const normalized = baseUrl.trim().replace(/\/+$/, '')
  if (!normalized) throw new Error('请先填写 API 请求地址')
  return normalized.endsWith('/chat/completions') ? normalized : `${normalized}/chat/completions`
}

function modelsEndpoint(baseUrl: string) {
  const normalized = baseUrl.trim().replace(/\/+$/, '')
  if (!normalized) throw new Error('请先填写 API 请求地址')
  if (normalized.endsWith('/chat/completions')) return `${normalized.slice(0, -'/chat/completions'.length)}/models`
  return normalized.endsWith('/models') ? normalized : `${normalized}/models`
}

function authorizationHeaders(config: ModelConfig): Record<string, string> {
  return config.apiKey.trim() ? { Authorization: `Bearer ${config.apiKey.trim()}` } : {}
}

function responseText(data: unknown) {
  const payload = (typeof data === 'string' ? JSON.parse(data) : data) as {
    error?: { message?: string } | string
    choices?: Array<{ message?: { content?: string | Array<{ type?: string; text?: string }> } }>
  }
  if (payload.error) {
    throw new Error(typeof payload.error === 'string' ? payload.error : payload.error.message || '模型服务返回错误')
  }
  const content = payload.choices?.[0]?.message?.content
  if (typeof content === 'string') return content.trim()
  if (Array.isArray(content)) return content.map(part => part.text ?? '').join('').trim()
  throw new Error('模型服务没有返回可用文本')
}

type ApiContentPart =
  | { type: 'text'; text: string }
  | { type: 'image_url'; image_url: { url: string } }

function serializedMessage(message: AiMessage) {
  return message.kind === 'emoji' ? `<${message.text}>` : message.text.trim()
}

async function apiConversationHistory(history: AiMessage[], contextMessageCount = 60) {
  const recent = history.slice(-contextMessageCount)
  let lastUserIndex = -1
  for (let index = recent.length - 1; index >= 0; index -= 1) {
    if (recent[index].from === 'me') {
      lastUserIndex = index
      break
    }
  }
  const latestUserGroup = lastUserIndex >= 0 ? recent[lastUserIndex].groupId : undefined
  const rows: Array<{ role: 'user' | 'assistant'; content: string | ApiContentPart[] }> = []

  for (let index = 0; index < recent.length; index += 1) {
    const message = recent[index]
    const role = message.from === 'me' ? 'user' : 'assistant'
    const text = serializedMessage(message)
    const isLatestUserGroup = role === 'user' && (
      latestUserGroup ? message.groupId === latestUserGroup : index === lastUserIndex
    )
    const imageUrl = isLatestUserGroup && message.kind === 'attachment' && message.attachment?.kind === 'image'
      ? await getAttachmentImageDataUrl(message.attachment)
      : ''
    const content: string | ApiContentPart[] = imageUrl
      ? [{ type: 'text', text }, { type: 'image_url', image_url: { url: imageUrl } }]
      : text
    if (!text && !imageUrl) continue

    const previous = rows[rows.length - 1]
    if (previous?.role !== role) {
      rows.push({ role, content })
      continue
    }
    if (typeof previous.content === 'string' && typeof content === 'string') {
      previous.content += `$${content}`
      continue
    }
    const previousParts = typeof previous.content === 'string'
      ? [{ type: 'text' as const, text: previous.content }]
      : previous.content
    const nextParts = typeof content === 'string'
      ? [{ type: 'text' as const, text: `$${content}` }]
      : content.map((part, partIndex) => part.type === 'text' && partIndex === 0 ? { ...part, text: `$${part.text}` } : part)
    previous.content = [...previousParts, ...nextParts]
  }
  return rows
}

export async function requestAiReply(
  config: ModelConfig,
  role: { name: string; signature: string; persona: string },
  history: AiMessage[],
  emojiNames: string[] = [],
  memories: StoredMemory[] = [],
  userName = '',
) {
  if (!config.model.trim()) throw new Error('请先填写模型名称')
  const temperature = Number.isFinite(config.temperature) ? Math.min(2, Math.max(0, config.temperature)) : defaultModelConfig.temperature
  const maxTokens = Number.isFinite(config.maxTokens) ? Math.max(1, Math.round(config.maxTokens)) : defaultModelConfig.maxTokens
  const systemPrompt = buildChatSystemPrompt(role, emojiNames, memories, userName)
  const conversation = await apiConversationHistory(history, config.contextMessageCount)

  const response = await loggedRequest('聊天回复', {
    url: chatEndpoint(config.baseUrl),
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      ...authorizationHeaders(config),
    },
    data: {
      model: config.model.trim(),
      temperature,
      max_tokens: maxTokens,
      messages: [
        { role: 'system', content: systemPrompt },
        { role: 'system', content: `[当前时间：${formatConversationTime()}]` },
        ...conversation,
      ],
    },
    connectTimeout: 20_000,
    readTimeout: 120_000,
  })

  if (response.status < 200 || response.status >= 300) {
    const detail = (response.data as { error?: { message?: string } })?.error?.message
    throw new Error(detail || `模型请求失败（HTTP ${response.status}）`)
  }
  return responseText(response.data)
}

/**
 * Request a machine-readable response without applying the chat role-play
 * protocol. This is used by background jobs such as memory extraction.
 */
export async function requestStructuredAiReply(
  config: ModelConfig,
  systemPrompt: string,
  history: AiMessage[],
): Promise<string> {
  if (!config.model.trim()) throw new Error('请先填写模型名称')
  const temperature = Number.isFinite(config.temperature) ? Math.min(2, Math.max(0, config.temperature)) : defaultModelConfig.temperature
  const maxTokens = Number.isFinite(config.maxTokens) ? Math.max(1, Math.round(config.maxTokens)) : defaultModelConfig.maxTokens
  const conversation = history
    .slice(-Math.max(1, Math.round(config.contextMessageCount)))
    .map(message => ({
      role: message.from === 'me' ? 'user' as const : 'assistant' as const,
      content: serializedMessage(message),
    }))
    .filter(message => message.content.length > 0)

  const response = await loggedRequest('结构化请求（记忆等）', {
    url: chatEndpoint(config.baseUrl),
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      ...authorizationHeaders(config),
    },
    data: {
      model: config.model.trim(),
      temperature,
      max_tokens: maxTokens,
      messages: [
        { role: 'system', content: systemPrompt },
        ...conversation,
      ],
    },
    connectTimeout: 20_000,
    readTimeout: 120_000,
  })

  if (response.status < 200 || response.status >= 300) {
    const detail = (response.data as { error?: { message?: string } })?.error?.message
    throw new Error(detail || `模型请求失败（HTTP ${response.status}）`)
  }
  return responseText(response.data)
}

export async function fetchModelList(config: ModelConfig) {
  const response = await loggedRequest('获取模型列表', {
    url: modelsEndpoint(config.baseUrl),
    method: 'GET',
    headers: authorizationHeaders(config),
    connectTimeout: 20_000,
    readTimeout: 60_000,
  })
  if (response.status < 200 || response.status >= 300) {
    const detail = (response.data as { error?: { message?: string } })?.error?.message
    throw new Error(detail || '\u83b7\u53d6\u6a21\u578b\u5217\u8868\u5931\u8d25\uff08HTTP ' + response.status + '\uff09')
  }
  const payload = typeof response.data === 'string' ? JSON.parse(response.data) as unknown : response.data
  const rows = (payload as { data?: Array<{ id?: unknown }> })?.data
  if (!Array.isArray(rows)) throw new Error('模型服务返回了无法识别的列表格式')
  const models = [...new Set(rows.map(item => item.id).filter((id): id is string => typeof id === 'string' && Boolean(id.trim())))].sort()
  if (!models.length) throw new Error('模型服务没有返回可用模型')
  return models
}

export async function testModelConnection(config: ModelConfig) {
  return requestAiReply(config, {
    name: '连接测试助手',
    signature: '',
    persona: '请只回复“连接正常”。',
  }, [{ from: 'me', text: '请测试当前模型连接。' }])
}

