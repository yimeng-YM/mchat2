import { loadModelConfig, MODEL_CONFIG_CHANGED_EVENT, requestAiReply } from './ai-service'
import { parseAssistantReply } from './chat-protocol'
import type { Message, Role } from './chat-types'
import {
  listRoleEmojiCatalog,
  loadConversation,
  saveConversationMessages,
  updateConversationMessages,
  type ConversationJob,
} from './data-library'
import {
  deleteConversationJob,
  getConversationJob,
  loadQueuedMessages,
  saveConversationJob,
} from './conversation-repository'
import { emitConversationIncoming } from './conversation-events'
import { showReplyNotification } from './device-features'
import {
  deduplicateAndSaveMemories,
  extractMemoriesFromConversation,
  incrementConversationRound,
  loadRelevantMemories,
  shouldExtractMemory,
  updateMemoryRoundAccess,
} from './memory-service'
import { loadAppPreferences, playMessageTone, type AppPreferences } from './preferences'

export type ConversationRuntimeSnapshot = {
  queuedCount: number
  typing: boolean
  sendError: string
  memoryError: string
}

type Runtime = {
  roleId: number
  queue: Message[]
  queueGroupId: string
  loaded: boolean
  loading: Promise<void> | null
  inFlight: boolean
  flushRequested: boolean
  disposed: boolean
  timer: number | null
  snapshot: ConversationRuntimeSnapshot
  listeners: Set<() => void>
}

type RuntimeContext = {
  getRole: (roleId: number) => Role | null
  getPreferences: () => AppPreferences
  onMessagesUpdated: (roleId: number, messages: Message[]) => void
}

const runtimes = new Map<number, Runtime>()
let context: RuntimeContext = {
  getRole: () => null,
  getPreferences: loadAppPreferences,
  onMessagesUpdated: () => {},
}
let lastMessageId = Date.now() * 1000

if (typeof window !== 'undefined') {
  window.addEventListener(MODEL_CONFIG_CHANGED_EVENT, () => {
    for (const runtime of runtimes.values()) schedule(runtime)
  })
}

function nextMessageId() {
  lastMessageId = Math.max(Date.now() * 1000, lastMessageId + 1)
  return lastMessageId
}

function nextGroupId(prefix: 'user' | 'assistant') {
  return `${prefix}-${Date.now()}-${Math.random().toString(36).slice(2, 7)}`
}

function messageTime(timestamp = Date.now()) {
  return new Date(timestamp).toLocaleTimeString('zh-CN', { hour: '2-digit', minute: '2-digit', hour12: false })
}

function getRuntime(roleId: number) {
  let runtime = runtimes.get(roleId)
  if (runtime) return runtime
  runtime = {
    roleId,
    queue: [],
    queueGroupId: '',
    loaded: false,
    loading: null,
    inFlight: false,
    flushRequested: false,
    disposed: false,
    timer: null,
    snapshot: { queuedCount: 0, typing: false, sendError: '', memoryError: '' },
    listeners: new Set(),
  }
  runtimes.set(roleId, runtime)
  return runtime
}

function publish(runtime: Runtime, changes: Partial<ConversationRuntimeSnapshot>) {
  runtime.snapshot = { ...runtime.snapshot, ...changes }
  for (const listener of runtime.listeners) listener()
}

async function ensureLoaded(runtime: Runtime) {
  if (runtime.loaded) return
  if (runtime.loading) return runtime.loading
  runtime.loading = Promise.all([
    loadQueuedMessages(runtime.roleId),
    getConversationJob(runtime.roleId),
  ]).then(async ([queued, job]) => {
    runtime.queue = queued
    runtime.queueGroupId = queued[queued.length - 1]?.groupId ?? ''
    runtime.loaded = true
    if (job) {
      const interrupted: ConversationJob = {
        ...job,
        state: 'failed',
        updatedAt: Date.now(),
        error: job.state === 'inflight' ? '上次回复被应用退出中断，可点击重试。' : job.error,
      }
      await saveConversationJob(interrupted)
      publish(runtime, {
        queuedCount: queued.length,
        sendError: interrupted.error ?? '上次回复未完成，可点击重试。',
      })
    } else {
      publish(runtime, { queuedCount: queued.length })
    }
  }).finally(() => {
    runtime.loading = null
  })
  return runtime.loading
}

function clearTimer(runtime: Runtime) {
  if (runtime.timer === null) return
  window.clearTimeout(runtime.timer)
  runtime.timer = null
}

function schedule(runtime: Runtime) {
  clearTimer(runtime)
  const config = loadModelConfig()
  if (config.queueMode !== 'auto' || !runtime.queue.length) return
  runtime.timer = window.setTimeout(() => {
    runtime.timer = null
    void flushConversationQueue(runtime.roleId)
  }, Math.max(1, config.queueDelaySeconds) * 1000)
}

async function finishMemoryMaintenance(
  roleId: number,
  role: Role,
  sentHistory: Message[],
  receivedMessages: Message[],
  preferences: AppPreferences,
) {
  const config = loadModelConfig()
  const loadedMemories = await loadRelevantMemories(roleId)
  const roundCount = incrementConversationRound(roleId)
  await updateMemoryRoundAccess(roleId, roundCount, loadedMemories.map(memory => memory.id))
  if (!shouldExtractMemory(roleId, preferences.memoryExtractionInterval)) return
  const recentMessages = sentHistory
    .slice(-config.contextMessageCount)
    .concat(receivedMessages)
    .map(message => ({ from: message.from, text: message.text, kind: message.kind }))
  const output = await extractMemoriesFromConversation(config, role, recentMessages, roleId)
  const { newMemories, memoryAdjustments, archiveIds } = output
  if (newMemories.length || memoryAdjustments.length || archiveIds.length) {
    await deduplicateAndSaveMemories(roleId, newMemories, memoryAdjustments, archiveIds)
  }
}

async function executeReply(runtime: Runtime, sentHistory: Message[], userMessageIds: number[]) {
  const role = context.getRole(runtime.roleId)
  if (!role) {
    publish(runtime, { sendError: '角色已不存在，无法继续回复' })
    return
  }
  const config = loadModelConfig()
  const preferences = context.getPreferences()
  runtime.inFlight = true
  runtime.flushRequested = false
  publish(runtime, { typing: true, sendError: '', memoryError: '' })

  try {
    await saveConversationJob({
      roleId: runtime.roleId,
      state: 'inflight',
      userMessageIds,
      createdAt: Date.now(),
      updatedAt: Date.now(),
    })
    const [catalog, memories] = await Promise.all([
      listRoleEmojiCatalog(runtime.roleId),
      loadRelevantMemories(runtime.roleId),
    ])
    const emojiNames = catalog.map(item => item.name)
    const reply = await requestAiReply(config, role, sentHistory, emojiNames, memories, preferences.userName)
    if (runtime.disposed || !context.getRole(runtime.roleId)) {
      await deleteConversationJob(runtime.roleId)
      return
    }
    const groupId = nextGroupId('assistant')
    const receivedMessages: Message[] = parseAssistantReply(reply, emojiNames).map((part, index) => {
      const createdAt = Date.now() + index
      return {
        id: nextMessageId(),
        createdAt,
        from: 'them',
        text: part.text,
        kind: part.kind,
        groupId,
        delivery: 'read',
        time: messageTime(createdAt),
      }
    })
    for (let index = 0; index < receivedMessages.length; index += 1) {
      if (index > 0) await new Promise(resolve => window.setTimeout(resolve, 1000))
      const message = receivedMessages[index]
      if (runtime.disposed) break
      await saveConversationMessages(runtime.roleId, [message])
      emitConversationIncoming({
        roleId: runtime.roleId,
        roleName: role.name,
        avatar: role.avatar,
        messages: [message],
      })
    }
    await deleteConversationJob(runtime.roleId)
    if (preferences.messageSound) playMessageTone('received')
    if (preferences.notificationsEnabled && document.hidden) {
      const preview = receivedMessages
        .map(message => message.kind === 'emoji' ? `[表情：${message.text}]` : message.text)
        .join(' ')
      void showReplyNotification(
        runtime.roleId,
        role.name,
        preferences.notificationPreview ? preview : '收到一条新消息',
        role.avatar,
      ).catch(() => {})
    }
    void finishMemoryMaintenance(runtime.roleId, role, sentHistory, receivedMessages, preferences)
      .catch(error => publish(runtime, {
        memoryError: error instanceof Error ? error.message : '长期记忆提取失败，请检查记忆模型设置',
      }))
  } catch (error) {
    const message = error instanceof Error ? error.message : '发送失败，请检查模型设置'
    try {
      await saveConversationJob({
        roleId: runtime.roleId,
        state: 'failed',
        userMessageIds,
        createdAt: Date.now(),
        updatedAt: Date.now(),
        error: message,
      })
    } catch {
      // The visible error still needs to clear the in-flight UI even if persistence is unavailable.
    }
    publish(runtime, { sendError: message })
  } finally {
    runtime.inFlight = false
    publish(runtime, { typing: false })
    if (runtime.flushRequested && runtime.queue.length) void flushConversationQueue(runtime.roleId)
    else schedule(runtime)
  }
}

export function configureConversationRuntime(next: RuntimeContext) {
  context = next
}

export function subscribeConversationRuntime(roleId: number, listener: () => void) {
  const runtime = getRuntime(roleId)
  runtime.listeners.add(listener)
  return () => runtime.listeners.delete(listener)
}

export function getConversationRuntimeSnapshot(roleId: number) {
  return getRuntime(roleId).snapshot
}

export async function bootstrapConversationRuntimes(roleIds: number[]) {
  await Promise.all(roleIds.map(async roleId => {
    const runtime = getRuntime(roleId)
    await ensureLoaded(runtime)
    schedule(runtime)
  }))
}

export async function refreshConversationRuntimes(roleIds: number[]) {
  await Promise.all(roleIds.map(async roleId => {
    const runtime = getRuntime(roleId)
    if (runtime.inFlight) return
    clearTimer(runtime)
    runtime.loaded = false
    runtime.queue = []
    runtime.queueGroupId = ''
    await ensureLoaded(runtime)
    schedule(runtime)
  }))
}

export function createQueuedConversationMessage(
  roleId: number,
  message: Omit<Message, 'id' | 'createdAt' | 'from' | 'time' | 'groupId' | 'delivery'>,
) {
  const runtime = getRuntime(roleId)
  runtime.queueGroupId ||= nextGroupId('user')
  const createdAt = Date.now()
  return {
    ...message,
    id: nextMessageId(),
    createdAt,
    from: 'me',
    groupId: runtime.queueGroupId,
    delivery: 'queued',
    time: messageTime(createdAt),
  } satisfies Message
}

export async function enqueueConversationMessage(roleId: number, message: Message) {
  const runtime = getRuntime(roleId)
  await ensureLoaded(runtime)
  await saveConversationMessages(roleId, [message])
  if (!runtime.queue.some(item => item.id === message.id)) runtime.queue.push(message)
  publish(runtime, { queuedCount: runtime.queue.length, sendError: '' })
  schedule(runtime)
}

export async function replaceQueuedConversationMessages(roleId: number, removedIds: number[], replacement: Message[]) {
  const runtime = getRuntime(roleId)
  await ensureLoaded(runtime)
  const removed = new Set(removedIds)
  const stillQueued = replacement.filter(message => message.delivery === 'queued')
  runtime.queue = runtime.queue.flatMap(message => {
    if (!removed.has(message.id)) return [message]
    return message.id === removedIds[0] ? stillQueued : []
  })
  runtime.queueGroupId = runtime.queue[runtime.queue.length - 1]?.groupId ?? ''
  publish(runtime, { queuedCount: runtime.queue.length })
  schedule(runtime)
}

export async function flushConversationQueue(roleId: number) {
  const runtime = getRuntime(roleId)
  await ensureLoaded(runtime)
  clearTimer(runtime)
  if (runtime.inFlight) {
    runtime.flushRequested = true
    return
  }
  if (!runtime.queue.length) return
  const queued = [...runtime.queue]
  const sent = queued.map(message => ({ ...message, delivery: 'sent' as const }))
  try {
    await updateConversationMessages(roleId, sent)
  } catch (error) {
    publish(runtime, {
      sendError: error instanceof Error ? error.message : '发送队列保存失败，请重试。',
    })
    schedule(runtime)
    return
  }
  const sentIds = new Set(sent.map(message => message.id))
  runtime.queue = runtime.queue.filter(message => !sentIds.has(message.id))
  runtime.queueGroupId = runtime.queue[runtime.queue.length - 1]?.groupId ?? ''
  context.onMessagesUpdated(roleId, sent)
  publish(runtime, { queuedCount: runtime.queue.length })
  let history: Message[]
  try {
    history = await loadConversation(roleId)
  } catch (error) {
    const message = error instanceof Error ? error.message : '读取会话失败，请重试。'
    try {
      await saveConversationJob({
        roleId,
        state: 'failed',
        userMessageIds: sent.map(item => item.id),
        createdAt: Date.now(),
        updatedAt: Date.now(),
        error: message,
      })
    } catch {
      // Keep the user-facing error available even if IndexedDB is unavailable.
    }
    publish(runtime, { sendError: message })
    return
  }
  await executeReply(runtime, history, sent.map(message => message.id))
}

export async function requestConversationReply(roleId: number, history: Message[], userMessageIds: number[]) {
  const runtime = getRuntime(roleId)
  await ensureLoaded(runtime)
  if (runtime.inFlight) throw new Error('对方正在回复，请稍候再试。')
  await executeReply(runtime, history, userMessageIds)
}

export async function retryConversationReply(roleId: number) {
  const runtime = getRuntime(roleId)
  await ensureLoaded(runtime)
  if (runtime.inFlight) return
  const job = await getConversationJob(roleId)
  if (!job) {
    publish(runtime, { sendError: '' })
    return
  }
  const history = await loadConversation(roleId)
  await executeReply(runtime, history, job.userMessageIds)
}

export function clearConversationRuntime(roleId: number) {
  const runtime = runtimes.get(roleId)
  if (runtime) {
    runtime.disposed = true
    clearTimer(runtime)
  }
  runtimes.delete(roleId)
}
