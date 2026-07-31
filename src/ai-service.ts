import { CapacitorHttp, type HttpResponse } from '@capacitor/core'
import { buildChatSystemPrompt, formatConversationTime } from './chat-protocol'
import { completeDebugRequest, recordDebugRequest } from './debug-log'
import { getAttachmentImageDataUrl, loadNativeSecret, saveNativeSecret } from './device-features'
import type { ChatAttachment } from './chat-types'
import type { StoredMemory } from './data-library'

type LoggedRequestOptions = Parameters<typeof CapacitorHttp.request>[0]

export type ModelEndpointInfo = {
  normalizedBaseUrl: string
  hostname: string
  isCleartext: boolean
  isLan: boolean
  isLoopback: boolean
}

function errorMessage(error: unknown) {
  if (error instanceof Error) return error.message
  if (typeof error === 'string') return error
  if (error && typeof error === 'object' && 'message' in error) return String(error.message)
  return String(error)
}

function isPrivateIpv4(hostname: string) {
  const parts = hostname.split('.').map(Number)
  if (parts.length !== 4 || parts.some(part => !Number.isInteger(part) || part < 0 || part > 255)) return false
  return parts[0] === 10
    || (parts[0] === 172 && parts[1] >= 16 && parts[1] <= 31)
    || (parts[0] === 192 && parts[1] === 168)
    || (parts[0] === 169 && parts[1] === 254)
}

/**
 * Accepts copy-friendly LAN addresses such as `192.168.1.8:11434/v1` while
 * keeping the stored value unambiguous for the native HTTP client.
 */
export function inspectModelEndpoint(value: string): ModelEndpointInfo {
  const trimmed = value.trim()
  if (!trimmed) throw new Error('请先填写 API 请求地址')
  const candidate = /^[a-z][a-z\d+.-]*:\/\//i.test(trimmed) ? trimmed : `http://${trimmed}`
  let url: URL
  try {
    url = new URL(candidate)
  } catch {
    throw new Error('API 请求地址格式不正确，请填写例如 http://192.168.1.100:17892/v1')
  }
  if (url.protocol !== 'http:' && url.protocol !== 'https:') {
    throw new Error('API 请求地址只支持 http:// 或 https://')
  }
  if (url.search || url.hash) throw new Error('API 请求地址不能包含查询参数或页面锚点')

  const hostname = url.hostname.replace(/^\[|\]$/g, '').toLowerCase()
  if (hostname === '0.0.0.0' || hostname === '::') {
    throw new Error('0.0.0.0 仅用于服务监听；手机端请填写电脑的局域网 IP')
  }
  const isLoopback = hostname === 'localhost' || hostname === '::1' || hostname.startsWith('127.')
  const isLan = isLoopback
    || isPrivateIpv4(hostname)
    || hostname.endsWith('.local')
    || (!hostname.includes('.') && hostname !== '')
  const path = url.pathname === '/' ? '' : url.pathname.replace(/\/+$/, '')

  return {
    normalizedBaseUrl: `${url.origin}${path}`,
    hostname,
    isCleartext: url.protocol === 'http:',
    isLan,
    isLoopback,
  }
}

export function normalizeModelBaseUrl(value: string) {
  return inspectModelEndpoint(value).normalizedBaseUrl
}

export function modelApiEndpoints(baseUrl: string) {
  const normalized = normalizeModelBaseUrl(baseUrl)
  const chatUrl = normalized.endsWith('/chat/completions') ? normalized : `${normalized}/chat/completions`
  const modelsUrl = normalized.endsWith('/chat/completions')
    ? `${normalized.slice(0, -'/chat/completions'.length)}/models`
    : normalized.endsWith('/models') ? normalized : `${normalized}/models`
  return { baseUrl: normalized, chatUrl, modelsUrl }
}

export function describeModelRequestError(error: unknown, requestUrl: string) {
  const message = errorMessage(error)
  const lower = message.toLowerCase()
  let endpoint: ModelEndpointInfo | null = null
  try {
    endpoint = inspectModelEndpoint(requestUrl)
  } catch {
    // Preserve the original request failure when its URL cannot be parsed.
  }

  if (endpoint?.isLoopback) {
    return '手机中的 localhost/127.0.0.1 指向手机自身，请改用运行 API 的电脑局域网 IP'
  }
  if (lower.includes('cleartext') && lower.includes('not permitted')) {
    return 'Android 拦截了局域网 HTTP 请求，请安装已启用局域网 HTTP 的最新版 MChat2'
  }
  if (lower.includes('failed to connect') || lower.includes('connection refused') || lower.includes('econnrefused')) {
    return `无法连接模型服务${endpoint ? `（${endpoint.hostname}）` : ''}：请确认手机与电脑在同一网络、服务监听 0.0.0.0，且防火墙已放行端口`
  }
  if (lower.includes('timeout') || lower.includes('timed out')) {
    return '连接模型服务超时：请检查局域网地址、Wi-Fi 访客隔离、防火墙和服务端口'
  }
  if (lower.includes('unable to resolve host') || lower.includes('unknown host') || lower.includes('getaddrinfo')) {
    return '无法解析模型服务地址，请检查电脑局域网 IP 或主机名是否正确'
  }
  if (lower === 'network error' || lower.includes('network request failed')) {
    return '网络请求失败：请检查局域网地址、服务监听地址和防火墙设置'
  }
  return message
}

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
      error: errorMessage(error),
    })
    throw new Error(describeModelRequestError(error, String(options.url ?? '')), { cause: error })
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
const API_KEY_SECRET = 'chat-api-key'
let secureApiKey: string | null = null

// 保存模型配置后广播，供常驻挂载的界面（如 ChatView）实时刷新，避免使用过期配置。
export const MODEL_CONFIG_CHANGED_EVENT = 'mchat2:model-config-changed'

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
      apiKey: secureApiKey ?? String(stored.apiKey ?? ''),
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

export async function saveModelConfig(config: ModelConfig) {
  const next = { ...config }
  try {
    if (secureApiKey !== config.apiKey) {
      const storedNatively = await saveNativeSecret(API_KEY_SECRET, config.apiKey)
      if (storedNatively) secureApiKey = config.apiKey
    }
    if (secureApiKey !== null) next.apiKey = ''
  } finally {
    localStorage.setItem(STORAGE_KEY, JSON.stringify(next))
  }
  if (typeof window !== 'undefined') window.dispatchEvent(new Event(MODEL_CONFIG_CHANGED_EVENT))
}

export async function initializeModelSecret() {
  let stored: Partial<ModelConfig> = {}
  try {
    stored = JSON.parse(localStorage.getItem(STORAGE_KEY) ?? '{}') as Partial<ModelConfig>
  } catch {
    // Keep the default configuration when the legacy record is malformed.
  }
  try {
    const nativeValue = await loadNativeSecret(API_KEY_SECRET)
    if (nativeValue === null) return
    const legacyValue = typeof stored.apiKey === 'string' ? stored.apiKey : ''
    secureApiKey = nativeValue || legacyValue
    if (!nativeValue && legacyValue) await saveNativeSecret(API_KEY_SECRET, legacyValue)
    if ('apiKey' in stored) {
      localStorage.setItem(STORAGE_KEY, JSON.stringify({ ...stored, apiKey: '' }))
    }
    window.dispatchEvent(new Event(MODEL_CONFIG_CHANGED_EVENT))
  } catch {
    secureApiKey = typeof stored.apiKey === 'string' ? stored.apiKey : ''
  }
}

function chatEndpoint(baseUrl: string) {
  return modelApiEndpoints(baseUrl).chatUrl
}

function modelsEndpoint(baseUrl: string) {
  return modelApiEndpoints(baseUrl).modelsUrl
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
  // 合并相邻同角色消息，保证角色严格交替；否则调用方拼接的多条 user 说明会形成
  // 连续 user，严格的 OpenAI 兼容服务会拒绝这类请求。
  const conversation: Array<{ role: 'user' | 'assistant'; content: string }> = []
  for (const message of history.slice(-Math.max(1, Math.round(config.contextMessageCount)))) {
    const content = serializedMessage(message)
    if (!content) continue
    const role = message.from === 'me' ? 'user' as const : 'assistant' as const
    const previous = conversation[conversation.length - 1]
    if (previous?.role === role) previous.content += `\n${content}`
    else conversation.push({ role, content })
  }

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

export type ModelConnectionReport = {
  baseUrl: string
  latencyMs: number
  model: string
  models: string[]
  modelListWarning: string
  reply: string
}

export async function testModelConnection(config: ModelConfig): Promise<ModelConnectionReport> {
  const baseUrl = normalizeModelBaseUrl(config.baseUrl)
  let models: string[] = []
  let modelListWarning = ''
  try {
    models = await fetchModelList({ ...config, baseUrl })
  } catch (error) {
    modelListWarning = errorMessage(error)
  }
  const configuredModel = config.model.trim()
  const model = configuredModel && (!models.length || models.includes(configuredModel))
    ? configuredModel
    : models[0] || ''
  if (!model) {
    throw new Error(modelListWarning
      ? `未填写模型名称，且自动获取模型列表失败：${modelListWarning}`
      : '未填写模型名称，模型服务也没有返回可用模型')
  }
  const startedAt = Date.now()
  const reply = await requestAiReply({ ...config, baseUrl, model }, {
    name: '连接测试助手',
    signature: '',
    persona: '请只回复“连接正常”。',
  }, [{ from: 'me', text: '请测试当前模型连接。' }])
  return {
    baseUrl,
    latencyMs: Date.now() - startedAt,
    model,
    models,
    modelListWarning,
    reply,
  }
}
