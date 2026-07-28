import { useCallback, useEffect, useRef, useState } from 'react'
import {
  AlertCircle, Archive, BrainCircuit, Check, Download, FileArchive, HardDriveDownload, ImagePlus, Package, RotateCcw, Trash2, Upload, X,
} from 'lucide-react'
import { AvatarCropper } from './AvatarCropper'
import { ConfirmDialog } from './ConfirmDialog'
import {
  clearMemoriesByRole, exportConversationArchive, exportFullBackup, exportMemoryArchive, formatBytes,
  getConversationCounts, getMemoryStats, hasNativeMediaLibrary, importConversationArchive, importFullBackup,
  importMemoryArchive, inspectConversationArchive, inspectMemoryArchive, trimConversation,
  type ImportProgress, type MemoryStats,
} from './data-library'
import { useNativeBackDismiss } from './native-back'
import { OverlayPortal } from './OverlayPortal'
import type { Role } from './chat-types'
import type { AppPreferences } from './preferences'
import { UserAvatar } from './UserAvatar'
import { runViewTransition } from './view-transitions'
import { persistUiAsset } from './asset-storage'
import { createBackupSettings, normalizeBackupSettings } from './backup-settings'
import { loadModelConfig, saveModelConfig } from './ai-service'
import { loadMemoryModelConfig, saveMemoryModelConfig } from './preferences'

type DataRole = { id: number; name: string; avatar: string }
type SelectionKind = 'conversation' | 'memory'
type SelectionDialog =
  | { kind: SelectionKind; mode: 'export'; counts: Record<number, number> }
  | { kind: SelectionKind; mode: 'import'; counts: Record<number, number>; file: File }

const EMPTY_MEMORY_STATS: MemoryStats = { total: 0, archived: 0, byRole: {} }

export function DataSettings({ roles, preferences, onPreferencesChange, onChanged, onRolesImported }: {
  roles: DataRole[]
  preferences: AppPreferences
  onPreferencesChange: (preferences: AppPreferences) => void
  onChanged: () => Promise<void>
  // 导入对话时恢复归档中的角色（旧归档按 orphanRoleIds 建占位角色），返回实际新增的角色数量。
  onRolesImported: (roles: Role[], orphanRoleIds?: number[]) => Promise<number>
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
  const [backupOpen, setBackupOpen] = useState(false)
  const [backupIds, setBackupIds] = useState<number[]>([])
  const nativeBackup = hasNativeMediaLibrary()
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
  useNativeBackDismiss(backupOpen, () => setBackupOpen(false))

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
        if (current.kind === 'conversation') {
          const { processed, roles: importedRoles, orphanRoleIds } = await importConversationArchive(current.file, setProgress, selectedIds)
          const restored = await onRolesImported(importedRoles, orphanRoleIds)
          await refresh()
          await onChanged()
          showNotice('success', restored > 0
            ? `已导入 ${processed.toLocaleString()} 条对话记录，恢复 ${restored} 个角色`
            : `已导入 ${processed.toLocaleString()} 条对话记录`)
        } else {
          const imported = await importMemoryArchive(current.file, setProgress, selectedIds)
          await refresh()
          showNotice('success', `已导入 ${imported.toLocaleString()} 条长期记忆`)
        }
      }
    } catch (error) {
      const fallback = current.mode === 'export' ? '导出失败' : '导入失败'
      showNotice('error', error instanceof Error ? error.message : fallback)
    } finally {
      setBusy(false)
      setProgress(null)
    }
  }

  const beginBackup = () => {
    // 完整备份的可选角色 = 现有角色 ∪ 有对话/记忆的角色 id。默认全选。
    const ids = Array.from(new Set([
      ...roles.map(role => role.id),
      ...Object.keys(counts).map(Number),
      ...Object.keys(memoryStats.byRole).map(Number),
    ]))
    if (!ids.length) {
      showNotice('error', '暂无可备份的数据')
      return
    }
    runViewTransition(() => {
      setBackupIds(ids)
      setBackupOpen(true)
    })
  }

  const confirmBackup = async () => {
    if (!backupIds.length) return
    const allSelected = backupIds.length === backupCandidates.length
    runViewTransition(() => setBackupOpen(false))
    setBusy(true)
    try {
      const result = await exportFullBackup(
        allSelected ? undefined : backupIds,
        createBackupSettings(preferences, loadModelConfig(), loadMemoryModelConfig()),
      )
      if (result.saved) showNotice('success', `已备份 ${allSelected ? '全部' : backupIds.length + ' 个'}角色，含 ${result.emojis.toLocaleString()} 张表情、${result.attachments.toLocaleString()} 个附件`)
    } catch (error) {
      showNotice('error', error instanceof Error ? error.message : '备份失败')
    } finally {
      setBusy(false)
    }
  }

  const restoreBackup = async () => {
    setBusy(true)
    setProgress({ processed: 0, total: 0, bytes: 0 })
    try {
      const result = await importFullBackup(setProgress)
      if (!result) return // 用户取消
      const restoredSettings = normalizeBackupSettings(
        result.settings,
        preferences,
        loadModelConfig(),
        loadMemoryModelConfig(),
      )
      if (restoredSettings) {
        const userAvatar = await persistUiAsset(restoredSettings.preferences.userAvatar, 'user:avatar')
        onPreferencesChange({ ...restoredSettings.preferences, userAvatar })
        await Promise.all([
          saveModelConfig(restoredSettings.model),
          saveMemoryModelConfig(restoredSettings.memoryModel),
        ])
      }
      await onRolesImported(result.roles, result.orphanRoleIds)
      await refresh()
      await onChanged()
      showNotice('success', `已恢复 ${result.processed.toLocaleString()} 条对话、${result.memoriesImported.toLocaleString()} 条记忆、${result.emojis.toLocaleString()} 张表情、${result.attachments.toLocaleString()} 个附件`)
    } catch (error) {
      showNotice('error', error instanceof Error ? error.message : '恢复失败')
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

  const saveUserAvatar = async (avatar: string) => {
    try {
      const stored = await persistUiAsset(avatar, 'user:avatar')
      onPreferencesChange({ ...preferences, userAvatar: stored })
      runViewTransition(() => setCropFile(null))
      showNotice('success', '用户头像已更新')
    } catch (error) {
      showNotice('error', error instanceof Error ? error.message : '保存用户头像失败')
    }
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
  // 完整备份可选角色：现有角色 + 仅存在于对话/记忆里的角色（占位名）。
  const backupCandidates = [
    ...roles,
    ...Array.from(new Set([...Object.keys(counts).map(Number), ...Object.keys(memoryStats.byRole).map(Number)]))
      .filter(id => !roles.some(role => role.id === id))
      .map(id => ({ id, name: roleName(id), avatar: '' })),
  ]

  return <div className="data-settings">
    {nativeBackup && <section className="setting-group backup-settings">
      <div className="data-heading">
        <div><h2>完整备份</h2><p>把对话、角色与提示词、长期记忆、表情包打包成一个文件，换设备一键迁移。</p></div>
        <div>
          <button className="secondary" onClick={beginBackup} disabled={busy}><Package />导出备份</button>
          <button className="primary" onClick={() => void restoreBackup()} disabled={busy}><HardDriveDownload />恢复备份</button>
        </div>
      </div>
      <div className="data-summary"><Package /><div><strong>一个文件包含角色、对话、附件、记忆与界面设置</strong><span>出于安全考虑不导出 API Key；恢复时不会覆盖已有角色的编辑</span></div><b>.zip</b></div>
    </section>}

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
          <input ref={archiveInput} hidden type="file" accept="*/*" onChange={event => void inspectImport('conversation', event.target.files?.[0])} />
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
          <input ref={memoryArchiveInput} hidden type="file" accept="*/*" onChange={event => void inspectImport('memory', event.target.files?.[0])} />
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

    {backupOpen && <OverlayPortal><div className="dialog-overlay" role="dialog" aria-modal="true" aria-labelledby="backup-selection-title">
      <section className="data-selection-dialog">
        <header><div><h2 id="backup-selection-title">选择备份角色</h2><p>勾选要打包的角色，将一并备份其对话、附件、提示词、长期记忆和表情包</p></div><button className="icon-btn" onClick={() => runViewTransition(() => setBackupOpen(false))} aria-label="关闭"><X /></button></header>
        <div className="data-selection-actions">
          <button onClick={() => setBackupIds(backupCandidates.map(role => role.id))}>全选</button>
          <button onClick={() => setBackupIds([])}>清空</button>
        </div>
        <div className="data-selection-list">
          {backupCandidates.map(role => {
            const checked = backupIds.includes(role.id)
            const messageCount = counts[role.id] ?? 0
            const memoryCount = memoryStats.byRole[role.id]?.total ?? 0
            return <label key={role.id} className={checked ? 'selected' : ''}><input type="checkbox" checked={checked} onChange={() => setBackupIds(current => checked ? current.filter(item => item !== role.id) : [...current, role.id])} /><span><strong>{role.name}</strong><small>{messageCount.toLocaleString()} 条消息 · {memoryCount.toLocaleString()} 条记忆</small></span><i>{checked && <Check />}</i></label>
          })}
        </div>
        <footer><button className="secondary" onClick={() => runViewTransition(() => setBackupOpen(false))}>取消</button><button className="primary" disabled={!backupIds.length} onClick={() => void confirmBackup()}><Package />导出备份</button></footer>
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
    {cropFile && <AvatarCropper file={cropFile} onCancel={() => setCropFile(null)} onConfirm={avatar => void saveUserAvatar(avatar)} />}
  </div>
}
