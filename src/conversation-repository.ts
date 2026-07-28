import Dexie from 'dexie'
import {
  libraryDb,
  messageFromStored,
  type ConversationJob,
  type StoredMessage,
} from './data-library'
import type { Message } from './chat-types'

function roleConversation(roleId: number) {
  return libraryDb.messages
    .where('[roleId+createdAt]')
    .between([roleId, Dexie.minKey], [roleId, Dexie.maxKey])
}

export async function loadConversationPreviews(roleIds: number[]) {
  const pairs = await Promise.all(roleIds.map(async roleId => {
    const latest = await roleConversation(roleId).reverse().first()
    return [roleId, latest ? messageFromStored(latest) : null] as const
  }))
  return Object.fromEntries(pairs) as Record<number, Message | null>
}

export async function loadQueuedMessages(roleId: number) {
  const rows = await libraryDb.messages
    .where('roleId')
    .equals(roleId)
    .filter(row => row.delivery === 'queued' && row.from === 'me')
    .sortBy('createdAt')
  return rows.map(messageFromStored)
}

export async function searchConversationMessages(query: string, roleIds: number[], limit = 200) {
  const normalized = query.trim().toLocaleLowerCase()
  if (!normalized || !roleIds.length) return new Map<number, Message>()
  const selected = new Set(roleIds)
  const matches = new Map<number, StoredMessage>()
  await libraryDb.messages
    .orderBy('createdAt')
    .reverse()
    .filter(row => selected.has(row.roleId) && row.text.toLocaleLowerCase().includes(normalized))
    .each(row => {
      if (matches.size >= limit) return
      if (!matches.has(row.roleId)) matches.set(row.roleId, row)
    })
  return new Map([...matches].map(([roleId, row]) => [roleId, messageFromStored(row)]))
}

export async function getConversationJob(roleId: number) {
  return libraryDb.conversationJobs.get(roleId)
}

export async function saveConversationJob(job: ConversationJob) {
  await libraryDb.conversationJobs.put(job)
}

export async function deleteConversationJob(roleId: number) {
  await libraryDb.conversationJobs.delete(roleId)
}

export async function listConversationJobs() {
  return libraryDb.conversationJobs.toArray()
}
