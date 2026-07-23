import { useCallback, useEffect, useRef, useState } from 'react'
import { AlertCircle, Check, Download, FileArchive, Trash2, Upload, X } from 'lucide-react'
import { ConfirmDialog } from './ConfirmDialog'
import {
  exportConversationArchive, formatBytes, getConversationCounts, importConversationArchive,
  inspectConversationArchive, trimConversation,
  exportMemoryArchive, importMemoryArchive, inspectMemoryArchive,
  type ImportProgress,
} from './data-library'
import { useNativeBackDismiss } from './native-back'
import { OverlayPortal } from './OverlayPortal'
import { runViewTransition } from './view-transitions'

type DataRole = { id: number; name: string; avatar: string }
type SelectionDialog =
  | { mode: 'export'; counts: Record<number, number> }
  | { mode: 'import'; counts: Record<number, number>; file: File }

export function DataSettings({ roles, onChanged }: { roles: DataRole[]; onChanged: () => Promise<void> }) {
  const [counts, setCounts] = useState<Record<number, number>>({})
  const [busy, setBusy] = useState(false)
  const [progress, setProgress] = useState<ImportProgress | null>(null)
  const [notice, setNotice] = useState<{ type: 'success' | 'error'; text: string } | null>(null)
  const [selection, setSelection] = useState<SelectionDialog | null>(null)
  const [selectedIds, setSelectedIds] = useState<number[]>([])
  const [deleteRole, setDeleteRole] = useState<DataRole | null>(null)
  const [keepRounds, setKeepRounds] = useState(0)
  const archiveInput = useRef<HTMLInputElement>(null)
  const memoryArchiveInput = useRef<HTMLInputElement>(null)
  const noticeTimer = useRef<number | null>(null)
  const refresh = useCallback(async () => setCounts(await getConversationCounts()), [])
  useNativeBackDismiss(Boolean(selection), () => setSelection(null))

  useEffect(() => { void refresh() }, [refresh])
  useEffect(() => () => { if (noticeTimer.current !== null) window.clearTimeout(noticeTimer.current) }, [])

  const showNotice = (type: 'success' | 'error', text: string) => {
    setNotice({ type, text })
    if (noticeTimer.current !== null) window.clearTimeout(noticeTimer.current)
    noticeTimer.current = window.setTimeout(() => { setNotice(null); noticeTimer.current = null }, 3200)
  }

  const beginExport = () => {
    const available = Object.fromEntries(Object.entries(counts).filter(([, count]) => count > 0))
    const ids = Object.keys(available).map(Number)
    runViewTransition(() => {
      setSelectedIds(ids)
      setSelection({ mode: 'export', counts: available })
    })
  }

  const inspectImport = async (file?: File) => {
    if (!file) return
    setBusy(true)
    try {
      const archiveCounts = await inspectConversationArchive(file)
      const ids = Object.keys(archiveCounts).map(Number)
      if (!ids.length) throw new Error('归档中没有可导入的对话记录')
      runViewTransition(() => {
        setSelectedIds(ids)
        setSelection({ mode: 'import', counts: archiveCounts, file })
      })
    } catch (error) {
      showNotice('error', error instanceof Error ? error.message : '无法读取归档')
    } finally {
      setBusy(false)
      if (archiveInput.current) archiveInput.current.value = ''
    }
  }

  const confirmSelection = async () => {
    if (!selection || !selectedIds.length) return
    const current = selection
    runViewTransition(() => setSelection(null))
    setBusy(true)
    try {
      if (current.mode === 'export') {
        await exportConversationArchive(selectedIds)
        showNotice('success', `已导出 ${selectedIds.length} 个角色的对话记录`)
      } else {
        setProgress({ processed: 0, total: 0, bytes: 0 })
        const imported = await importConversationArchive(current.file, setProgress, selectedIds)
        await refresh()
        await onChanged()
        showNotice('success', `已导入 ${imported.toLocaleString()} 条对话记录`)
      }
    } catch (error) {
      showNotice('error', error instanceof Error ? error.message : current.mode === 'export' ? '导出失败' : '导入失败')
    } finally {
      setBusy(false)
      setProgress(null)
    }
  }

  const exportMemories = async () => {
    setBusy(true)
    try {
      await exportMemoryArchive()
      showNotice('success', '记忆数据已导出')
    } catch (error) {
      showNotice('error', error instanceof Error ? error.message : '导出失败')
    } finally {
      setBusy(false)
    }
  }

  const importMemories = async (file?: File) => {
    if (!file) return
    setBusy(true)
    try {
      setProgress({ processed: 0, total: 0, bytes: 0 })
      const imported = await importMemoryArchive(file, setProgress)
      showNotice('success', "已导入 " + imported + " 条记忆")
    } catch (error) {
      showNotice('error', error instanceof Error ? error.message : '导入失败')
    } finally {
      setBusy(false)
      setProgress(null)
      if (memoryArchiveInput.current) memoryArchiveInput.current.value = ''
    }
  }

  const confirmTrim = async () => {
    if (!deleteRole) return
    setBusy(true)
    try {
      await trimConversation(deleteRole.id, keepRounds)
      await refresh()
      await onChanged()
      showNotice('success', keepRounds > 0 ? `已保留最近 ${keepRounds} 轮对话` : '对话记录已清空')
      runViewTransition(() => setDeleteRole(null))
    } catch (error) {
      showNotice('error', error instanceof Error ? error.message : '删除失败')
    } finally {
      setBusy(false)
    }
  }

  const total = Object.values(counts).reduce((sum, count) => sum + count, 0)
  const roleName = (id: number) => roles.find(role => role.id === id)?.name ?? `未知角色 #${id}`

  return <div className="data-settings">
    <div className="data-heading">
      <div><h2>数据</h2><p>管理 Android 设备上的对话记录。</p></div>
      <div>
        <button className="secondary" onClick={beginExport} disabled={busy || !total}><Upload />导出</button>
        <button className="primary" onClick={() => archiveInput.current?.click()} disabled={busy}><Download />导入</button>
        <input ref={archiveInput} hidden type="file" accept=".ndjson,application/x-ndjson" onChange={event => void inspectImport(event.target.files?.[0])} />
      </div>
    </div>
    <div className="data-summary"><FileArchive /><div><strong>{total.toLocaleString()} 条本地消息</strong></div><b>{progress?.bytes ? formatBytes(progress.bytes) : '本机'}</b></div>
    <div className="record-list">
      {roles.map(role => <article key={role.id} className="record-row">
        <img src={role.avatar} alt="" />
        <div><strong>{role.name}</strong><span>对话记录</span></div>
        <div className="record-count"><b>{(counts[role.id] ?? 0).toLocaleString()}</b><span>条消息</span></div>
        <button className="icon-btn danger-hover" disabled={!counts[role.id]} onClick={() => runViewTransition(() => { setKeepRounds(0); setDeleteRole(role) })} aria-label={`整理 ${role.name} 的对话`}><Trash2 /></button>
      </article>)}
      {!roles.length && <div className="empty-small">暂无角色数据</div>}
    </div>
    <div className="data-section">
      <div className="data-heading" style={{ marginTop: '1.5rem' }}>
        <div><h3>长期记忆</h3><p>管理所有角色的长期记忆数据</p></div>
        <div>
          <button className="secondary" onClick={exportMemories} disabled={busy}><Upload />导出记忆</button>
          <button className="primary" onClick={() => memoryArchiveInput.current?.click()} disabled={busy}><Download />导入记忆</button>
          <input ref={memoryArchiveInput} hidden type="file" accept=".ndjson,application/x-ndjson" onChange={e => void importMemories(e.target.files?.[0])} />
        </div>
      </div>
    </div>
    {progress && <div className="inline-progress"><i><b style={{ width: progress.total ? `${Math.min(100, progress.processed / progress.total * 100)}%` : '36%' }} /></i><span>正在导入 {progress.processed.toLocaleString()} 条{progress.bytes ? ` · ${formatBytes(progress.bytes)}` : ''}</span></div>}
    {notice && <div className={`library-toast ${notice.type}`}>{notice.type === 'success' ? <Check /> : <AlertCircle />}{notice.text}</div>}

    {selection && <OverlayPortal><div className="dialog-overlay" role="dialog" aria-modal="true" aria-labelledby="data-selection-title">
      <section className="data-selection-dialog">
        <header><div><h2 id="data-selection-title">{selection.mode === 'export' ? '选择导出内容' : '选择导入内容'}</h2><p>按角色选择需要处理的对话记录</p></div><button className="icon-btn" onClick={() => runViewTransition(() => setSelection(null))} aria-label="关闭"><X /></button></header>
        <div className="data-selection-actions">
          <button onClick={() => setSelectedIds(Object.keys(selection.counts).map(Number))}>全选</button>
          <button onClick={() => setSelectedIds([])}>清空</button>
        </div>
        <div className="data-selection-list">
          {Object.entries(selection.counts).map(([rawId, count]) => {
            const id = Number(rawId)
            const checked = selectedIds.includes(id)
            return <label key={id} className={checked ? 'selected' : ''}><input type="checkbox" checked={checked} onChange={() => setSelectedIds(current => checked ? current.filter(item => item !== id) : [...current, id])} /><span><strong>{roleName(id)}</strong><small>{count.toLocaleString()} 条消息</small></span><i>{checked && <Check />}</i></label>
          })}
        </div>
        <footer><button className="secondary" onClick={() => runViewTransition(() => setSelection(null))}>取消</button><button className="primary" disabled={!selectedIds.length} onClick={() => void confirmSelection()}>{selection.mode === 'export' ? <Upload /> : <Download />}{selection.mode === 'export' ? '导出所选' : '导入所选'}</button></footer>
      </section>
    </div></OverlayPortal>}

    {deleteRole && <ConfirmDialog
      title={`整理「${deleteRole.name}」的对话`}
      description="选择保留最近多少轮，其余更早的消息会被永久删除。"
      confirmLabel={keepRounds > 0 ? '删除较早记录' : '清空全部记录'}
      destructive
      onCancel={() => setDeleteRole(null)}
      onConfirm={() => void confirmTrim()}
    >
      <label className="keep-rounds-field"><span>保留最近</span><input type="number" min="0" max="9999" value={keepRounds} onChange={event => setKeepRounds(Math.max(0, Math.round(Number(event.target.value) || 0)))} /><span>轮对话</span></label>
      <p>{keepRounds === 0 ? '当前设置会删除全部对话记录。' : `每一轮从你的一组消息开始，并包含紧随其后的角色回复。`}</p>
    </ConfirmDialog>}
  </div>
}
