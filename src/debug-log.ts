// 隐藏调试模式：在内存中保留网络原始请求，供排查问题使用。
// 开启前不记录任何请求；关闭时立即清空全部记录，不做任何持久化。

export type DebugNetworkRecord = {
  id: string
  at: number
  label: string
  method: string
  url: string
  requestHeaders: Record<string, string>
  requestBody: unknown
  status?: number
  responseBody?: unknown
  durationMs?: number
  error?: string
}

const MAX_RECORDS = 200

let enabled = false
let records: DebugNetworkRecord[] = []
let snapshot = { enabled, records }
const listeners = new Set<() => void>()

function emit() {
  // 每次变更都重建快照引用，未变更时保持同一引用，配合 useSyncExternalStore。
  snapshot = { enabled, records }
  for (const listener of listeners) listener()
}

export function subscribeDebugLog(listener: () => void) {
  listeners.add(listener)
  return () => { listeners.delete(listener) }
}

export function getDebugSnapshot() {
  return snapshot
}

export function isDebugLoggingEnabled() {
  return enabled
}

export function setDebugLoggingEnabled(next: boolean) {
  if (enabled === next) return
  enabled = next
  // 关闭调试模式时清空记录，避免残留敏感信息。
  if (!next) records = []
  emit()
}

export function toggleDebugLogging() {
  setDebugLoggingEnabled(!enabled)
  return enabled
}

function maskHeaders(headers: Record<string, string> = {}) {
  // 仅保留鉴权头的尾部字符，避免完整密钥出现在可截图的调试界面里。
  const masked: Record<string, string> = {}
  for (const [key, value] of Object.entries(headers)) {
    if (/^authorization$/i.test(key) && value) {
      const token = value.replace(/^Bearer\s+/i, '').trim()
      masked[key] = token ? `Bearer ****${token.slice(-4)}` : value
    } else {
      masked[key] = value
    }
  }
  return masked
}

export function recordDebugRequest(entry: {
  label: string
  method: string
  url: string
  requestHeaders?: Record<string, string>
  requestBody?: unknown
}) {
  if (!enabled) return null
  const record: DebugNetworkRecord = {
    id: `${Date.now()}-${Math.random().toString(36).slice(2, 8)}`,
    at: Date.now(),
    label: entry.label,
    method: entry.method,
    url: entry.url,
    requestHeaders: maskHeaders(entry.requestHeaders),
    requestBody: entry.requestBody,
  }
  records = [record, ...records].slice(0, MAX_RECORDS)
  emit()
  return record.id
}

export function completeDebugRequest(id: string | null, result: {
  status?: number
  responseBody?: unknown
  durationMs?: number
  error?: string
}) {
  if (!id) return
  let changed = false
  records = records.map(record => {
    if (record.id !== id) return record
    changed = true
    return { ...record, ...result }
  })
  if (changed) emit()
}

export function clearDebugRecords() {
  if (!records.length) return
  records = []
  emit()
}
