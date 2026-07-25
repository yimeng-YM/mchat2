import { useState, useSyncExternalStore } from 'react'
import { Bug, ChevronDown, Trash2, X } from 'lucide-react'
import { OverlayPortal } from './OverlayPortal'
import { useNativeBackDismiss } from './native-back'
import { runViewTransition } from './view-transitions'
import {
  clearDebugRecords,
  getDebugSnapshot,
  setDebugLoggingEnabled,
  subscribeDebugLog,
  type DebugNetworkRecord,
} from './debug-log'

function formatBody(body: unknown) {
  if (body === undefined) return ''
  if (typeof body === 'string') {
    try {
      return JSON.stringify(JSON.parse(body), null, 2)
    } catch {
      return body
    }
  }
  try {
    return JSON.stringify(body, null, 2)
  } catch {
    return String(body)
  }
}

function recordTime(at: number) {
  return new Date(at).toLocaleTimeString('zh-CN', { hour: '2-digit', minute: '2-digit', second: '2-digit', hour12: false })
}

function DebugRecordCard({ record }: { record: DebugNetworkRecord }) {
  const [open, setOpen] = useState(false)
  const pending = record.status === undefined && !record.error
  const statusLabel = record.error
    ? '错误'
    : record.status === undefined ? '进行中' : `HTTP ${record.status}`
  const statusClass = record.error || (record.status !== undefined && (record.status < 200 || record.status >= 300))
    ? 'bad'
    : pending ? 'pending' : 'ok'

  return <article className={`debug-record ${open ? 'open' : ''}`}>
    <button className="debug-record-head" onClick={() => setOpen(value => !value)}>
      <span className={`debug-status ${statusClass}`}>{statusLabel}</span>
      <span className="debug-record-title">
        <strong>{record.label}</strong>
        <small>{record.method} · {recordTime(record.at)}{record.durationMs !== undefined ? ` · ${record.durationMs}ms` : ''}</small>
      </span>
      <ChevronDown className="debug-chevron" />
    </button>
    {open && <div className="debug-record-body">
      <label>URL</label>
      <pre>{record.url}</pre>
      <label>请求头</label>
      <pre>{formatBody(record.requestHeaders)}</pre>
      <label>请求体</label>
      <pre>{formatBody(record.requestBody)}</pre>
      {record.error
        ? <><label>错误</label><pre className="debug-error">{record.error}</pre></>
        : <><label>响应体</label><pre>{formatBody(record.responseBody) || '（无内容）'}</pre></>}
    </div>}
  </article>
}

export function DebugOverlay() {
  const snapshot = useSyncExternalStore(subscribeDebugLog, getDebugSnapshot)
  const [panelOpen, setPanelOpen] = useState(false)

  useNativeBackDismiss(panelOpen, () => setPanelOpen(false))

  if (!snapshot.enabled) return null

  return <OverlayPortal>
    <button className="debug-fab" onClick={() => setPanelOpen(true)} aria-label="打开网络调试面板">
      <Bug />
      {snapshot.records.length > 0 && <b>{snapshot.records.length > 99 ? '99+' : snapshot.records.length}</b>}
    </button>
    {panelOpen && <div className="dialog-overlay" role="dialog" aria-modal="true" aria-label="网络调试面板" onPointerDown={event => {
      if (event.target === event.currentTarget) runViewTransition(() => setPanelOpen(false))
    }}>
      <section className="debug-panel">
        <header>
          <div><h2><Bug />网络调试</h2><p>仅在本次开启后记录，共 {snapshot.records.length} 条。关闭调试会立即清空。</p></div>
          <button className="icon-btn" onClick={() => runViewTransition(() => setPanelOpen(false))} aria-label="关闭调试面板"><X /></button>
        </header>
        <div className="debug-record-list">
          {snapshot.records.length
            ? snapshot.records.map(record => <DebugRecordCard key={record.id} record={record} />)
            : <p className="debug-empty">还没有网络请求。发起一次对话或刷新模型列表后会显示在这里。</p>}
        </div>
        <footer>
          <button className="secondary" onClick={clearDebugRecords} disabled={!snapshot.records.length}><Trash2 />清空记录</button>
          <button className="danger-button" onClick={() => runViewTransition(() => { setPanelOpen(false); setDebugLoggingEnabled(false) })}>关闭调试模式</button>
        </footer>
      </section>
    </div>}
  </OverlayPortal>
}
