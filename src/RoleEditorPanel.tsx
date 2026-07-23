import { useCallback, useEffect, useRef, useState } from 'react'
import { Camera, FolderOpen, Image, Save, Trash2, Wallpaper, X } from 'lucide-react'
import { AvatarCropper } from './AvatarCropper'
import { BackgroundCropper } from './BackgroundCropper'
import { ConfirmDialog } from './ConfirmDialog'
import {
  emojiObjectUrl, formatBytes, hasNativeMediaLibrary,
  importNativeEmojis, importWebEmojis, listEmojis, removeEmoji, renameEmoji,
  getMemoriesByRole, saveMemory, updateMemory, deleteMemory, clearMemoriesByRole,
  type EmojiAsset, type StoredMemory,
} from './data-library'
import type { Memory } from './chat-types'
import { runViewTransition } from './view-transitions'

export type EditableRole = {
  id: number
  name: string
  avatar: string
  signature: string
  persona: string
  background?: {
    image: string
    blur: number
    overlay: number
  }
}

function EmojiPreview({ item }: { item: EmojiAsset }) {
  const [src, setSrc] = useState(item.uri ?? '')
  useEffect(() => {
    if (!item.blob) { setSrc(item.uri ?? ''); return }
    const url = emojiObjectUrl(item)
    setSrc(url)
    return () => URL.revokeObjectURL(url)
  }, [item])
  return src ? <img src={src} alt={item.name} loading="lazy" /> : <Image />
}

export function RoleEditorPanel({ role, isNew = false, onClose, onSave, onDelete }: {
  role: EditableRole
  isNew?: boolean
  onClose: () => void
  onSave: (changes: EditableRole) => void
  onDelete?: () => Promise<void> | void
}) {
  const [name, setName] = useState(role.name)
  const [avatar, setAvatar] = useState(role.avatar)
  const [signature, setSignature] = useState(role.signature)
  const [persona, setPersona] = useState(role.persona)
  const [background, setBackground] = useState(role.background)
  const [emojis, setEmojis] = useState<EmojiAsset[]>([])
  const [emojiTotal, setEmojiTotal] = useState(0)
  const [emojiBytes, setEmojiBytes] = useState(0)
  const [emojiVisibleLimit, setEmojiVisibleLimit] = useState(60)
  const [busy, setBusy] = useState(false)
  const [notice, setNotice] = useState('')
  const [cropFile, setCropFile] = useState<File | null>(null)
  const [backgroundCropFile, setBackgroundCropFile] = useState<File | null>(null)
  const [deleteConfirm, setDeleteConfirm] = useState(false)
  const [memories, setMemories] = useState<StoredMemory[]>([])
  const [newMemoryContent, setNewMemoryContent] = useState('')
  const [newMemoryCategory, setNewMemoryCategory] = useState<Memory['category']>('preference')
  const [newMemoryImportance, setNewMemoryImportance] = useState(3)
  const [editingMemoryId, setEditingMemoryId] = useState<string | null>(null)
  const [editingMemoryText, setEditingMemoryText] = useState('')
  const [showMemoryForm, setShowMemoryForm] = useState(false)
  const emojiInput = useRef<HTMLInputElement>(null)
  const promptInput = useRef<HTMLInputElement>(null)
  const avatarInput = useRef<HTMLInputElement>(null)
  const backgroundInput = useRef<HTMLInputElement>(null)
  const nativeLibrary = hasNativeMediaLibrary()

  const refreshEmojis = useCallback(async () => {
    const result = await listEmojis(role.id, 0, emojiVisibleLimit)
    setEmojis(result.items); setEmojiTotal(result.total); setEmojiBytes(result.totalBytes)
  }, [emojiVisibleLimit, role.id])

  useEffect(() => { void refreshEmojis() }, [refreshEmojis])

  const save = () => {
    onSave({ ...role, name: name.trim() || role.name, avatar, signature: signature.trim(), persona: persona.trim(), background })
  }

  const importEmojis = async (files?: File[]) => {
    setBusy(true)
    setNotice('')
    try {
      const result = nativeLibrary
        ? await importNativeEmojis(role.id)
        : { imported: await importWebEmojis(role.id, files ?? [], () => {}), failed: 0, message: undefined }
      if (!result.imported) throw new Error(result.message || '没有导入可用的图片，请检查文件格式')
      await refreshEmojis()
      setNotice(`已导入 ${result.imported} 个表情${result.failed ? `，${result.failed} 个失败` : ''}`)
    } catch (error) {
      setNotice(error instanceof Error ? error.message : '表情导入失败')
    } finally {
      setBusy(false)
      if (emojiInput.current) emojiInput.current.value = ''
    }
  }

  const deleteEmoji = async (item: EmojiAsset) => {
    await removeEmoji(item); await refreshEmojis()
  }

  const importPrompt = async (file?: File) => {
    if (!file) return
    try {
      setPersona(await file.text())
      setNotice(`已导入 ${file.name}`)
    } catch {
      setNotice('无法读取该提示词文件')
    } finally {
      if (promptInput.current) promptInput.current.value = ''
    }
  }

  const importAvatar = async (file?: File) => {
    if (!file) return
    if (!file.type.startsWith('image/')) setNotice('请选择图片文件')
    else runViewTransition(() => setCropFile(file))
    if (avatarInput.current) avatarInput.current.value = ''
  }

  const importBackground = (file?: File) => {
    if (!file) return
    if (!file.type.startsWith('image/')) setNotice('请选择图片文件')
    else runViewTransition(() => setBackgroundCropFile(file))
    if (backgroundInput.current) backgroundInput.current.value = ''
  }

 const updateEmojiName = async (item: EmojiAsset, name: string) => {
   await renameEmoji(item, name)
   await refreshEmojis()
 }

  const refreshMemories = useCallback(async () => {
    const items = await getMemoriesByRole(role.id)
    setMemories(items)
  }, [role.id])

  useEffect(() => { void refreshMemories() }, [refreshMemories])

  const addMemory = async () => {
    const content = newMemoryContent.trim()
    if (!content) return
    await saveMemory(role.id, { category: newMemoryCategory, content, importance: newMemoryImportance })
    setNewMemoryContent('')
    setNewMemoryImportance(3)
    setShowMemoryForm(false)
    await refreshMemories()
  }

  const startEditMemory = (memory: StoredMemory) => {
    setEditingMemoryId(memory.id)
    setEditingMemoryText(memory.content)
  }

  const saveEditedMemory = async () => {
    if (!editingMemoryId) return
    const text = editingMemoryText.trim()
    if (!text) return
    await updateMemory(editingMemoryId, { content: text })
    setEditingMemoryId(null)
    setEditingMemoryText('')
    await refreshMemories()
  }

  const removeMemory = async (id: string) => {
    await deleteMemory(id)
    await refreshMemories()
  }

  return <aside className="role-editor-panel">
    <header><div><span>角色编辑</span><small>直接影响当前对话</small></div><button className="icon-btn" onClick={onClose} aria-label="关闭角色编辑"><X /></button></header>
    <div className="role-editor-scroll">
      <div className="role-editor-identity"><button className="role-editor-avatar" type="button" onClick={() => avatarInput.current?.click()} aria-label="更换角色头像"><img src={avatar} alt={name || role.name} /><span><Camera />更换</span></button><input ref={avatarInput} hidden type="file" accept="image/*" onChange={event => void importAvatar(event.target.files?.[0])} /><div><h2>{name || role.name}</h2><p>{signature || '写一句角色介绍'}</p></div></div>
      <label className="field"><span>角色名称</span><input value={name} onChange={event => setName(event.target.value)} /></label>
      <label className="field"><span>一句话介绍</span><input value={signature} onChange={event => setSignature(event.target.value)} maxLength={60} /><small>{signature.length} / 60</small></label>
      <div className="field prompt-field"><div className="prompt-label"><label htmlFor="role-prompt">角色提示词</label><button type="button" className="secondary compact import-action" onClick={() => promptInput.current?.click()}><FolderOpen />导入 TXT / MD</button></div><textarea id="role-prompt" rows={9} value={persona} onChange={event => setPersona(event.target.value)} placeholder="输入角色身份、说话方式、背景和行为规则…" /><input ref={promptInput} hidden type="file" accept=".txt,.md,text/plain,text/markdown" onChange={event => void importPrompt(event.target.files?.[0])} /></div>
      {notice && <p className="role-notice">{notice}</p>}

      <section className="role-background-section">
        <div className="role-background-heading"><div><h3>聊天背景</h3><p>仅应用于当前角色</p></div><button className="secondary compact import-action" onClick={() => backgroundInput.current?.click()}><Wallpaper />{background?.image ? '更换背景' : '导入背景'}</button><input ref={backgroundInput} hidden type="file" accept="image/*" onChange={event => importBackground(event.target.files?.[0])} /></div>
        {background?.image ? <div className="background-editor">
          <div className="background-preview"><img src={background.image} alt="聊天背景预览" style={{ filter: `blur(${background.blur}px)`, transform: `scale(${1 + background.blur / 100})` }} /><i style={{ opacity: background.overlay / 100 }} /></div>
          <label><span>模糊度</span><input type="range" min="0" max="20" step="1" value={background.blur} onChange={event => setBackground(current => current ? { ...current, blur: Number(event.target.value) } : current)} /><output>{background.blur}</output></label>
          <label><span>遮罩强度</span><input type="range" min="0" max="85" step="1" value={background.overlay} onChange={event => setBackground(current => current ? { ...current, overlay: Number(event.target.value) } : current)} /><output>{background.overlay}%</output></label>
          <button className="text-danger" onClick={() => setBackground(undefined)}><Trash2 />移除聊天背景</button>
        </div> : <button className="background-empty" onClick={() => backgroundInput.current?.click()}><Wallpaper /><span><strong>使用自定义聊天背景</strong><small>支持裁切、模糊和遮罩强度调整</small></span></button>}
      </section>

      <section className="role-emoji-section"><div className="role-emoji-heading"><div><h3>角色表情包</h3><p>{emojiTotal.toLocaleString()} 个 · {formatBytes(emojiBytes)}</p></div><button className="secondary compact import-action" onClick={() => nativeLibrary ? void importEmojis() : emojiInput.current?.click()} disabled={busy}><FolderOpen />导入图片 / ZIP</button><input ref={emojiInput} hidden type="file" multiple accept="image/png,image/jpeg,image/gif,image/webp,.zip,application/zip" onChange={event => void importEmojis(Array.from(event.target.files ?? []))} /></div>
        {emojis.length ? <div className="role-emoji-grid">{emojis.map(item => <article key={item.id}><div className="emoji-image"><EmojiPreview item={item} /><button onClick={() => void deleteEmoji(item)} aria-label={`删除 ${item.name}`}><Trash2 /></button></div><input defaultValue={item.name} onBlur={event => void updateEmojiName(item, event.target.value)} aria-label={`${item.name}的表情名称`} /></article>)}</div> : <div className="emoji-import-empty"><Image /><span><strong>还没有角色表情</strong><small>可导入图片或 ZIP 压缩包，名称自动取自文件名</small></span></div>}
        {emojiTotal > emojis.length && <button className="emoji-load-more secondary" onClick={() => setEmojiVisibleLimit(current => Math.min(emojiTotal, current + 60))}>加载更多（剩余 {(emojiTotal - emojis.length).toLocaleString()} 个）</button>}
      </section>
    
<section className="role-memory-section">
  <div className="role-memory-heading">
    <div><h3>长期记忆</h3><p>{memories.length} 条</p></div>
    <button className="secondary compact" onClick={() => setShowMemoryForm(v => !v)} disabled={busy}>+ 添加记忆</button>
  </div>
  {showMemoryForm && <div className="memory-add-form">
    <div className="memory-form-row">
      <select value={newMemoryCategory} onChange={e => setNewMemoryCategory(e.target.value as Memory["category"])}>
        <option value="preference">偏好</option>
        <option value="habit">习惯</option>
        <option value="event">事件</option>
        <option value="person">人际</option>
        <option value="other">其他</option>
      </select>
      <div className="memory-importance-picker">
        {[1,2,3,4,5].map(n => <button key={n} className={newMemoryImportance >= n ? 'on' : ''} onClick={() => setNewMemoryImportance(n)}>{n}</button>)}
      </div>
    </div>
    <textarea rows={2} value={newMemoryContent} onChange={e => setNewMemoryContent(e.target.value)} placeholder="输入记忆内容..." />
    <div className="memory-form-actions">
      <button className="secondary compact" onClick={() => { setShowMemoryForm(false); setNewMemoryContent('') }}>取消</button>
      <button className="primary compact" disabled={!newMemoryContent.trim()} onClick={() => void addMemory()}>保存</button>
    </div>
  </div>}
  {memories.length > 0 ? <div className="memory-list">
    {memories.map(memory => (
      <article key={memory.id} className="memory-item">
        {editingMemoryId === memory.id ? (
          <div className="memory-edit-inline">
            <textarea rows={2} value={editingMemoryText} onChange={e => setEditingMemoryText(e.target.value)} />
            <div className="memory-edit-actions">
              <button className="secondary compact" onClick={() => setEditingMemoryId(null)}>取消</button>
              <button className="primary compact" onClick={() => void saveEditedMemory()}>保存</button>
            </div>
          </div>
        ) : (
          <>
            <div className="memory-header">
              <span className="memory-category-badge" data-category={memory.category}>{{
                "preference": "偏好", "habit": "习惯", "event": "事件",
                "person": "人际", "other": "其他"
              }[memory.category] || "其他"}</span>
              <span className="memory-importance">{"star".repeat(memory.importance)}</span>
            </div>
            <p className="memory-content">{memory.content}</p>
            <div className="memory-actions">
              <button className="icon-btn" onClick={() => startEditMemory(memory)}>✏️</button>
              <button className="icon-btn danger-hover" onClick={() => void removeMemory(memory.id)}>🗑️</button>
            </div>
          </>
        )}
      </article>
    ))}
  </div> : <div className="memory-empty">
    <span><strong>暂无长期记忆</strong><small>AI 回复后会尝试自动提取</small></span>
  </div>}
</section>
</div>
    <footer><span>{!isNew && onDelete && <button className="delete-role-action" onClick={() => runViewTransition(() => setDeleteConfirm(true))}><Trash2 />删除角色</button>}</span><button className="primary" onClick={save}><Save />保存修改</button></footer>
    {cropFile && <AvatarCropper file={cropFile} onCancel={() => runViewTransition(() => setCropFile(null))} onConfirm={result => runViewTransition(() => { setAvatar(result); setCropFile(null); setNotice('头像已裁切，保存修改后生效') })} />}
    {backgroundCropFile && <BackgroundCropper file={backgroundCropFile} onCancel={() => runViewTransition(() => setBackgroundCropFile(null))} onConfirm={image => runViewTransition(() => { setBackground({ image, blur: background?.blur ?? 0, overlay: background?.overlay ?? 28 }); setBackgroundCropFile(null); setNotice('聊天背景已裁切，保存修改后生效') })} />}
    {deleteConfirm && <ConfirmDialog title={`删除「${name || role.name}」？`} description="角色、对话记录、表情包和附件都会从本机删除，此操作不可撤销。" confirmLabel="删除角色" destructive onCancel={() => setDeleteConfirm(false)} onConfirm={() => { setDeleteConfirm(false); void Promise.resolve(onDelete?.()).then(onClose) }} />}
  </aside>
}
