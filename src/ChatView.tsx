import { useEffect, useLayoutEffect, useMemo, useRef, useState } from 'react'
import { AlertCircle, ArrowLeft, Ellipsis, Image as ImageIcon, Mic, Paperclip, Send } from 'lucide-react'
import { Avatar } from './Avatar'
import { ChatMessage } from './ChatMessage'
import { MessageGroupEditor } from './MessageGroupEditor'
import { loadModelConfig, requestAiReply } from './ai-service'
import { parseAssistantReply } from './chat-protocol'
import { hasNativeDeviceFeatures, pickNativeAttachment, showReplyNotification, startVoiceInput } from './device-features'
import { listRoleEmojiCatalog, type EmojiAsset, type StoredMemory } from './data-library'
import {
  loadRelevantMemories,
  extractMemoriesFromConversation,
  deduplicateAndSaveMemories,
  incrementConversationRound,
  shouldExtractMemory,
} from './memory-service'
import { playMessageTone, type AppPreferences } from './preferences'
import type { ChatAttachment, Message, Role } from './chat-types'

let lastMessageId = Date.now()

function nextMessageId() {
  lastMessageId = Math.max(Date.now(), lastMessageId + 1)
  return lastMessageId
}

function messageTime() {
  return new Date().toLocaleTimeString('zh-CN', { hour: '2-digit', minute: '2-digit', hour12: false })
}

function nextGroupId(prefix: 'user' | 'assistant') {
  return `${prefix}-${Date.now()}-${Math.random().toString(36).slice(2, 7)}`
}

export function ChatView({ role, messages, preferences, appendMessages, updateMessages, replaceMessageGroup, openEditor, onBack }: {
  role: Role
  messages: Message[]
  preferences: AppPreferences
  appendMessages: (messages: Message[]) => void
  updateMessages: (messages: Message[]) => void
  replaceMessageGroup: (removedIds: number[], messages: Message[]) => void
  openEditor: () => void
  onBack: () => void
}) {
  const config = useMemo(loadModelConfig, [])
  const [draft, setDraft] = useState('')
  const [typing, setTyping] = useState(false)
  const [sendError, setSendError] = useState('')
  const [queuedCount, setQueuedCount] = useState(0)
  const [emojiCatalog, setEmojiCatalog] = useState<EmojiAsset[]>([])
  const [memories, setMemories] = useState<StoredMemory[]>([])
  const memoriesRef = useRef(memories)
  const [editingGroup, setEditingGroup] = useState<Message[] | null>(null)
  const [listening, setListening] = useState(false)
  const messagesContainerRef = useRef<HTMLDivElement>(null)
  const textareaRef = useRef<HTMLTextAreaElement>(null)
  const imageInputRef = useRef<HTMLInputElement>(null)
  const fileInputRef = useRef<HTMLInputElement>(null)
  const mountedRef = useRef(true)
  const messagesRef = useRef(messages)
  const queueRef = useRef<Message[]>([])
  const queueGroupRef = useRef('')
  const requestInFlightRef = useRef(false)
  const flushRequestedRef = useRef(false)
  const autoTimerRef = useRef<number | null>(null)

  const emojiMap = useMemo(() => new Map(emojiCatalog.map(item => [item.name, item])), [emojiCatalog])

  useEffect(() => {
    messagesRef.current = messages
  }, [messages])

  useEffect(() => {
    let cancelled = false
    void listRoleEmojiCatalog(role.id).then(items => {
      if (!cancelled) setEmojiCatalog(items)
    }).catch(() => { if (!cancelled) setEmojiCatalog([]) })
    return () => { cancelled = true }
  }, [role.id])

  useLayoutEffect(() => {
    const container = messagesContainerRef.current
    if (!container) return
    container.scrollTop = container.scrollHeight
    const frame = requestAnimationFrame(() => { container.scrollTop = container.scrollHeight })
    return () => cancelAnimationFrame(frame)
  }, [messages.length, typing])

  useEffect(() => {
    mountedRef.current = true
    return () => {
      mountedRef.current = false
      if (autoTimerRef.current !== null) window.clearTimeout(autoTimerRef.current)
    }
  }, [])

  useEffect(() => {
    memoriesRef.current = memories
  }, [memories])

  useEffect(() => {
    let cancelled = false
    void loadRelevantMemories(role.id).then(items => {
      if (!cancelled) {
        setMemories(items)
        memoriesRef.current = items
      }
    })
    return () => { cancelled = true }
  }, [role.id])


  const clearAutoTimer = () => {
    if (autoTimerRef.current !== null) {
      window.clearTimeout(autoTimerRef.current)
      autoTimerRef.current = null
    }
  }

  const flushQueue = async () => {
    clearAutoTimer()
    if (requestInFlightRef.current) {
      flushRequestedRef.current = true
      return
    }
    const queued = queueRef.current
    if (!queued.length) return

    queueRef.current = []
    queueGroupRef.current = ''
    setQueuedCount(0)
    const queuedIds = new Set(queued.map(message => message.id))
    const sentHistory = messagesRef.current.map(message => queuedIds.has(message.id) ? { ...message, delivery: 'sent' as const } : message)
    messagesRef.current = sentHistory
    updateMessages(sentHistory.filter(message => queuedIds.has(message.id)))
    requestInFlightRef.current = true
    flushRequestedRef.current = false
    setTyping(true)
    setSendError('')

    try {
      const [catalog, loadedMemories] = await Promise.all([
        listRoleEmojiCatalog(role.id),
        loadRelevantMemories(role.id),
      ])
      if (!mountedRef.current) return
      setEmojiCatalog(catalog)
      setMemories(loadedMemories)
      memoriesRef.current = loadedMemories
      const emojiNames = catalog.map(item => item.name)
      const reply = await requestAiReply(config, role, sentHistory, emojiNames, loadedMemories)
      if (!mountedRef.current) return
      const groupId = nextGroupId('assistant')
      const receivedMessages: Message[] = parseAssistantReply(reply, emojiNames).map(part => ({
        id: nextMessageId(),
        from: 'them',
        text: part.text,
        kind: part.kind,
        groupId,
        delivery: 'read',
        time: messageTime(),
      }))
      for (let index = 0; index < receivedMessages.length; index += 1) {
        if (index > 0) await new Promise(resolve => window.setTimeout(resolve, 520))
        if (!mountedRef.current) return
        const message = receivedMessages[index]
        messagesRef.current = [...messagesRef.current, message]
        appendMessages([message])
      }
      if (preferences.messageSound) playMessageTone('received')
      if (preferences.notificationsEnabled && document.hidden) {
        const preview = receivedMessages.map(message => message.kind === 'emoji' ? `[表情：${message.text}]` : message.text).join(' ')
        void showReplyNotification(role.name, preferences.notificationPreview ? preview : '收到一条新消息', role.avatar)
      }

      // 记忆提取
      const roundCount = incrementConversationRound(role.id)
      if (shouldExtractMemory(role.id, preferences.memoryExtractionInterval)) {
        // 提取记忆（不阻塞消息展示）
        const recentMessages = sentHistory.slice(-10).concat(receivedMessages).map(message => ({
          from: message.from,
          text: message.text,
          kind: message.kind,
        }))
        void extractMemoriesFromConversation(config, role, recentMessages, role.id).then(async (output) => {
          if (!mountedRef.current) return
          const { newMemories, memoryAdjustments, archiveIds } = output
          if (!newMemories.length && !memoryAdjustments.length && !archiveIds.length) return
          const saved = await deduplicateAndSaveMemories(role.id, newMemories, memoryAdjustments, archiveIds)
          if (saved > 0) {
            const updated = await loadRelevantMemories(role.id)
            if (mountedRef.current) {
              setMemories(updated)
              memoriesRef.current = updated
            }
          }
        })
      }
    } catch (error) {
      if (mountedRef.current) setSendError(error instanceof Error ? error.message : '发送失败，请检查模型设置')
    } finally {
      requestInFlightRef.current = false
      if (mountedRef.current) setTyping(false)
      if (mountedRef.current && flushRequestedRef.current && queueRef.current.length) void flushQueue()
    }
  }

  const scheduleAutoFlush = () => {
    clearAutoTimer()
    const delay = Math.max(1, config.queueDelaySeconds)
    autoTimerRef.current = window.setTimeout(() => { void flushQueue() }, delay * 1000)
  }

  const enqueueMessage = (message: Omit<Message, 'id' | 'from' | 'time' | 'groupId' | 'delivery'>) => {
    queueGroupRef.current ||= nextGroupId('user')
    const sentMessage: Message = {
      ...message,
      id: nextMessageId(),
      from: 'me',
      groupId: queueGroupRef.current,
      delivery: 'queued',
      time: messageTime(),
    }
    queueRef.current = [...queueRef.current, sentMessage]
    messagesRef.current = [...messagesRef.current, sentMessage]
    setQueuedCount(queueRef.current.length)
    appendMessages([sentMessage])
    setSendError('')
    if (preferences.messageSound) playMessageTone('sent')
    if (config.queueMode === 'auto') scheduleAutoFlush()
  }

  const enqueueDraft = () => {
    const text = draft.trim()
    if (!text) return
    enqueueMessage({ text, kind: 'text' })
    setDraft('')
    requestAnimationFrame(() => textareaRef.current?.focus())
  }

  const enqueueAttachment = (attachment: ChatAttachment) => {
    enqueueMessage({
      text: attachment.kind === 'image' ? `[图片：${attachment.name}]` : `[文件：${attachment.name}]`,
      kind: 'attachment',
      attachment,
    })
    requestAnimationFrame(() => textareaRef.current?.focus())
  }

  const pickAttachment = async (kind: 'image' | 'file') => {
    try {
      if (hasNativeDeviceFeatures()) {
        const attachment = await pickNativeAttachment(role.id, kind)
        if (attachment) enqueueAttachment(attachment)
      } else {
        (kind === 'image' ? imageInputRef : fileInputRef).current?.click()
      }
    } catch (error) {
      setSendError(error instanceof Error ? error.message : '无法读取所选文件')
    }
  }

  const useWebAttachment = (file: File | undefined, kind: 'image' | 'file') => {
    if (!file) return
    enqueueAttachment({
      id: `web-${Date.now()}-${Math.random().toString(36).slice(2)}`,
      kind,
      name: file.name,
      mime: file.type || 'application/octet-stream',
      size: file.size,
      blob: file,
    })
    if (kind === 'image' && imageInputRef.current) imageInputRef.current.value = ''
    if (kind === 'file' && fileInputRef.current) fileInputRef.current.value = ''
  }

  const beginVoiceInput = async () => {
    setListening(true)
    setSendError('')
    try {
      const text = await startVoiceInput()
      if (text) setDraft(current => current ? `${current}${current.endsWith(' ') ? '' : ' '}${text}` : text)
    } catch (error) {
      setSendError(error instanceof Error ? error.message : '语音输入失败')
    } finally {
      setListening(false)
      requestAnimationFrame(() => textareaRef.current?.focus())
    }
  }

  const openGroupEditor = (message: Message) => {
    const group = message.groupId
      ? messagesRef.current.filter(item => item.groupId === message.groupId)
      : [message]
    setEditingGroup(group)
  }

  const saveEditedGroup = (value: string) => {
    if (!editingGroup?.length) return
    const from = editingGroup[0].from
    const remainsQueued = editingGroup.some(message => message.delivery === 'queued')
    const groupId = editingGroup[0].groupId || nextGroupId(from === 'me' ? 'user' : 'assistant')
    const emojiNames = emojiCatalog.map(item => item.name)
    const parts = from === 'them'
      ? parseAssistantReply(value, emojiNames)
      : value.split('$').map(part => part.trim()).filter(Boolean).map(text => {
        const match = /^<([^<>]+)>$/.exec(text)
        return match && emojiNames.includes(match[1].trim())
          ? { kind: 'emoji' as const, text: match[1].trim() }
          : { kind: 'text' as const, text }
      })
    const replacement: Message[] = parts.map(part => ({
      id: nextMessageId(),
      from,
      text: part.text,
      kind: part.kind,
      groupId,
      delivery: from === 'me' ? (remainsQueued ? 'queued' : 'sent') : 'read',
      edited: true,
      time: messageTime(),
    }))
    const removed = new Set(editingGroup.map(message => message.id))
    messagesRef.current = messagesRef.current.flatMap(message => {
      if (!removed.has(message.id)) return [message]
      return message.id === editingGroup[0].id ? replacement : []
    })
    if (remainsQueued) {
      queueRef.current = queueRef.current.flatMap(message => {
        if (!removed.has(message.id)) return [message]
        return message.id === editingGroup[0].id ? replacement : []
      })
      setQueuedCount(queueRef.current.length)
    }
    replaceMessageGroup([...removed], replacement)
    setEditingGroup(null)
  }

  const sendDisabled = config.queueMode === 'auto'
    ? !draft.trim()
    : !draft.trim() && queuedCount === 0
  const background = role.background

  return <main className={`chat ${background?.image ? 'has-chat-background' : ''}`}>
    {background?.image && <div className="chat-background" aria-hidden="true">
      <img src={background.image} alt="" style={{ filter: `blur(${background.blur}px)`, transform: `scale(${1.04 + background.blur / 100})` }} />
      <i style={{ opacity: background.overlay / 100 }} />
    </div>}
    <header className="chat-header">
      <button className="mobile-back" onClick={onBack} aria-label="打开会话列表"><ArrowLeft /></button>
      <Avatar role={role} size="sm" />
      <button className="chat-person" onClick={openEditor}>
        <strong>{role.name}</strong>
        {typing && preferences.typingStatus && <span className="typing-status">对方正在输入…</span>}
      </button>
      <div className="chat-actions"><button className="icon-btn accent-soft role-menu-button" onClick={openEditor} aria-label="编辑当前角色"><Ellipsis /></button></div>
    </header>
    <div className="messages" ref={messagesContainerRef}>
      {messages.length > 0 && <div className="date-divider"><span>今天</span></div>}
      {messages.map(message => <ChatMessage
        key={message.id}
        message={message}
        role={role}
        emoji={message.kind === 'emoji' ? emojiMap.get(message.text) : undefined}
        onEdit={openGroupEditor}
      />)}
      {!messages.length && <div className="empty-conversation"><MessageEmptyIcon /><strong>开始聊天</strong><span>你们的消息会保存在这台设备上</span></div>}
    </div>
    <div className="composer-wrap">
      <div className="composer-tools">
        <button onPointerDown={event => event.preventDefault()} onClick={() => void pickAttachment('image')} aria-label="发送图片"><ImageIcon /></button>
        <button onPointerDown={event => event.preventDefault()} onClick={() => void pickAttachment('file')} aria-label="发送文件"><Paperclip /></button>
        <input ref={imageInputRef} hidden type="file" accept="image/*" onChange={event => useWebAttachment(event.target.files?.[0], 'image')} />
        <input ref={fileInputRef} hidden type="file" onChange={event => useWebAttachment(event.target.files?.[0], 'file')} />
      </div>
      {sendError && <div className="send-error"><AlertCircle />{sendError}</div>}
      <div className="composer">
        <textarea
          ref={textareaRef}
          rows={1}
          value={draft}
          onChange={event => setDraft(event.target.value)}
          onKeyDown={event => {
            if (event.key === 'Enter' && !event.shiftKey) {
              event.preventDefault()
              enqueueDraft()
            }
          }}
          placeholder={`发消息给 ${role.name}…`}
        />
        <button className={`voice ${listening ? 'listening' : ''}`} onPointerDown={event => event.preventDefault()} onClick={() => void beginVoiceInput()} aria-label="语音输入"><Mic /></button>
        <button
          className={`send ${queuedCount ? 'has-queue' : ''}`}
          onPointerDown={event => event.preventDefault()}
          onClick={enqueueDraft}
          onDoubleClick={() => { if (config.queueMode === 'manual') void flushQueue() }}
          disabled={sendDisabled}
          aria-label={config.queueMode === 'manual' ? '加入消息队列，双击提交' : '发送消息'}
        ><Send /></button>
      </div>
    </div>
    {editingGroup && <MessageGroupEditor messages={editingGroup} onCancel={() => setEditingGroup(null)} onSave={saveEditedGroup} />}
  </main>
}

function MessageEmptyIcon() {
  return <div className="empty-conversation-icon"><Send /></div>
}
