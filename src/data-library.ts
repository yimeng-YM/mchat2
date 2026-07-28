import Dexie, { type EntityTable } from 'dexie'
import { Capacitor, registerPlugin } from '@capacitor/core'
import { removeNativeRoleFiles } from './device-features'
import {
  listUiAssetsForBackup,
  removeRoleUiAssets,
  restoreUiAssets,
  type UiAsset as BackupUiAsset,
} from './asset-storage'
import { MEMORY_CATEGORIES } from './chat-types'
import type { ChatAttachment, Message, Memory, MemoryInput, Role } from './chat-types'

// 角色信息保存在 localStorage（由 App 维护），对话/记忆保存在 IndexedDB。
// 导出对话归档时需一并带上角色定义，否则换设备导入后消息会成为“孤儿数据”。
export const ROLES_STORAGE_KEY = 'mchat2-roles'

export type StoredMessage = {
  key: string
  roleId: number
  messageId: number
  from: 'me' | 'them'
  text: string
  kind?: Message['kind']
  groupId?: string
  delivery?: Message['delivery']
  attachment?: ChatAttachment
  edited?: boolean
  time: string
  createdAt: number
}

export type StoredMemory = {
  id: string
  roleId: number
  category: Memory['category']
  content: string
  importance: number
  createdAt: number
  updatedAt: number
  archived?: boolean
  lastRoundAccessed?: number
}

export type MemoryStats = {
  total: number
  archived: number
  byRole: Record<number, { total: number; archived: number }>
}

export type EmojiAsset = {
  id: string
  roleId: number
  name: string
  mime: string
  size: number
  createdAt: number
  source: 'web' | 'native'
  blob?: Blob
  uri?: string
  rawUri?: string
}

export type UiAsset = {
  id: string
  owner: string
  mime: string
  blob: Blob
  createdAt: number
}

export type ConversationJob = {
  roleId: number
  state: 'inflight' | 'failed'
  userMessageIds: number[]
  createdAt: number
  updatedAt: number
  error?: string
}

export type ImportProgress = { processed: number; total: number; bytes?: number }

const MAX_ARCHIVE_BYTES = 512 * 1024 * 1024
const MAX_ARCHIVE_LINE_CHARS = 16 * 1024 * 1024
const MAX_ARCHIVE_RECORDS = 2_000_000

function validateArchiveFile(file: File) {
  if (file.size <= 0) throw new Error('归档文件为空')
  if (file.size > MAX_ARCHIVE_BYTES) throw new Error('归档文件超过 512 MB 安全限制')
}

function validateArchiveLine(line: string, recordCount: number) {
  if (line.length > MAX_ARCHIVE_LINE_CHARS) throw new Error('归档中存在超过 16 MB 的异常记录')
  if (recordCount > MAX_ARCHIVE_RECORDS) throw new Error('归档记录数超过安全限制')
}

class Mchat2Database extends Dexie {
  messages!: EntityTable<StoredMessage, 'key'>
  emojis!: EntityTable<EmojiAsset, 'id'>
  meta!: EntityTable<{ key: string; value: string }, 'key'>
  memories!: EntityTable<StoredMemory, 'id'>
  uiAssets!: EntityTable<UiAsset, 'id'>
  conversationJobs!: EntityTable<ConversationJob, 'roleId'>

  constructor() {
    super('mchat2-library')
    this.version(1).stores({
      messages: '&key,roleId,createdAt,[roleId+createdAt]',
      emojis: '&id,roleId,createdAt,[roleId+createdAt],name',
      meta: '&key',
    })
    this.version(2).stores({
      memories: '&id,roleId,category,importance,createdAt,updatedAt,[roleId+category],[roleId+importance]',
    })
    this.version(3).stores({
      messages: '&key,roleId,createdAt,[roleId+createdAt]',
      emojis: '&id,roleId,createdAt,[roleId+createdAt],name',
      meta: '&key',
      memories: '&id,roleId,category,importance,createdAt,updatedAt,[roleId+category],[roleId+importance]',
      uiAssets: '&id,owner,createdAt',
      conversationJobs: '&roleId,state,updatedAt',
    })
  }
}

export const libraryDb = new Mchat2Database()

export function messageFromStored(row: StoredMessage): Message {
  return {
    id: row.messageId,
    createdAt: row.createdAt,
    from: row.from,
    text: row.text,
    kind: row.kind,
    groupId: row.groupId,
    delivery: row.delivery,
    attachment: row.attachment,
    edited: row.edited,
    time: row.time,
  }
}

type NativeEmojiPage = { items: EmojiAsset[]; total: number; totalBytes: number }
type NativeImportResult = { imported: number; failed: number; message?: string }

interface LargeMediaPlugin {
  pickAndImport(options: { roleId: number }): Promise<NativeImportResult>
  list(options: { roleId: number; offset: number; limit: number }): Promise<NativeEmojiPage>
  remove(options: { uri: string }): Promise<{ removed: boolean }>
  rename(options: { uri: string; name: string }): Promise<{ renamed: boolean }>
  stats(): Promise<{ total: number; totalBytes: number }>
  beginTextExport(options: { name: string }): Promise<{ token: string }>
  appendTextExport(options: { token: string; chunk: string }): Promise<void>
  saveTextExport(options: { token: string; name: string }): Promise<{ saved: boolean }>
  exportRolePack(options: { roleId: number; name: string }): Promise<{ exported: number; saved: boolean }>
  removeRole(options: { roleId: number }): Promise<void>
  assembleBackup(options: { convToken: string; memToken: string; assetToken: string; manifest: string; roleIds: number[] | null; name: string }): Promise<{ saved: boolean; emojis: number; attachments: number }>
  pickBackup(): Promise<{
    restored: boolean
    conversationsPath?: string
    memoriesPath?: string
    assetsPath?: string
    attachmentRootUri?: string
    manifest?: string
    emojis?: number
    attachments?: number
  }>
}

const nativeMedia = registerPlugin<LargeMediaPlugin>('LargeMedia')

export function hasNativeMediaLibrary() {
  return Capacitor.isNativePlatform() && Capacitor.isPluginAvailable('LargeMedia')
}

export async function seedConversationLibrary(seed: Record<number, Array<{ id: number; from: 'me' | 'them'; text: string; time: string }>>) {
  if (await libraryDb.meta.get('demo-seeded')) return
  const rows = Object.entries(seed).flatMap(([roleId, messages]) => messages.map((message, index) => ({
    key: `${roleId}:${message.id}`,
    roleId: Number(roleId),
    messageId: message.id,
    from: message.from,
    text: message.text,
    time: message.time,
    createdAt: Date.now() - (messages.length - index) * 1000,
  } satisfies StoredMessage)))
  await libraryDb.transaction('rw', libraryDb.messages, libraryDb.meta, async () => {
    await libraryDb.messages.bulkPut(rows)
    await libraryDb.meta.put({ key: 'demo-seeded', value: new Date().toISOString() })
  })
}

export async function loadConversation(roleId: number, limit = 200) {
  const rows = await libraryDb.messages.where('[roleId+createdAt]').between([roleId, Dexie.minKey], [roleId, Dexie.maxKey]).reverse().limit(limit).toArray()
  return rows.reverse().map(messageFromStored)
}

export async function saveConversationMessages(roleId: number, messages: Message[]) {
  const now = Date.now()
  await libraryDb.messages.bulkPut(messages.map((message, index) => ({
    key: `${roleId}:${message.id}`,
    roleId,
    messageId: message.id,
    from: message.from,
    text: message.text,
    kind: message.kind,
    groupId: message.groupId,
    delivery: message.delivery,
    attachment: message.attachment,
    edited: message.edited,
    time: message.time,
    createdAt: Number.isFinite(message.createdAt) ? Number(message.createdAt) : now - (messages.length - index),
  })))
}

export async function updateConversationMessages(roleId: number, messages: Message[]) {
  await libraryDb.transaction('rw', libraryDb.messages, async () => {
    for (const message of messages) {
      await libraryDb.messages.update(`${roleId}:${message.id}`, {
        text: message.text,
        kind: message.kind,
        groupId: message.groupId,
        delivery: message.delivery,
        attachment: message.attachment,
        edited: message.edited,
        time: message.time,
      })
    }
  })
}

export async function replaceConversationGroup(roleId: number, removedIds: number[], messages: Message[]) {
  await libraryDb.transaction('rw', libraryDb.messages, async () => {
    await libraryDb.messages.bulkDelete(removedIds.map(id => `${roleId}:${id}`))
    await saveConversationMessages(roleId, messages)
  })
}

export async function getConversationCounts() {
  const roleIds = await libraryDb.messages.orderBy('roleId').uniqueKeys() as number[]
  const pairs = await Promise.all(roleIds.map(async roleId => [roleId, await libraryDb.messages.where('roleId').equals(roleId).count()] as const))
  return Object.fromEntries(pairs) as Record<number, number>
}

export async function clearConversation(roleId: number) {
  return libraryDb.messages.where('roleId').equals(roleId).delete()
}

export async function trimConversation(roleId: number, keepRounds: number) {
  if (keepRounds <= 0) return clearConversation(roleId)
  const rows = await libraryDb.messages.where('[roleId+createdAt]').between([roleId, Dexie.minKey], [roleId, Dexie.maxKey]).toArray()
  const roundStarts: number[] = []
  let previousGroup = ''
  rows.forEach((row, index) => {
    if (row.from !== 'me') return
    const group = row.groupId || `single:${row.messageId}`
    if (group !== previousGroup) roundStarts.push(index)
    previousGroup = group
  })
  if (roundStarts.length <= keepRounds) return 0
  const keepFrom = roundStarts[roundStarts.length - keepRounds]
  const keys = rows.slice(0, keepFrom).map(row => row.key)
  await libraryDb.messages.bulkDelete(keys)
  return keys.length
}

export async function removeRoleData(roleId: number) {
  await libraryDb.transaction('rw', libraryDb.messages, libraryDb.emojis, libraryDb.memories, libraryDb.conversationJobs, async () => {
    await libraryDb.messages.where('roleId').equals(roleId).delete()
    if (!hasNativeMediaLibrary()) await libraryDb.emojis.where('roleId').equals(roleId).delete()
    await libraryDb.memories.where('roleId').equals(roleId).delete()
    await libraryDb.conversationJobs.delete(roleId)
  })
  await removeRoleUiAssets(roleId)
  if (hasNativeMediaLibrary()) await nativeMedia.removeRole({ roleId })
  await removeNativeRoleFiles(roleId)
}

export async function removeLegacyDefaultData() {
  if (await libraryDb.meta.get('legacy-defaults-removed')) return
  await libraryDb.transaction('rw', libraryDb.messages, libraryDb.emojis, libraryDb.memories, libraryDb.meta, async () => {
    await libraryDb.messages.where('roleId').anyOf([1, 2, 3, 4]).delete()
    if (!hasNativeMediaLibrary()) await libraryDb.emojis.where('roleId').anyOf([1, 2, 3, 4]).delete()
    await libraryDb.memories.where('roleId').anyOf([1, 2, 3, 4]).delete()
    await libraryDb.meta.put({ key: 'legacy-defaults-removed', value: new Date().toISOString() })
  })
  if (hasNativeMediaLibrary()) {
    for (const roleId of [1, 2, 3, 4]) await nativeMedia.removeRole({ roleId })
  }
  for (const roleId of [1, 2, 3, 4]) await removeNativeRoleFiles(roleId)
}

async function putMessageBatch(batch: StoredMessage[]) {
  if (!batch.length) return
  await libraryDb.messages.bulkPut(batch)
}

function readStoredRoles(): Role[] {
  try {
    const stored = JSON.parse(localStorage.getItem(ROLES_STORAGE_KEY) ?? '[]') as Role[] | { roles?: Role[] }
    return Array.isArray(stored) ? stored : Array.isArray(stored.roles) ? stored.roles : []
  } catch {
    return []
  }
}

// 把归档里的原始角色数据规范成完整 Role，缺失字段用安全默认值补齐。
export function normalizeArchivedRole(raw: Partial<Role> & { id: unknown }): Role | null {
  const id = Number(raw.id)
  if (!Number.isFinite(id) || !id) return null
  const boundedNumber = (value: unknown, fallback: number, min: number, max: number) => {
    const parsed = Number(value)
    return Number.isFinite(parsed) ? Math.max(min, Math.min(max, parsed)) : fallback
  }
  return {
    id,
    name: typeof raw.name === 'string' && raw.name.trim() ? raw.name.trim().slice(0, 128) : `角色 #${id}`,
    avatar: typeof raw.avatar === 'string' && raw.avatar.length <= MAX_ARCHIVE_LINE_CHARS ? raw.avatar : '/avatars/default-role.svg',
    signature: typeof raw.signature === 'string' ? raw.signature.slice(0, 1_000) : '',
    relation: typeof raw.relation === 'string' ? raw.relation.slice(0, 256) : '',
    status: typeof raw.status === 'string' ? raw.status.slice(0, 256) : '',
    tags: Array.isArray(raw.tags) ? raw.tags.filter((tag): tag is string => typeof tag === 'string').slice(0, 50).map(tag => tag.slice(0, 64)) : [],
    unread: 0,
    last: typeof raw.last === 'string' ? raw.last : '',
    time: typeof raw.time === 'string' ? raw.time : '',
    online: typeof raw.online === 'boolean' ? raw.online : true,
    persona: typeof raw.persona === 'string' ? raw.persona.slice(0, 200_000) : '',
    background: raw.background && typeof raw.background === 'object'
      ? {
          image: typeof raw.background.image === 'string' && raw.background.image.length <= MAX_ARCHIVE_LINE_CHARS ? raw.background.image : '',
          blur: boundedNumber(raw.background.blur, 0, 0, 20),
          overlay: boundedNumber(raw.background.overlay, 0, 0, 85),
        }
      : undefined,
  }
}

// 生成归档中的角色行（每行一个 {type:'mchat2-role', ...Role}），按所选角色过滤。
function buildRoleChunk(selectedRoleIds?: number[]): string {
  const selected = selectedRoleIds?.length ? new Set(selectedRoleIds) : null
  const roles = readStoredRoles().filter(role => !selected || selected.has(role.id))
  return roles.map(role => `${JSON.stringify({ type: 'mchat2-role', ...role })}\n`).join('')
}

export async function inspectConversationArchive(file: File) {
  validateArchiveFile(file)
  const reader = file.stream().getReader()
  const decoder = new TextDecoder()
  const counts: Record<number, number> = {}
  let buffer = ''
  const consume = (rawLine: string) => {
    const line = rawLine.trim()
    if (!line) return
    validateArchiveLine(line, Object.values(counts).reduce((sum, count) => sum + count, 0))
    const item = JSON.parse(line) as Partial<StoredMessage> & { type?: string }
    if (item.type === 'mchat2-archive' || item.type === 'mchat2-role') return
    const roleId = Number(item.roleId)
    if (!roleId || !item.text || (item.from !== 'me' && item.from !== 'them')) throw new Error('归档中包含无效的对话记录')
    counts[roleId] = (counts[roleId] ?? 0) + 1
  }
  while (true) {
    const { value, done } = await reader.read()
    if (done) break
    buffer += decoder.decode(value, { stream: true })
    const lines = buffer.split('\n')
    buffer = lines.pop() ?? ''
    for (const line of lines) consume(line)
  }
  buffer += decoder.decode()
  if (buffer.trim()) consume(buffer)
  return counts
}

export async function importConversationArchive(
  file: File,
  onProgress: (progress: ImportProgress) => void,
  selectedRoleIds?: number[],
  attachmentRootUri?: string,
) {
  validateArchiveFile(file)
  const reader = file.stream().getReader()
  const decoder = new TextDecoder()
  const selected = selectedRoleIds?.length ? new Set(selectedRoleIds) : null
  let buffer = ''
  let bytes = 0
  let processed = 0
  let scanned = 0
  let batch: StoredMessage[] = []
  const roles: Role[] = []
  const messageRoleIds = new Set<number>()

  const consumeLine = async (rawLine: string) => {
    const line = rawLine.trim()
    if (!line) return
    validateArchiveLine(line, scanned)
    const item = JSON.parse(line) as Partial<StoredMessage> & { type?: string }
    if (item.type === 'mchat2-archive') return
    if (item.type === 'mchat2-role') {
      const role = normalizeArchivedRole(item as unknown as Partial<Role> & { id: unknown })
      if (role && (!selected || selected.has(role.id))) roles.push(role)
      return
    }
    scanned += 1
    if (!item.roleId || !item.text || (item.from !== 'me' && item.from !== 'them')) throw new Error(`第 ${scanned} 行不是有效的对话记录`)
    if (selected && !selected.has(Number(item.roleId))) return
    messageRoleIds.add(Number(item.roleId))
    const messageId = Number(item.messageId ?? Date.now() + processed)
    const roleId = Number(item.roleId)
    const attachment = item.kind === 'attachment' && item.attachment && typeof item.attachment === 'object'
      ? (() => {
          const raw = item.attachment as ChatAttachment
          if (
            raw.kind !== 'image'
            || !/^[\p{L}\p{N}._-]{1,220}$/u.test(String(raw.id ?? ''))
            || typeof raw.name !== 'string'
            || typeof raw.mime !== 'string'
          ) return undefined
          const normalized: ChatAttachment = {
            id: raw.id,
            kind: 'image',
            name: raw.name.slice(0, 240),
            mime: raw.mime.startsWith('image/') ? raw.mime.slice(0, 100) : 'image/jpeg',
            size: Math.max(0, Number.isFinite(Number(raw.size)) ? Number(raw.size) : 0),
          }
          if (attachmentRootUri) {
            const rawUri = `${attachmentRootUri.replace(/\/+$/, '')}/${roleId}/${raw.id}`
            return { ...normalized, rawUri, uri: Capacitor.convertFileSrc(rawUri) }
          }
          if (typeof raw.rawUri === 'string' && raw.rawUri.startsWith('file://')) normalized.rawUri = raw.rawUri
          if (typeof raw.uri === 'string' && /^(https?:|blob:|data:image\/|file:)/.test(raw.uri)) normalized.uri = raw.uri
          return normalized
        })()
      : undefined
    batch.push({
      key: `${item.roleId}:${messageId}`,
      roleId,
      messageId,
      from: item.from,
      text: String(item.text),
      kind: item.kind === 'emoji' || item.kind === 'attachment' ? item.kind : undefined,
      groupId: item.groupId,
      delivery: item.delivery,
      attachment,
      edited: item.edited,
      time: String(item.time ?? ''),
      createdAt: Number(item.createdAt ?? Date.now() + processed),
    })
    processed += 1
    if (batch.length >= 500) {
      await putMessageBatch(batch)
      batch = []
      onProgress({ processed, total: 0, bytes })
    }
  }

  while (true) {
    const { value, done } = await reader.read()
    if (done) break
    bytes += value.byteLength
    buffer += decoder.decode(value, { stream: true })
    const lines = buffer.split('\n')
    buffer = lines.pop() ?? ''
    for (const line of lines) await consumeLine(line)
  }
  buffer += decoder.decode()
  if (buffer.trim()) await consumeLine(buffer)
  await putMessageBatch(batch)
  onProgress({ processed, total: processed, bytes })
  // 归档里没有对应角色定义、但消息引用了的 roleId（旧版 v1 归档会走到这里），交给上层兜底建占位角色。
  const definedIds = new Set(roles.map(role => role.id))
  const orphanRoleIds = [...messageRoleIds].filter(id => !definedIds.has(id))
  return { processed, roles, orphanRoleIds }
}

async function writeArchiveToStream(writer: WritableStreamDefaultWriter<Uint8Array>, selectedRoleIds?: number[]) {
  const encoder = new TextEncoder()
  const selected = selectedRoleIds?.length ? new Set(selectedRoleIds) : null
  await writer.write(encoder.encode(`${JSON.stringify({ type: 'mchat2-archive', version: 2 })}\n`))
  const roleChunk = buildRoleChunk(selectedRoleIds)
  if (roleChunk) await writer.write(encoder.encode(roleChunk))
  let offset = 0
  while (true) {
    const rows = await libraryDb.messages.orderBy('createdAt').offset(offset).limit(500).toArray()
    if (!rows.length) break
    const selectedRows = selected ? rows.filter(row => selected.has(row.roleId)) : rows
    if (selectedRows.length) await writer.write(encoder.encode(selectedRows.map(row => JSON.stringify(row)).join('\n') + '\n'))
    offset += rows.length
  }
}

export async function exportConversationArchive(selectedRoleIds?: number[]) {
  const archiveName = `MChat2-对话记录-${new Date().toISOString().slice(0, 10)}.ndjson`
  if (hasNativeMediaLibrary()) {
    const { token } = await nativeMedia.beginTextExport({ name: archiveName })
    await nativeMedia.appendTextExport({ token, chunk: `${JSON.stringify({ type: 'mchat2-archive', version: 2 })}\n` })
    const roleChunk = buildRoleChunk(selectedRoleIds)
    if (roleChunk) await nativeMedia.appendTextExport({ token, chunk: roleChunk })
    let offset = 0
    while (true) {
      const rows = await libraryDb.messages.orderBy('createdAt').offset(offset).limit(500).toArray()
      if (!rows.length) break
      const selected = selectedRoleIds?.length ? new Set(selectedRoleIds) : null
      const selectedRows = selected ? rows.filter(row => selected.has(row.roleId)) : rows
      if (selectedRows.length) await nativeMedia.appendTextExport({ token, chunk: selectedRows.map(row => JSON.stringify(row)).join('\n') + '\n' })
      offset += rows.length
    }
    await nativeMedia.saveTextExport({ token, name: archiveName })
    return
  }
  const picker = (window as typeof window & { showSaveFilePicker?: (options: unknown) => Promise<{ createWritable: () => Promise<FileSystemWritableFileStream> }> }).showSaveFilePicker
  if (picker) {
    const handle = await picker({ suggestedName: archiveName, types: [{ description: 'MChat2 对话归档', accept: { 'application/x-ndjson': ['.ndjson'] } }] })
    const writable = await handle.createWritable()
    const writer = writable.getWriter()
    await writeArchiveToStream(writer, selectedRoleIds)
    await writer.close()
    return
  }

  const chunks: BlobPart[] = [`${JSON.stringify({ type: 'mchat2-archive', version: 2 })}\n`]
  const roleChunk = buildRoleChunk(selectedRoleIds)
  if (roleChunk) chunks.push(roleChunk)
  const selected = selectedRoleIds?.length ? new Set(selectedRoleIds) : null
  await libraryDb.messages.orderBy('createdAt').each(row => { if (!selected || selected.has(row.roleId)) chunks.push(`${JSON.stringify(row)}\n`) })
  const url = URL.createObjectURL(new Blob(chunks, { type: 'application/x-ndjson' }))
  const anchor = document.createElement('a')
  anchor.href = url
  anchor.download = archiveName
  anchor.click()
  window.setTimeout(() => URL.revokeObjectURL(url), 1000)
}

export async function importWebEmojis(roleId: number, files: File[], onProgress: (progress: ImportProgress) => void) {
  const imageFiles = files.filter(file => file.type.startsWith('image/'))
  let processed = 0
  for (let index = 0; index < imageFiles.length; index += 50) {
    const batch = imageFiles.slice(index, index + 50).map((file, itemIndex) => ({
      id: crypto.randomUUID(),
      roleId,
      name: file.name.replace(/\.[^.]+$/, ''),
      mime: file.type || 'application/octet-stream',
      size: file.size,
      createdAt: Date.now() + index + itemIndex,
      source: 'web' as const,
      blob: file,
    }))
    await libraryDb.emojis.bulkPut(batch)
    processed += batch.length
    onProgress({ processed, total: imageFiles.length })
  }
  return processed
}

export async function importNativeEmojis(roleId: number) {
  return nativeMedia.pickAndImport({ roleId })
}

export async function listEmojis(roleId: number, offset: number, limit: number) {
  if (hasNativeMediaLibrary()) {
    const result = await nativeMedia.list({ roleId, offset, limit })
    return { ...result, items: result.items.map(item => ({ ...item, source: 'native' as const, rawUri: item.uri, uri: item.uri ? Capacitor.convertFileSrc(item.uri) : undefined })) }
  }
  const collection = libraryDb.emojis.where('[roleId+createdAt]').between([roleId, Dexie.minKey], [roleId, Dexie.maxKey]).reverse()
  const [items, total] = await Promise.all([collection.offset(offset).limit(limit).toArray(), libraryDb.emojis.where('roleId').equals(roleId).count()])
  const totalBytes = await libraryDb.emojis.where('roleId').equals(roleId).toArray().then(rows => rows.reduce((sum, row) => sum + row.size, 0))
  return { items, total, totalBytes }
}

export async function listRoleEmojiCatalog(roleId: number, maxItems = 5_000) {
  const pageSize = 200
  const catalog: EmojiAsset[] = []
  while (catalog.length < maxItems) {
    const page = await listEmojis(roleId, catalog.length, Math.min(pageSize, maxItems - catalog.length))
    catalog.push(...page.items)
    if (!page.items.length || catalog.length >= page.total) break
  }
  return catalog
}

export async function removeEmoji(item: EmojiAsset) {
  if (item.source === 'native' && item.rawUri) return nativeMedia.remove({ uri: item.rawUri })
  await libraryDb.emojis.delete(item.id)
  return { removed: true }
}

export async function renameEmoji(item: EmojiAsset, name: string) {
  const normalized = name.trim().replace(/[\\/:*?"<>|]/g, '_')
  if (!normalized || normalized === item.name) return { renamed: false }
  if (item.source === 'native' && item.rawUri) return nativeMedia.rename({ uri: item.rawUri, name: normalized })
  await libraryDb.emojis.update(item.id, { name: normalized })
  return { renamed: true }
}

function extensionForMime(mime: string) {
  if (mime === 'image/jpeg') return '.jpg'
  if (mime === 'image/gif') return '.gif'
  if (mime === 'image/webp') return '.webp'
  return '.png'
}

function exportFileName(item: EmojiAsset) {
  return /\.[a-z0-9]{2,5}$/i.test(item.name) ? item.name : `${item.name}${extensionForMime(item.mime)}`
}

export async function exportEmojiPack(roleId: number, roleName: string) {
  const safeName = roleName.replace(/[\\/:*?"<>|]/g, '_')
  if (hasNativeMediaLibrary()) return nativeMedia.exportRolePack({ roleId, name: `${safeName}-表情包.zip` })
  const directoryPicker = (window as typeof window & { showDirectoryPicker?: () => Promise<{ getDirectoryHandle: (name: string, options: { create: boolean }) => Promise<{ getFileHandle: (name: string, options: { create: boolean }) => Promise<{ createWritable: () => Promise<FileSystemWritableFileStream> }> }> }> }).showDirectoryPicker
  if (!directoryPicker) throw new Error('当前浏览器不支持目录导出，请使用最新版 Chrome 或 Edge')
  const root = await directoryPicker()
  const directory = await root.getDirectoryHandle(`${safeName}-表情包`, { create: true })
  let offset = 0
  let exported = 0
  while (true) {
    const rows = await libraryDb.emojis.where('[roleId+createdAt]').between([roleId, Dexie.minKey], [roleId, Dexie.maxKey]).offset(offset).limit(100).toArray()
    if (!rows.length) break
    for (const row of rows) {
      if (!row.blob) continue
      const handle = await directory.getFileHandle(exportFileName(row), { create: true })
      const writable = await handle.createWritable()
      await row.blob.stream().pipeTo(writable)
      exported += 1
    }
    offset += rows.length
  }
  return { exported, saved: true }
}

export function emojiObjectUrl(item: EmojiAsset) {
  if (item.uri) return item.uri
  return item.blob ? URL.createObjectURL(item.blob) : ''
}

export function formatBytes(bytes: number) {
  if (bytes < 1024) return `${bytes} B`
  if (bytes < 1024 ** 2) return `${(bytes / 1024).toFixed(1)} KB`
  if (bytes < 1024 ** 3) return `${(bytes / 1024 ** 2).toFixed(1)} MB`
  return `${(bytes / 1024 ** 3).toFixed(2)} GB`
}

export async function getMemoryArchiveIds(roleId: number): Promise<string[]> {
  const memories = await libraryDb.memories.where('roleId').equals(roleId).toArray()
  return memories.filter(m => m.archived).map(m => m.id)
}

export async function saveMemory(roleId: number, memory: MemoryInput): Promise<StoredMemory> {
  const now = Date.now()
  const id = crypto.randomUUID()
  const storedMemory: StoredMemory = {
    id,
    roleId,
    category: memory.category,
    content: memory.content,
    importance: memory.importance,
    createdAt: now,
    updatedAt: now,
  }
  await libraryDb.memories.put(storedMemory)
  return storedMemory
}

export async function updateMemory(
  id: string,
  updates: Partial<Pick<StoredMemory, 'category' | 'content' | 'importance' | 'archived' | 'lastRoundAccessed'>>,
): Promise<StoredMemory | null> {
  const existing = await libraryDb.memories.get(id)
  if (!existing) return null
  
  const updated: StoredMemory = {
    ...existing,
    ...updates,
    updatedAt: Date.now(),
  }
  await libraryDb.memories.put(updated)
  return updated
}

export async function deleteMemory(id: string): Promise<boolean> {
  const existing = await libraryDb.memories.get(id)
  if (!existing) return false
  await libraryDb.memories.delete(id)
  return true
}

export async function getMemoriesByRole(roleId: number, category?: Memory['category']): Promise<StoredMemory[]> {
  if (category) {
    return libraryDb.memories
      .where('[roleId+category]')
      .equals([roleId, category])
      .toArray()
  }
  return libraryDb.memories
    .where('roleId')
    .equals(roleId)
    .toArray()
}

export async function getImportantMemories(roleId: number, limit = 20): Promise<StoredMemory[]> {
  const all = await libraryDb.memories
    .where('[roleId+importance]')
    .between([roleId, 3], [roleId, 6])
    .toArray()
  return all
    .filter(memory => !memory.archived)
    .sort((a, b) => b.importance - a.importance || b.updatedAt - a.updatedAt)
    .slice(0, limit)
}

export async function searchMemories(roleId: number, query: string): Promise<StoredMemory[]> {
  const lowerQuery = query.toLowerCase()
  const allMemories = await getMemoriesByRole(roleId)
  return allMemories.filter(memory => 
    memory.content.toLowerCase().includes(lowerQuery) ||
    memory.category.toLowerCase().includes(lowerQuery)
  )
}

export async function clearMemoriesByRole(roleId: number): Promise<number> {
  const memories = await getMemoriesByRole(roleId)
  await libraryDb.memories.bulkDelete(memories.map(m => m.id))
  return memories.length
}

export async function getMemoryStats(): Promise<MemoryStats> {
  const memories = await libraryDb.memories.toArray()
  const byRole: MemoryStats['byRole'] = {}
  let archived = 0
  for (const memory of memories) {
    const roleStats = byRole[memory.roleId] ?? { total: 0, archived: 0 }
    roleStats.total += 1
    if (memory.archived) {
      roleStats.archived += 1
      archived += 1
    }
    byRole[memory.roleId] = roleStats
  }
  return { total: memories.length, archived, byRole }
}

export async function inspectMemoryArchive(file: File) {
  validateArchiveFile(file)
  const reader = file.stream().getReader()
  const decoder = new TextDecoder()
  const counts: Record<number, number> = {}
  let buffer = ''
  const consume = (rawLine: string) => {
    const line = rawLine.trim()
    if (!line) return
    validateArchiveLine(line, Object.values(counts).reduce((sum, count) => sum + count, 0))
    const item = JSON.parse(line) as Partial<StoredMemory> & { type?: string }
    if (item.type === 'mchat2-memory-archive') return
    const roleId = Number(item.roleId)
    if (!roleId || !item.content || !item.category) throw new Error('归档中包含无效的长期记忆')
    counts[roleId] = (counts[roleId] ?? 0) + 1
  }
  while (true) {
    const { value, done } = await reader.read()
    if (done) break
    buffer += decoder.decode(value, { stream: true })
    const lines = buffer.split('\n')
    buffer = lines.pop() ?? ''
    for (const line of lines) consume(line)
  }
  buffer += decoder.decode()
  if (buffer.trim()) consume(buffer)
  return counts
}

export async function importMemoryArchive(file: File, onProgress: (p: ImportProgress) => void, selectedRoleIds?: number[]) {
  validateArchiveFile(file)
  const reader = file.stream().getReader()
  const decoder = new TextDecoder()
  const selected = selectedRoleIds?.length ? new Set(selectedRoleIds) : null
  let buffer = ''
  let bytes = 0
  let processed = 0
  let batch: StoredMemory[] = []
  const categories: readonly StoredMemory['category'][] = MEMORY_CATEGORIES

  const consumeLine = async (rawLine: string) => {
    const line = rawLine.trim()
    if (!line) return
    validateArchiveLine(line, processed)
    const item = JSON.parse(line) as Partial<StoredMemory> & { type?: string }
    if (item.type === 'mchat2-memory-archive') return
    if (!item.roleId || !item.content) return
    if (selected && !selected.has(Number(item.roleId))) return
    const category = categories.includes(item.category as StoredMemory['category'])
      ? item.category as StoredMemory['category']
      : 'other'
    const lastRoundAccessed = Number(item.lastRoundAccessed)
    batch.push({
      id: item.id ?? crypto.randomUUID(),
      roleId: Number(item.roleId),
      category,
      content: String(item.content),
      importance: Math.max(1, Math.min(5, Math.round(Number(item.importance ?? 3)))),
      createdAt: Number(item.createdAt ?? Date.now()),
      updatedAt: Number(item.updatedAt ?? Date.now()),
      archived: Boolean(item.archived),
      lastRoundAccessed: Number.isFinite(lastRoundAccessed) ? lastRoundAccessed : undefined,
    })
    processed += 1
    if (batch.length >= 100) {
      await libraryDb.memories.bulkPut(batch)
      batch = []
      onProgress({ processed, total: 0, bytes })
    }
  }

  while (true) {
    const { value, done } = await reader.read()
    if (done) break
    bytes += value.byteLength
    buffer += decoder.decode(value, { stream: true })
    const lines = buffer.split('\n')
    buffer = lines.pop() ?? ''
    for (const line of lines) await consumeLine(line)
  }
  buffer += decoder.decode()
  if (buffer.trim()) await consumeLine(buffer)
  await libraryDb.memories.bulkPut(batch)
  onProgress({ processed, total: processed, bytes })
  return processed
}

export async function exportMemoryArchive(selectedRoleIds?: number[]) {
  const archiveName = `MChat2-长期记忆-${new Date().toISOString().slice(0, 10)}.ndjson`
  const selected = selectedRoleIds?.length ? new Set(selectedRoleIds) : null
  const chunks: BlobPart[] = [JSON.stringify({ type: "mchat2-memory-archive", version: 1 }) + "\n"]
  const allMemories = selected
    ? await Promise.all([...selected].map(async rid => {
        const items = await getMemoriesByRole(rid)
        return items
      })).then(arrays => arrays.flat())
    : await libraryDb.memories.toArray()
  for (const m of allMemories) {
    chunks.push(JSON.stringify(m) + "\n")
  }
  const url = URL.createObjectURL(new Blob(chunks, { type: "application/x-ndjson" }))
  const anchor = document.createElement("a")
  anchor.href = url
  anchor.download = archiveName
  anchor.click()
  setTimeout(() => URL.revokeObjectURL(url), 1000)
}

// ——— 完整备份（对话 + 角色/提示词 + 长期记忆 + 表情包，打进一个 zip，仅原生可用） ———

export type FullBackupResult = {
  processed: number
  memoriesImported: number
  emojis: number
  attachments: number
  roles: Role[]
  orphanRoleIds: number[]
  settings?: unknown
}

async function importUiAssetArchive(file: File, onProgress: (progress: ImportProgress) => void, validateOnly = false) {
  validateArchiveFile(file)
  const reader = file.stream().getReader()
  const decoder = new TextDecoder()
  let buffer = ''
  let processed = 0
  let bytes = 0
  let batch: BackupUiAsset[] = []
  const consume = async (rawLine: string) => {
    const line = rawLine.trim()
    if (!line) return
    validateArchiveLine(line, processed)
    const item = JSON.parse(line) as Partial<BackupUiAsset> & { type?: string; version?: number; data?: unknown }
    if (item.type === 'mchat2-ui-assets') {
      if (item.version !== 1) throw new Error('界面资源归档版本不受支持')
      return
    }
    if (
      typeof item.id !== 'string'
      || !/^[A-Za-z0-9._-]{1,120}$/.test(item.id)
      || typeof item.owner !== 'string'
      || !/^(user:avatar|role:\d+:(avatar|background))$/.test(item.owner)
      || typeof item.data !== 'string'
      || !item.data.startsWith('data:image/')
    ) {
      throw new Error(`第 ${processed + 1} 条界面资源无效`)
    }
    const blob = await fetch(item.data).then(response => response.blob())
    if (blob.size > 16 * 1024 * 1024) throw new Error('单个界面资源超过 16 MB 安全限制')
    batch.push({
      id: item.id,
      owner: item.owner,
      mime: typeof item.mime === 'string' ? item.mime : blob.type || 'image/webp',
      blob,
      createdAt: Number.isFinite(item.createdAt) ? Number(item.createdAt) : Date.now(),
    })
    processed += 1
    if (batch.length >= 50) {
      if (!validateOnly) await restoreUiAssets(batch)
      batch = []
      onProgress({ processed, total: 0, bytes })
    }
  }
  while (true) {
    const { value, done } = await reader.read()
    if (done) break
    bytes += value.byteLength
    buffer += decoder.decode(value, { stream: true })
    const lines = buffer.split('\n')
    buffer = lines.pop() ?? ''
    for (const line of lines) await consume(line)
  }
  buffer += decoder.decode()
  if (buffer.trim()) await consume(buffer)
  if (batch.length && !validateOnly) await restoreUiAssets(batch)
  onProgress({ processed, total: processed, bytes })
}

// 把对话归档（含角色定义）分块写进原生文本导出 token，格式与 exportConversationArchive 一致。
async function writeConversationsToToken(token: string, selectedRoleIds?: number[]) {
  await nativeMedia.appendTextExport({ token, chunk: `${JSON.stringify({ type: 'mchat2-archive', version: 2 })}\n` })
  const roleChunk = buildRoleChunk(selectedRoleIds)
  if (roleChunk) await nativeMedia.appendTextExport({ token, chunk: roleChunk })
  const selected = selectedRoleIds?.length ? new Set(selectedRoleIds) : null
  let offset = 0
  while (true) {
    const rows = await libraryDb.messages.orderBy('createdAt').offset(offset).limit(500).toArray()
    if (!rows.length) break
    const selectedRows = selected ? rows.filter(row => selected.has(row.roleId)) : rows
    if (selectedRows.length) await nativeMedia.appendTextExport({ token, chunk: selectedRows.map(row => JSON.stringify(row)).join('\n') + '\n' })
    offset += rows.length
  }
}

// 把长期记忆归档分块写进原生文本导出 token，格式与 exportMemoryArchive 一致。
async function writeMemoriesToToken(token: string, selectedRoleIds?: number[]) {
  await nativeMedia.appendTextExport({ token, chunk: `${JSON.stringify({ type: 'mchat2-memory-archive', version: 1 })}\n` })
  const selected = selectedRoleIds?.length ? new Set(selectedRoleIds) : null
  const memories = selected
    ? (await Promise.all([...selected].map(rid => getMemoriesByRole(rid)))).flat()
    : await libraryDb.memories.toArray()
  for (let index = 0; index < memories.length; index += 200) {
    await nativeMedia.appendTextExport({ token, chunk: memories.slice(index, index + 200).map(m => JSON.stringify(m)).join('\n') + '\n' })
  }
}

async function blobDataUrl(blob: Blob) {
  return new Promise<string>((resolve, reject) => {
    const reader = new FileReader()
    reader.onload = () => resolve(String(reader.result ?? ''))
    reader.onerror = () => reject(reader.error ?? new Error('无法读取界面资源'))
    reader.readAsDataURL(blob)
  })
}

async function writeUiAssetsToToken(token: string, selectedRoleIds?: number[]) {
  await nativeMedia.appendTextExport({ token, chunk: `${JSON.stringify({ type: 'mchat2-ui-assets', version: 1 })}\n` })
  const assets = await listUiAssetsForBackup(selectedRoleIds)
  for (const asset of assets) {
    await nativeMedia.appendTextExport({
      token,
      chunk: `${JSON.stringify({
        id: asset.id,
        owner: asset.owner,
        mime: asset.mime,
        createdAt: asset.createdAt,
        data: await blobDataUrl(asset.blob),
      })}\n`,
    })
  }
}

export async function exportFullBackup(selectedRoleIds?: number[], settings?: unknown) {
  if (!hasNativeMediaLibrary()) throw new Error('完整备份仅在 App 内可用')
  const backupName = `MChat2-完整备份-${new Date().toISOString().slice(0, 10)}.zip`
  const { token: convToken } = await nativeMedia.beginTextExport({ name: 'conversations.ndjson' })
  await writeConversationsToToken(convToken, selectedRoleIds)
  const { token: memToken } = await nativeMedia.beginTextExport({ name: 'memories.ndjson' })
  await writeMemoriesToToken(memToken, selectedRoleIds)
  const { token: assetToken } = await nativeMedia.beginTextExport({ name: 'assets.ndjson' })
  await writeUiAssetsToToken(assetToken, selectedRoleIds)
  const roleIds = selectedRoleIds?.length ? selectedRoleIds : null
  const selected = roleIds ? new Set(roleIds) : null
  const conversationJobs = (await libraryDb.conversationJobs.toArray())
    .filter(job => !selected || selected.has(job.roleId))
  const manifest = JSON.stringify({
    type: 'mchat2-full-backup',
    version: 2,
    exportedAt: new Date().toISOString(),
    roleCount: roleIds ? roleIds.length : readStoredRoles().length,
    settings,
    conversationJobs,
  })
  return nativeMedia.assembleBackup({ convToken, memToken, assetToken, manifest, roleIds, name: backupName })
}

export async function importFullBackup(onProgress: (progress: ImportProgress) => void): Promise<FullBackupResult | null> {
  if (!hasNativeMediaLibrary()) throw new Error('完整备份仅在 App 内可用')
  const picked = await nativeMedia.pickBackup()
  if (!picked.restored) return null // 用户取消
  const fetchArchive = async (path?: string, name = 'archive.ndjson') => {
    if (!path) return null
    const response = await fetch(Capacitor.convertFileSrc(path))
    if (!response.ok) throw new Error(`无法读取备份中的 ${name}`)
    return new File([await response.blob()], name)
  }
  const conversationsFile = await fetchArchive(picked.conversationsPath, 'conversations.ndjson')
  const memoriesFile = await fetchArchive(picked.memoriesPath, 'memories.ndjson')
  const assetsFile = await fetchArchive(picked.assetsPath, 'assets.ndjson')
  let settings: unknown
  let restoredJobs: ConversationJob[] = []
  if (picked.manifest) {
    const parsed = JSON.parse(picked.manifest) as {
      type?: string
      version?: number
      settings?: unknown
      conversationJobs?: unknown
    }
    if (parsed.type !== 'mchat2-full-backup' || (parsed.version !== 1 && parsed.version !== 2)) throw new Error('备份清单版本不受支持')
    settings = parsed.settings
    if (Array.isArray(parsed.conversationJobs)) {
      restoredJobs = parsed.conversationJobs.flatMap(raw => {
        if (!raw || typeof raw !== 'object') return []
        const job = raw as Partial<ConversationJob>
        const roleId = Number(job.roleId)
        const userMessageIds = Array.isArray(job.userMessageIds)
          ? job.userMessageIds.map(Number).filter(Number.isFinite)
          : []
        if (!Number.isFinite(roleId) || roleId <= 0 || !userMessageIds.length) return []
        const now = Date.now()
        return [{
          roleId,
          state: 'failed' as const,
          userMessageIds,
          createdAt: Number.isFinite(job.createdAt) ? Number(job.createdAt) : now,
          updatedAt: now,
          error: '该回复任务从备份恢复，可点击重试。',
        }]
      })
    }
  }
  if (conversationsFile) await inspectConversationArchive(conversationsFile)
  if (memoriesFile) await inspectMemoryArchive(memoriesFile)
  if (assetsFile) await importUiAssetArchive(assetsFile, () => {}, true)
  // 完整备份统一全量恢复（导出时已按角色筛选过）。
  const { processed, roles, orphanRoleIds } = conversationsFile
    ? await importConversationArchive(conversationsFile, onProgress, undefined, picked.attachmentRootUri)
    : { processed: 0, roles: [] as Role[], orphanRoleIds: [] as number[] }
  const memoriesImported = memoriesFile ? await importMemoryArchive(memoriesFile, onProgress) : 0
  if (assetsFile) await importUiAssetArchive(assetsFile, onProgress)
  if (restoredJobs.length) await libraryDb.conversationJobs.bulkPut(restoredJobs)
  return {
    processed,
    memoriesImported,
    emojis: picked.emojis ?? 0,
    attachments: picked.attachments ?? 0,
    roles,
    orphanRoleIds,
    settings,
  }
}
