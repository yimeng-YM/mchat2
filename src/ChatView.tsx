import { Fragment, useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState, useSyncExternalStore } from 'react'
import { AlertCircle, ArrowLeft, Bug, Ellipsis, Image as ImageIcon, Mic, Send } from 'lucide-react'
import { Avatar } from './Avatar'
import { ChatMessage } from './ChatMessage'
import { MessageGroupEditor } from './MessageGroupEditor'
import { loadModelConfig, MODEL_CONFIG_CHANGED_EVENT } from './ai-service'
import { parseAssistantReply } from './chat-protocol'
import { toggleDebugLogging } from './debug-log'
import { hasNativeDeviceFeatures, pickNativeImage, startVoiceInput } from './device-features'
import { listRoleEmojiCatalog, type EmojiAsset } from './data-library'
import {
  createQueuedConversationMessage,
  enqueueConversationMessage,
  flushConversationQueue,
  getConversationRuntimeSnapshot,
  replaceQueuedConversationMessages,
  requestConversationReply,
  retryConversationReply,
  subscribeConversationRuntime,
} from './conversation-runtime'
import { playMessageTone, type AppPreferences } from './preferences'
import type { ChatAttachment, Message, Role } from './chat-types'
import { StoredImage } from './StoredImage'

// 隐藏调试模式暗号：在任意对话输入框输入后开启/关闭网络请求记录。
const DEBUG_TOGGLE_CODE = '/上上下下左右左右baba'

let lastMessageId = Date.now() * 1000

function nextMessageId() {
  lastMessageId = Math.max(Date.now() * 1000, lastMessageId + 1)
  return lastMessageId
}

function messageTime() {
  return new Date().toLocaleTimeString('zh-CN', { hour: '2-digit', minute: '2-digit', hour12: false })
}

function startOfDay(timestamp: number) {
  const date = new Date(timestamp)
  date.setHours(0, 0, 0, 0)
  return date.getTime()
}

// 返回该消息之上应显示的日期分隔文案；与上一条同一天则返回空串（不显示）。
// 首条消息（无上一条）总会显示分隔。文案：今天 / 昨天 / 具体日期。
function dateDividerLabel(currentId: number, previousId?: number): string {
  const current = startOfDay(currentId)
  if (previousId !== undefined && startOfDay(previousId) === current) return ''
  const today = startOfDay(Date.now())
  const dayMs = 86_400_000
  if (current === today) return '今天'
  if (current === today - dayMs) return '昨天'
  const date = new Date(current)
  const sameYear = date.getFullYear() === new Date().getFullYear()
  return date.toLocaleDateString('zh-CN', sameYear
    ? { month: 'long', day: 'numeric' }
    : { year: 'numeric', month: 'long', day: 'numeric' })
}

function nextGroupId(prefix: 'user' | 'assistant') {
  return `${prefix}-${Date.now()}-${Math.random().toString(36).slice(2, 7)}`
}

export function ChatView({ role, messages, preferences, appendMessages, replaceMessageGroup, openEditor, onBack }: {
  role: Role
  messages: Message[]
  preferences: AppPreferences
  appendMessages: (messages: Message[]) => void
  replaceMessageGroup: (removedIds: number[], messages: Message[]) => void
  openEditor: () => void
  onBack: () => void
}) {
  // 模型配置需可刷新：ChatView 切到设置时只是隐藏而非卸载，保存设置后要即时生效。
  const [config, setConfig] = useState(loadModelConfig)
  const [draft, setDraft] = useState('')
  const [inputError, setInputError] = useState('')
  const [debugNotice, setDebugNotice] = useState('')
  const debugNoticeTimerRef = useRef<number | null>(null)
  const [emojiCatalog, setEmojiCatalog] = useState<EmojiAsset[]>([])
  const [editingGroup, setEditingGroup] = useState<Message[] | null>(null)
  const [listening, setListening] = useState(false)
  const messagesContainerRef = useRef<HTMLDivElement>(null)
  const chatContainerRef = useRef<HTMLElement>(null)
  const chatHeaderRef = useRef<HTMLElement>(null)
  const composerWrapRef = useRef<HTMLDivElement>(null)
  const textareaRef = useRef<HTMLTextAreaElement>(null)
  const imageInputRef = useRef<HTMLInputElement>(null)
  const mountedRef = useRef(true)
  const messagesRef = useRef(messages)
  const stickToBottomRef = useRef(true)

  const emojiMap = useMemo(() => new Map(emojiCatalog.map(item => [item.name, item])), [emojiCatalog])
  const subscribeRuntime = useCallback((listener: () => void) => subscribeConversationRuntime(role.id, listener), [role.id])
  const runtimeSnapshot = useCallback(() => getConversationRuntimeSnapshot(role.id), [role.id])
  const runtime = useSyncExternalStore(subscribeRuntime, runtimeSnapshot, runtimeSnapshot)
  const { typing, queuedCount, memoryError } = runtime
  const sendError = inputError || runtime.sendError

  useEffect(() => {
    messagesRef.current = messages
  }, [messages])

  // 设置页保存模型配置后重新读取，避免常驻的 ChatView 继续使用过期配置。
  useEffect(() => {
    const reload = () => setConfig(loadModelConfig())
    window.addEventListener(MODEL_CONFIG_CHANGED_EVENT, reload)
    return () => window.removeEventListener(MODEL_CONFIG_CHANGED_EVENT, reload)
  }, [])

  useEffect(() => {
    let cancelled = false
    void listRoleEmojiCatalog(role.id).then(items => {
      if (!cancelled) setEmojiCatalog(items)
    }).catch(() => { if (!cancelled) setEmojiCatalog([]) })
    return () => { cancelled = true }
  }, [role.id])

  const scrollToBottom = () => {
    const container = messagesContainerRef.current
    if (container) container.scrollTop = container.scrollHeight
  }

  useLayoutEffect(() => {
    const chat = chatContainerRef.current
    const header = chatHeaderRef.current
    const composer = composerWrapRef.current
    if (!chat || !header || !composer) return

    const measureChrome = () => {
      chat.style.setProperty('--chat-header-height', `${header.offsetHeight}px`)
      chat.style.setProperty('--chat-composer-height', `${composer.offsetHeight}px`)
    }
    measureChrome()
    const resizeObserver = typeof ResizeObserver === 'undefined' ? null : new ResizeObserver(measureChrome)
    resizeObserver?.observe(header)
    resizeObserver?.observe(composer)
    window.addEventListener('resize', measureChrome)
    return () => {
      resizeObserver?.disconnect()
      window.removeEventListener('resize', measureChrome)
    }
  }, [])

  useLayoutEffect(() => {
    if (!messagesContainerRef.current) return
    // 新消息或输入状态变化时视为回到底部，其后加载的图片/表情随之跟随。
    stickToBottomRef.current = true
    scrollToBottom()
    const frame = requestAnimationFrame(scrollToBottom)
    return () => cancelAnimationFrame(frame)
  }, [messages.length, typing])

  // 图片、表情等异步加载完成后才撑开高度，需在其加载完成时再次下滑。
  // 同时记录用户是否停留在底部，向上翻看历史时不强制拽回底部。
  useEffect(() => {
    const container = messagesContainerRef.current
    if (!container) return
    const onScroll = () => {
      stickToBottomRef.current = container.scrollHeight - container.scrollTop - container.clientHeight < 60
    }
    // <img> 的 load 事件不冒泡，用捕获阶段监听容器内所有图片/表情的加载完成。
    const onLoad = (event: Event) => {
      if ((event.target as HTMLElement | null)?.tagName === 'IMG' && stickToBottomRef.current) scrollToBottom()
    }
    container.addEventListener('scroll', onScroll, { passive: true })
    container.addEventListener('load', onLoad, true)
    return () => {
      container.removeEventListener('scroll', onScroll)
      container.removeEventListener('load', onLoad, true)
    }
  }, [])

  // 键盘弹出使可视视口变化时，保持最新消息与输入框可见。
  useEffect(() => {
    const viewport = window.visualViewport
    if (!viewport) return
    const keepBottomVisible = () => {
      if (stickToBottomRef.current) requestAnimationFrame(scrollToBottom)
    }
    viewport.addEventListener('resize', keepBottomVisible)
    return () => viewport.removeEventListener('resize', keepBottomVisible)
  }, [])

  useEffect(() => {
    mountedRef.current = true
    return () => {
      mountedRef.current = false
      if (debugNoticeTimerRef.current !== null) window.clearTimeout(debugNoticeTimerRef.current)
    }
  }, [])

  const enqueueMessage = (message: Omit<Message, 'id' | 'from' | 'time' | 'groupId' | 'delivery'>) => {
    const sentMessage = createQueuedConversationMessage(role.id, message)
    messagesRef.current = [...messagesRef.current, sentMessage]
    appendMessages([sentMessage])
    setInputError('')
    void enqueueConversationMessage(role.id, sentMessage).catch(error => {
      setInputError(error instanceof Error ? error.message : '消息排队失败')
    })
    if (preferences.messageSound) playMessageTone('sent')
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
      text: `[图片：${attachment.name}]`,
      kind: 'attachment',
      attachment,
    })
    requestAnimationFrame(() => textareaRef.current?.focus())
  }

  const pickImage = async () => {
    try {
      if (hasNativeDeviceFeatures()) {
        const attachment = await pickNativeImage(role.id)
        if (attachment) enqueueAttachment(attachment)
      } else {
        imageInputRef.current?.click()
      }
    } catch (error) {
      setInputError(error instanceof Error ? error.message : '无法读取所选图片')
    }
  }

  const handleWebImage = (file: File | undefined) => {
    if (!file) return
    enqueueAttachment({
      id: `web-${Date.now()}-${Math.random().toString(36).slice(2)}`,
      kind: 'image',
      name: file.name,
      mime: file.type || 'image/jpeg',
      size: file.size,
      blob: file,
    })
    if (imageInputRef.current) imageInputRef.current.value = ''
  }

  const beginVoiceInput = async () => {
    setListening(true)
    setInputError('')
    try {
      const text = await startVoiceInput()
      if (text) setDraft(current => current ? `${current}${current.endsWith(' ') ? '' : ' '}${text}` : text)
    } catch (error) {
      setInputError(error instanceof Error ? error.message : '语音输入失败')
    } finally {
      setListening(false)
      requestAnimationFrame(() => textareaRef.current?.focus())
    }
  }

  const openGroupEditor = (message: Message) => {
    // 取该消息所在的、同一发送方的连续整段消息，用户消息与 AI 消息表现一致：
    // 长按任意一条即把整段（含队列中未发送的消息）一起放入编辑。
    const history = messagesRef.current
    const anchor = history.findIndex(item => item.id === message.id)
    if (anchor < 0) {
      setEditingGroup([message])
      return
    }
    let start = anchor
    let end = anchor
    while (start > 0 && history[start - 1].from === message.from) start -= 1
    while (end < history.length - 1 && history[end + 1].from === message.from) end += 1
    setEditingGroup(history.slice(start, end + 1))
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
    const replacement: Message[] = parts.map(part => {
      const createdAt = Date.now()
      return {
        id: nextMessageId(),
        createdAt,
        from,
        text: part.text,
        kind: part.kind,
        groupId,
        delivery: from === 'me' ? (remainsQueued ? 'queued' : 'sent') : 'read',
        edited: true,
        time: messageTime(),
      }
    })
    const removed = new Set(editingGroup.map(message => message.id))
    messagesRef.current = messagesRef.current.flatMap(message => {
      if (!removed.has(message.id)) return [message]
      return message.id === editingGroup[0].id ? replacement : []
    })
    if (remainsQueued) void replaceQueuedConversationMessages(role.id, [...removed], replacement)
    replaceMessageGroup([...removed], replacement)
    setEditingGroup(null)
  }

  // 从用户编辑的这组消息重新开始对话：替换该组内容为已发送状态，
  // 删除其后的所有消息（含对方回复），随后重新请求一次回复。
  const saveAndResendGroup = (value: string) => {
    if (!editingGroup?.length) return
    if (runtime.typing) {
      setEditingGroup(null)
      setInputError('对方正在回复，请稍候再试。')
      return
    }
    const emojiNames = emojiCatalog.map(item => item.name)
    const groupId = nextGroupId('user')
    const replacement: Message[] = value.split('$').map(part => part.trim()).filter(Boolean).map(text => {
      const match = /^<([^<>]+)>$/.exec(text)
      const isEmoji = match && emojiNames.includes(match[1].trim())
      const createdAt = Date.now()
      return {
        id: nextMessageId(),
        createdAt,
        from: 'me' as const,
        text: isEmoji ? match![1].trim() : text,
        kind: isEmoji ? 'emoji' as const : 'text' as const,
        groupId,
        delivery: 'sent' as const,
        edited: true,
        time: messageTime(),
      }
    })
    if (!replacement.length) return

    const history = messagesRef.current
    const firstIndex = history.findIndex(item => item.id === editingGroup[0].id)
    const keep = firstIndex >= 0 ? history.slice(0, firstIndex) : history
    const removedIds = (firstIndex >= 0 ? history.slice(firstIndex) : []).map(item => item.id)
    const nextHistory = [...keep, ...replacement]

    messagesRef.current = nextHistory
    replaceMessageGroup(removedIds, replacement)
    void replaceQueuedConversationMessages(role.id, removedIds, [])
    setEditingGroup(null)
    if (preferences.messageSound) playMessageTone('sent')
    void requestConversationReply(role.id, nextHistory, replacement.map(message => message.id)).catch(error => {
      setInputError(error instanceof Error ? error.message : '重新发送失败')
    })
  }

  const maybeToggleDebug = (text: string) => {
    if (text.trim() !== DEBUG_TOGGLE_CODE) return false
    const enabled = toggleDebugLogging()
    setDraft('')
    if (debugNoticeTimerRef.current !== null) window.clearTimeout(debugNoticeTimerRef.current)
    setDebugNotice(enabled ? '调试模式已开启，开始记录网络请求。' : '调试模式已关闭，记录已清空。')
    debugNoticeTimerRef.current = window.setTimeout(() => {
      if (mountedRef.current) setDebugNotice('')
      debugNoticeTimerRef.current = null
    }, 2600)
    requestAnimationFrame(() => textareaRef.current?.focus())
    return true
  }

  const sendDisabled = config.queueMode === 'auto'
    ? !draft.trim()
    : !draft.trim() && queuedCount === 0
  const background = role.background

  return <main ref={chatContainerRef} className={`chat ${background?.image ? 'has-chat-background' : ''}`}>
    {background?.image && <div className="chat-background" aria-hidden="true">
      <StoredImage source={background.image} alt="" style={{ filter: `blur(${background.blur}px)`, transform: `scale(${1.04 + background.blur / 100})` }} />
      <i style={{ opacity: background.overlay / 100 }} />
    </div>}
    <header ref={chatHeaderRef} className="chat-header">
      <button className="mobile-back" onClick={onBack} aria-label="打开会话列表"><ArrowLeft /></button>
      <Avatar role={role} size="sm" />
      <button className="chat-person" onClick={openEditor}>
        <strong>{role.name}</strong>
        {typing && preferences.typingStatus && <span className="typing-status">对方正在输入…</span>}
      </button>
      <div className="chat-actions"><button className="icon-btn accent-soft role-menu-button" onClick={openEditor} aria-label="编辑当前角色"><Ellipsis /></button></div>
    </header>
    <div className="messages" ref={messagesContainerRef}>
      {messages.map((message, index) => {
        // 消息 id 由 Date.now() 生成，据此按自然日分隔。日期变化时插入分隔条。
        const divider = dateDividerLabel(message.createdAt ?? message.id, messages[index - 1] ? (messages[index - 1].createdAt ?? messages[index - 1].id) : undefined)
        return <Fragment key={message.id}>
          {divider && <div className="date-divider"><span>{divider}</span></div>}
          <ChatMessage
            message={message}
            role={role}
            emoji={message.kind === 'emoji' ? emojiMap.get(message.text) : undefined}
            userName={preferences.userName}
            userAvatar={preferences.userAvatar}
            onEdit={openGroupEditor}
          />
        </Fragment>
      })}
      {!messages.length && <div className="empty-conversation"><MessageEmptyIcon /><strong>开始聊天</strong><span>你们的消息会保存在这台设备上</span></div>}
    </div>
    <div ref={composerWrapRef} className="composer-wrap">
      <div className="composer-tools">
        <button onPointerDown={event => event.preventDefault()} onClick={() => void pickImage()} aria-label="发送图片"><ImageIcon /></button>
        <input ref={imageInputRef} hidden type="file" accept="image/*" onChange={event => handleWebImage(event.target.files?.[0])} />
      </div>
      {sendError && <div className="send-error"><AlertCircle /><span>{sendError}</span>{runtime.sendError && <button type="button" onClick={() => void retryConversationReply(role.id)}>重试</button>}</div>}
      {memoryError && <div className="send-error memory-error"><AlertCircle />{memoryError}</div>}
      {debugNotice && <div className="send-error debug-notice"><Bug />{debugNotice}</div>}
      <div className="composer">
        <textarea
          ref={textareaRef}
          rows={1}
          value={draft}
          onChange={event => { if (!maybeToggleDebug(event.target.value)) setDraft(event.target.value) }}
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
          onClick={() => {
            if (config.queueMode === 'manual' && !draft.trim() && queuedCount > 0) void flushConversationQueue(role.id)
            else enqueueDraft()
          }}
          disabled={sendDisabled}
          aria-label={config.queueMode === 'manual' && !draft.trim() && queuedCount > 0 ? `提交 ${queuedCount} 条消息` : config.queueMode === 'manual' ? '加入消息队列' : '发送消息'}
        ><Send /></button>
      </div>
    </div>
    {editingGroup && <MessageGroupEditor
      messages={editingGroup}
      onCancel={() => setEditingGroup(null)}
      onSave={saveEditedGroup}
      onSaveAndSend={saveAndResendGroup}
    />}
  </main>
}

function MessageEmptyIcon() {
  return <div className="empty-conversation-icon"><Send /></div>
}
