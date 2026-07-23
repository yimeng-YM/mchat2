import { useCallback, useEffect, useRef, useState } from 'react'
import {
  AlertCircle, Archive, BrainCircuit, Check, Download, FileArchive, ImagePlus, RotateCcw, Trash2, Upload, X,
} from 'lucide-react'
import { AvatarCropper } from './AvatarCropper'
import { ConfirmDialog } from './ConfirmDialog'
import {
  clearMemoriesByRole, exportConversationArchive, exportMemoryArchive, formatBytes,
  getConversationCounts, getMemoryStats, importConversationArchive, importMemoryArchive,
  inspectConversationArchive, inspectMemoryArchive, trimConversation,
  type ImportProgress, type MemoryStats,
} from './data-library'
import { useNativeBackDismiss } from './native-back'
import { OverlayPortal } from './OverlayPortal'
import type { AppPreferences } from './preferences'
import { UserAvatar } from './UserAvatar'
import { runViewTransition } from './view-transitions'

type DataRole = { id: number; name: string; avatar: string }
type SelectionKind = 'conversation' | 'memory'
type SelectionDialog =
  | { kind: SelectionKind; mode: 'export'; counts: Record<number, number> }
  | { kind: SelectionKind; mode: 'import'; counts: Record<number, number>; file: File }

const EMPTY_MEMORY_STATS: MemoryStats = { total: 0, archived: 0, byRole: {} }

export function DataSettings({ roles, preferences, onPreferencesChange, onChanged }: {
  roles: DataRole[]
  preferences: AppPreferences
  onPreferencesChange: (preferences: AppPreferences) => void
  onChanged: () => Promise<void>
}) {
  const [counts, setCounts] = useState<Record<number, number>>({})
  const [memoryStats, setMemoryStats] = useState<MemoryStats>(EMPTY_MEMORY_STATS)
  const [busy, setBusy] = useState(false)
  const [progress, setProgress] = useState<ImportProgress | null>(null)
  const [notice, setNotice] = useState<{ type: 'success' | 'error'; text: string } | null>(null)
  const [selection, setSelection] = useState<SelectionDialog | null>(null)
  const [selectedIds, setSelectedIds] = useState<number[]>([])
  const [deleteRole, setDeleteRole] = useState<DataRole | null>(null)
  const [memoryDeleteRole, setMemoryDeleteRole] = useState<DataRole | null>(null)
  const [keepRounds, setKeepRounds] = useState(0)
  const [cropFile, setCropFile] = useState<File | null>(null)
  const archiveInput = useRef<HTMLInputElement>(null)
  const memoryArchiveInput = useRef<HTMLInputElement>(null)
  const avatarInput = useRef<HTMLInputElement>(null)
  const noticeTimer = useRef<number | null>(null)
  const refresh = useCallback(async () => {
    const [nextCounts, nextMemoryStats] = await Promise.all([getConversationCounts(), getMemoryStats()])
    setCounts(nextCounts)
    setMemoryStats(nextMemoryStats)
  }, [])
  useNativeBackDismiss(Boolean(selection), () => setSelection(null))

  useEffect(() => { void refresh() }, [refresh])
  useEffect(() => () => { if (noticeTimer.current !== null) window.clearTimeout(noticeTimer.current) }, [])

  const showNotice = (type: 'success' | 'error', text: string) => {
    setNotice({ type, text })
    if (noticeTimer.current !== null) window.clearTimeout(noticeTimer.current)
    noticeTimer.current = window.setTimeout(() => { setNotice(null); noticeTimer.current = null }, 3200)
  }

  const selectionCounts = (kind: SelectionKind) => kind === 'conversation'
    ? counts
    : Object.fromEntries(Object.entries(memoryStats.byRole).map(([roleId, stats]) => [roleId, stats.total]))

  const beginExport = (kind: SelectionKind) => {
    const available = Object.fromEntries(Object.entries(selectionCounts(kind)).filter(([, count]) => count > 0))
    const ids = Object.keys(available).map(Number)
    if (!ids.length) {
      showNotice('error', kind === 'conversation' ? '暂无可导出的对话记录' : '暂无可导出的长期记忆')
      return
    }
    runViewTransition(() => {
      setSelectedIds(ids)
      setSelection({ kind, mode: 'export', counts: available })
    })
  }

  const inspectImport = async (kind: SelectionKind, file?: File) => {
    if (!file) return
    setBusy(true)
    try {
      const archiveCounts = kind === 'conversation'
        ? await inspectConversationArchive(file)
        : await inspectMemoryArchive(file)
      const ids = Object.keys(archiveCounts).map(Number)
      if (!ids.length) throw new Error(kind === 'conversation' ? '归档中没有可导入的对话记录' : '归档中没有可导入的长期记忆')
      runViewTransition(() => {
        setSelectedIds(ids)
        setSelection({ kind, mode: 'import', counts: archiveCounts, file })
      })
    } catch (error) {
      showNotice('error', error instanceof Error ? error.message : '无法读取归档')
    } finally {
      setBusy(false)
      const input = kind === 'conversation' ? archiveInput.current : memoryArchiveInput.current
      if (input) input.value = ''
    }
  }

  const confirmSelection = async () => {
    if (!selection || !selectedIds.length) return
    const current = selection
    runViewTransition(() => setSelection(null))
    setBusy(true)
    try {
      if (current.mode === 'export') {
        if (current.kind === 'conversation') await exportConversationArchive(selectedIds)
        else await exportMemoryArchive(selectedIds)
        showNotice('success', `已导出 ${selectedIds.length} 个角色的${current.kind === 'conversation' ? '对话记录' : '长期记忆'}`)
      } else {
        setProgress({ processed: 0, total: 0, bytes: 0 })
        const imported = current.kind === 'conversation'
          ? await importConversationArchive(current.file, setProgress, selectedIds)
          : await importMemoryArchive(current.file, setProgress, selectedIds)
        await refresh()
        if (current.kind === 'conversation') await onChanged()
        showNotice('success', `已导入 ${imported.toLocaleString()} 条${current.kind === 'conversation' ? '对话记录' : '长期记忆'}`)
      }
    } catch (error) {
      const fallback = current.mode === 'export' ? '导出失败' : '导入失败'
      showNotice('error', error instanceof Error ? error.message : fallback)
    } finally {
      setBusy(false)
      setProgress(null)
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

  const clearRoleMemories = async () => {
    if (!memoryDeleteRole) return
    setBusy(true)
    try {
      const removed = await clearMemoriesByRole(memoryDeleteRole.id)
      await refresh()
      showNotice('success', `已删除 ${removed.toLocaleString()} 条长期记忆`)
      setMemoryDeleteRole(null)
    } catch (error) {
      showNotice('error', error instanceof Error ? error.message : '清理长期记忆失败')
    } finally {
      setBusy(false)
    }
  }

  const chooseAvatar = (file?: File) => {
    if (!file) return
    if (!file.type.startsWith('image/')) showNotice('error', '请选择图片文件')
    else runViewTransition(() => setCropFile(file))
    if (avatarInput.current) avatarInput.current.value = ''
  }

  const total = Object.values(counts).reduce((sum, count) => sum + count, 0)
  const activeMemories = memoryStats.total - memoryStats.archived
  const roleName = (id: number) => roles.find(role => role.id === id)?.name ?? `未知角色 #${id}`
  const memoryRoles = [
    ...roles,
    ...Object.keys(memoryStats.byRole)
      .map(Number)
      .filter(id => !roles.some(role => role.id === id))
      .map(id => ({ id, name: roleName(id), avatar: '' })),
  ]
  const selectionUnit = selection?.kind === 'conversation' ? '条消息' : '条记忆'

  return <div className="data-settings">
    <section className="setting-group profile-settings">
      <div className="data-heading"><div><h2>个人资料</h2><p>用于聊天中的用户头像和名称，仅保存在本机。</p></div></div>
      <div className="profile-settings-body">
        <div className="profile-avatar-editor">
          <UserAvatar name={preferences.userName} avatar={preferences.userAvatar} size="lg" />
          <div>
            <button className="secondary" onClick={() => avatarInput.current?.click()}><ImagePlus />选择头像</button>
            <button className="profile-reset-avatar" onClick={() => onPreferencesChange({ ...preferences, userAvatar: '' })} disabled={!preferences.userAvatar}><RotateCcw />恢复默认</button>
            <input ref={avatarInput} hidden type="file" accept="image/*" onChange={event => chooseAvatar(event.target.files?.[0])} />
          </div>
        </div>
        <label className="field profile-name-field"><span>用户名</span><input value={preferences.userName} maxLength={32} onChange={event => onPreferencesChange({ ...preferences, userName: event.target.value.slice(0, 32) })} onBlur={event => onPreferencesChange({ ...preferences, userName: event.target.value.trim() || '你' })} placeholder="你" /><small>{preferences.userName.length} / 32</small></label>
      </div>
    </section>

    <section className="setting-group">
      <div className="data-heading">
        <div><h2>对话记录</h2><p>管理这台设备上的本地聊天内容。</p></div>
        <div>
          <button className="secondary" onClick={() => beginExport('conversation')} disabled={busy || !total}><Upload />导出</button>
          <button className="primary" onClick={() => archiveInput.current?.click()} disabled={busy}><Download />导入</button>
          <input ref={archiveInput} hidden type="file" accept=".ndjson,application/x-ndjson" onChange={event => void inspectImport('conversation', event.target.files?.[0])} />
        </div>
      </div>
      <div className="data-summary"><FileArchive /><div><strong>{total.toLocaleString()} 条本地消息</strong><span>归档文件可以按角色选择导入或导出</span></div><b>{progress?.bytes ? formatBytes(progress.bytes) : '本机'}</b></div>
      <div className="record-list">
        {roles.map(role => <article key={role.id} className="record-row">
          <img src={role.avatar} alt="" />
          <div><strong>{role.name}</strong><span>对话记录</span></div>
          <div className="record-count"><b>{(counts[role.id] ?? 0).toLocaleString()}</b><span>条消息</span></div>
          <button className="icon-btn danger-hover" disabled={!counts[role.id]} onClick={() => runViewTransition(() => { setKeepRounds(0); setDeleteRole(role) })} aria-label={`整理 ${role.name} 的对话`}><Trash2 /></button>
        </article>)}
        {!roles.length && <div className="empty-small">暂无角色数据</div>}
      </div>
    </section>

    <section className="setting-group memory-data-settings">
      <div className="data-heading">
        <div><h2>长期记忆</h2><p>查看所有角色的记忆状态，并按角色迁移或清理。</p></div>
        <div>
          <button className="secondary" onClick={() => beginExport('memory')} disabled={busy || !memoryStats.total}><Upload />导出</button>
          <button className="primary" onClick={() => memoryArchiveInput.current?.click()} disabled={busy}><Download />导入</button>
          <input ref={memoryArchiveInput} hidden type="file" accept=".ndjson,application/x-ndjson" onChange={event => void inspectImport('memory', event.target.files?.[0])} />
        </div>
      </div>
      <div className="memory-data-metrics">
        <div><BrainCircuit /><span><strong>{memoryStats.total.toLocaleString()}</strong><small>全部记忆</small></span></div>
        <div><Check /><span><strong>{activeMemories.toLocaleString()}</strong><small>活动记忆</small></span></div>
        <div><Archive /><span><strong>{memoryStats.archived.toLocaleString()}</strong><small>已归档</small></span></div>
      </div>
      <div className="record-list memory-record-list">
        {memoryRoles.map(role => {
          const stats = memoryStats.byRole[role.id] ?? { total: 0, archived: 0 }
          return <article key={role.id} className="record-row">
            {role.avatar ? <img src={role.avatar} alt="" /> : <div className="record-avatar-placeholder"><BrainCircuit /></div>}
            <div><strong>{role.name}</strong><span>{stats.total - stats.archived} 条活动 · {stats.archived} 条归档</span></div>
            <div className="record-count"><b>{stats.total.toLocaleString()}</b><span>条记忆</span></div>
            <button className="icon-btn danger-hover" disabled={!stats.total} onClick={() => setMemoryDeleteRole(role)} aria-label={`清空 ${role.name} 的长期记忆`}><Trash2 /></button>
          </article>
        })}
        {!memoryRoles.length && <div className="empty-small">暂无角色记忆</div>}
      </div>
    </section>

    {progress && <div className="inline-progress"><i><b style={{ width: progress.total ? `${Math.min(100, progress.processed / progress.total * 100)}%` : '36%' }} /></i><span>正在导入 {progress.processed.toLocaleString()} 条{progress.bytes ? ` · ${formatBytes(progress.bytes)}` : ''}</span></div>}
    {notice && <div className={`library-toast ${notice.type}`}>{notice.type === 'success' ? <Check /> : <AlertCircle />}{notice.text}</div>}

    {selection && <OverlayPortal><div className="dialog-overlay" role="dialog" aria-modal="true" aria-labelledby="data-selection-title">
      <section className="data-selection-dialog">
        <header><div><h2 id="data-selection-title">{selection.mode === 'export' ? '选择导出内容' : '选择导入内容'}</h2><p>按角色选择需要处理的{selection.kind === 'conversation' ? '对话记录' : '长期记忆'}</p></div><button className="icon-btn" onClick={() => runViewTransition(() => setSelection(null))} aria-label="关闭"><X /></button></header>
        <div className="data-selection-actions">
          <button onClick={() => setSelectedIds(Object.keys(selection.counts).map(Number))}>全选</button>
          <button onClick={() => setSelectedIds([])}>清空</button>
        </div>
        <div className="data-selection-list">
          {Object.entries(selection.counts).map(([rawId, count]) => {
            const id = Number(rawId)
            const checked = selectedIds.includes(id)
            return <label key={id} className={checked ? 'selected' : ''}><input type="checkbox" checked={checked} onChange={() => setSelectedIds(current => checked ? current.filter(item => item !== id) : [...current, id])} /><span><strong>{roleName(id)}</strong><small>{count.toLocaleString()} {selectionUnit}</small></span><i>{checked && <Check />}</i></label>
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
      <p>{keepRounds === 0 ? '当前设置会删除全部对话记录。' : '每一轮从你的一组消息开始，并包含紧随其后的角色回复。'}</p>
    </ConfirmDialog>}
    {memoryDeleteRole && <ConfirmDialog title={`清空「${memoryDeleteRole.name}」的长期记忆？`} description={`将永久删除 ${(memoryStats.byRole[memoryDeleteRole.id]?.total ?? 0).toLocaleString()} 条记忆，包括已归档内容。`} confirmLabel="清空长期记忆" destructive onCancel={() => setMemoryDeleteRole(null)} onConfirm={() => void clearRoleMemories()} />}
    {cropFile && <AvatarCropper file={cropFile} onCancel={() => setCropFile(null)} onConfirm={avatar => runViewTransition(() => { onPreferencesChange({ ...preferences, userAvatar: avatar }); setCropFile(null); showNotice('success', '用户头像已更新') })} />}
  </div>
}
