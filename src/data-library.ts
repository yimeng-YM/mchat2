import Dexie, { type EntityTable } from 'dexie'
import { Capacitor, registerPlugin } from '@capacitor/core'
import { removeNativeRoleFiles } from './device-features'
import { MEMORY_CATEGORIES } from './chat-types'
import type { ChatAttachment, Message, Memory, MemoryInput } from './chat-types'

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

export type ImportProgress = { processed: number; total: number; bytes?: number }

class Mchat2Database extends Dexie {
  messages!: EntityTable<StoredMessage, 'key'>
  emojis!: EntityTable<EmojiAsset, 'id'>
  meta!: EntityTable<{ key: string; value: string }, 'key'>
  memories!: EntityTable<StoredMemory, 'id'>

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
  }
}

export const libraryDb = new Mchat2Database()

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
  return rows.reverse().map(row => ({
    id: row.messageId,
    from: row.from,
    text: row.text,
    kind: row.kind,
    groupId: row.groupId,
    delivery: row.delivery,
    attachment: row.attachment,
    edited: row.edited,
    time: row.time,
  }))
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
    createdAt: now - (messages.length - index),
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
  await libraryDb.transaction('rw', libraryDb.messages, libraryDb.emojis, libraryDb.memories, async () => {
    await libraryDb.messages.where('roleId').equals(roleId).delete()
    if (!hasNativeMediaLibrary()) await libraryDb.emojis.where('roleId').equals(roleId).delete()
    await libraryDb.memories.where('roleId').equals(roleId).delete()
  })
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

export async function inspectConversationArchive(file: File) {
  const reader = file.stream().getReader()
  const decoder = new TextDecoder()
  const counts: Record<number, number> = {}
  let buffer = ''
  const consume = (rawLine: string) => {
    const line = rawLine.trim()
    if (!line) return
    const item = JSON.parse(line) as Partial<StoredMessage> & { type?: string }
    if (item.type === 'mchat2-archive') return
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

export async function importConversationArchive(file: File, onProgress: (progress: ImportProgress) => void, selectedRoleIds?: number[]) {
  const reader = file.stream().getReader()
  const decoder = new TextDecoder()
  const selected = selectedRoleIds?.length ? new Set(selectedRoleIds) : null
  let buffer = ''
  let bytes = 0
  let processed = 0
  let scanned = 0
  let batch: StoredMessage[] = []

  const consumeLine = async (rawLine: string) => {
    const line = rawLine.trim()
    if (!line) return
    const item = JSON.parse(line) as Partial<StoredMessage> & { type?: string }
    if (item.type === 'mchat2-archive') return
    scanned += 1
    if (!item.roleId || !item.text || (item.from !== 'me' && item.from !== 'them')) throw new Error(`第 ${scanned} 行不是有效的对话记录`)
    if (selected && !selected.has(Number(item.roleId))) return
    const messageId = Number(item.messageId ?? Date.now() + processed)
    batch.push({
      key: `${item.roleId}:${messageId}`,
      roleId: Number(item.roleId),
      messageId,
      from: item.from,
      text: String(item.text),
      kind: item.kind === 'emoji' || item.kind === 'attachment' ? item.kind : undefined,
      groupId: item.groupId,
      delivery: item.delivery,
      attachment: item.attachment,
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
  return processed
}

async function writeArchiveToStream(writer: WritableStreamDefaultWriter<Uint8Array>, selectedRoleIds?: number[]) {
  const encoder = new TextEncoder()
  const selected = selectedRoleIds?.length ? new Set(selectedRoleIds) : null
  await writer.write(encoder.encode(`${JSON.stringify({ type: 'mchat2-archive', version: 1 })}\n`))
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
    await nativeMedia.appendTextExport({ token, chunk: `${JSON.stringify({ type: 'mchat2-archive', version: 1 })}\n` })
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

  const chunks: BlobPart[] = [`${JSON.stringify({ type: 'mchat2-archive', version: 1 })}\n`]
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
  const reader = file.stream().getReader()
  const decoder = new TextDecoder()
  const counts: Record<number, number> = {}
  let buffer = ''
  const consume = (rawLine: string) => {
    const line = rawLine.trim()
    if (!line) return
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
