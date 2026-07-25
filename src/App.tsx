import { useEffect, useMemo, useRef, useState, type CSSProperties } from 'react'
import { App as CapacitorApp } from '@capacitor/app'
import type { PluginListenerHandle } from '@capacitor/core'
import {
  Bell, Bot, BrainCircuit, Database, MessageCircle, MessageSquareText, Moon, Palette, Plus, Search, Settings, Sun, X,
} from 'lucide-react'
import { Avatar } from './Avatar'
import { ChatView } from './ChatView'
import { DataSettings } from './DataSettings'
import { DebugOverlay } from './DebugOverlay'
import { clearRoleNotification, requestNotificationPermission } from './device-features'
import { useKeyboardInset } from './keyboard-inset'
import { ModelSettings } from './ModelSettings'
import { QueueSettings } from './QueueSettings'
import { RoleEditorPanel, type EditableRole } from './RoleEditorPanel'
import {
  loadConversation, removeLegacyDefaultData, removeRoleData, replaceConversationGroup,
  saveConversationMessages, updateConversationMessages,
} from './data-library'
import {
  loadAppPreferences, MAX_MEMORY_EXTRACTION_INTERVAL, saveAppPreferences, type AppPreferences,
} from './preferences'
import type { Message, Role } from './chat-types'
import { resetConversationRoundCount } from './memory-service'
import { dispatchNativeBackDismiss } from './native-back'
import { onConversationIncoming } from './conversation-events'
import { runViewTransition } from './view-transitions'
import { UserAvatar } from './UserAvatar'

type Page = 'chat' | 'settings'

function messagePreview(message?: Message) {
  if (!message) return '开始一段新对话'
  if (message.kind === 'emoji') return `[表情] ${message.text}`
  if (message.kind === 'attachment') return message.text
  return message.text
}

function lastMessage(messages?: Message[]) {
  return messages?.[messages.length - 1]
}

function Rail({ page, setPage, dark, setDark, userName, userAvatar }: {
  page: Page
  setPage: (page: Page) => void
  dark: boolean
  setDark: (value: boolean) => void
  userName: string
  userAvatar: string
}) {
  return <aside className="rail">
    <button className="brand" onClick={() => setPage('chat')} aria-label="近聊首页"><MessageCircle /></button>
    <nav>
      <button className={page === 'chat' ? 'active' : ''} onClick={() => setPage('chat')}><MessageCircle /><span>消息</span></button>
      <button className={page === 'settings' ? 'active' : ''} onClick={() => setPage('settings')}><Settings /><span>设置</span></button>
    </nav>
    <div className="rail-bottom">
      <button onClick={() => setDark(!dark)} aria-label="切换主题">{dark ? <Sun /> : <Moon />}</button>
      <UserAvatar name={userName} avatar={userAvatar} size="md" />
    </div>
  </aside>
}

function ConversationList({ roles, messages, selected, onSelect, onCreate, mobileOpen }: {
  roles: Role[]
  messages: Record<number, Message[]>
  selected: number | null
  onSelect: (id: number) => void
  onCreate: () => void
  mobileOpen: boolean
}) {
  const [query, setQuery] = useState('')
  // 会话按最近活跃排序：最后一条消息越新越靠上，收到新消息的角色自然置顶；
  // 尚无消息的角色用其 id（创建时间）作为排序键。消息 id 由 Date.now() 生成，可跨角色比较。
  const recency = (role: Role) => lastMessage(messages[role.id])?.id ?? role.id
  const filtered = roles
    .filter(role => {
      const last = lastMessage(messages[role.id])
      return role.name.includes(query) || messagePreview(last).includes(query)
    })
    .sort((a, b) => recency(b) - recency(a))

  return <section className={`conversations ${mobileOpen ? 'mobile-open' : ''}`}>
    <header className="section-title"><h1>消息</h1><button className="icon-btn accent-soft create-role" onClick={onCreate} aria-label="新建角色"><Plus /></button></header>
    <label className="search"><Search /><input value={query} onChange={event => setQuery(event.target.value)} placeholder="搜索联系人或消息" />{query && <button onClick={() => setQuery('')} aria-label="清空搜索"><X /></button>}</label>
    <div className="conversation-list">
      {filtered.map(role => {
        const last = lastMessage(messages[role.id])
        return <button key={role.id} className={`conversation ${selected === role.id ? 'selected' : ''}`} onClick={() => onSelect(role.id)}>
          <Avatar role={role} />
          <span className="conversation-copy"><strong>{role.name}</strong><small>{messagePreview(last)}</small></span>
          <span className="conversation-meta"><time>{last?.time ?? ''}</time>{role.unread > 0 && <span className="conversation-unread-dot" role="status" aria-label={`${role.unread} 条未读消息`}>{role.unread > 99 ? '99+' : role.unread}</span>}</span>
        </button>
      })}
      {!filtered.length && <div className="empty-small">{roles.length ? '没有找到相关会话' : '点击右上角 + 创建第一个角色'}</div>}
    </div>
  </section>
}

function Toggle({ label, checked, onChange, disabled = false }: {
  label: string
  checked: boolean
  onChange: (checked: boolean) => void
  disabled?: boolean
}) {
  return <button
    className={`toggle ${checked ? 'on' : ''}`}
    onClick={() => onChange(!checked)}
    aria-label={label}
    aria-pressed={checked}
    disabled={disabled}
  ><i /></button>
}

function SettingsPage({ dark, setDark, roles, preferences, setPreferences, onDataChanged }: {
  dark: boolean
  setDark: (value: boolean) => void
  roles: Role[]
  preferences: AppPreferences
  setPreferences: (preferences: AppPreferences) => void
  onDataChanged: () => Promise<void>
}) {
  const [section, setSection] = useState<'appearance' | 'chat' | 'model' | 'notifications' | 'data'>('appearance')
  const [notificationNotice, setNotificationNotice] = useState('')
  const patchPreference = (changes: Partial<AppPreferences>) => setPreferences({ ...preferences, ...changes })
  const chooseSection = (next: typeof section) => setSection(next)
  const memoryIntervalStyle = {
    '--range-progress': `${preferences.memoryExtractionInterval > 0
      ? (preferences.memoryExtractionInterval - 1) / (MAX_MEMORY_EXTRACTION_INTERVAL - 1) * 100
      : 0}%`,
  } as CSSProperties

  const setNotifications = async (enabled: boolean) => {
    setNotificationNotice('')
    if (!enabled) {
      patchPreference({ notificationsEnabled: false })
      return
    }
    const granted = await requestNotificationPermission()
    if (granted) patchPreference({ notificationsEnabled: true })
    else setNotificationNotice('系统未授予通知权限，请在 Android 应用设置中允许通知。')
  }

  return <main className="page settings-page view-surface">
    <header className="page-header"><div><h1>偏好设置</h1><p>把 MChat2 调整成你最舒服的样子。</p></div></header>
    <div className="settings-layout">
      <nav className="settings-nav">
        <button className={section === 'appearance' ? 'active' : ''} onClick={() => chooseSection('appearance')}><Palette />外观</button>
        <button className={section === 'chat' ? 'active' : ''} onClick={() => chooseSection('chat')}><MessageSquareText />聊天体验</button>
        <button className={section === 'model' ? 'active' : ''} onClick={() => chooseSection('model')}><Bot />模型</button>
        <button className={section === 'notifications' ? 'active' : ''} onClick={() => chooseSection('notifications')}><Bell />消息通知</button>
        <button className={section === 'data' ? 'active' : ''} onClick={() => chooseSection('data')}><Database />账户与数据</button>
      </nav>
      <div className="settings-stage">
      {section === 'appearance' && <section className="settings-content">
        <div className="setting-group"><h2>外观</h2><p>选择应用的显示方式。</p>
          <div className="theme-options">
            <button className={!dark ? 'selected' : ''} onClick={() => setDark(false)}><div className="theme-preview light"><i /><span /><span /></div><strong><Sun />浅色</strong></button>
            <button className={dark ? 'selected' : ''} onClick={() => setDark(true)}><div className="theme-preview dark"><i /><span /><span /></div><strong><Moon />深色</strong></button>
          </div>
        </div>
      </section>}
      {section === 'chat' && <section className="settings-content">
        <div className="setting-group"><h2>聊天体验</h2>
          <div className="setting-row"><div><strong>显示“对方正在输入…”</strong><span>模型生成回复时在聊天顶部显示状态</span></div><Toggle label="显示对方正在输入" checked={preferences.typingStatus} onChange={v => setPreferences({...preferences, typingStatus: v})} /></div>
          <div className="setting-row"><div><strong>消息提示音</strong><span>发送和收到消息时播放轻提示音</span></div><Toggle label="消息提示音" checked={preferences.messageSound} onChange={v => setPreferences({...preferences, messageSound: v})} /></div>
          <div className="setting-row memory-interval-row"><div className="setting-copy-with-icon"><BrainCircuit /><span><strong>记忆提取间隔</strong><small>按完整对话轮次自动整理长期记忆，关闭后不再自动提取</small></span></div><div className="setting-inline memory-interval-control"><button className={`toggle ${preferences.memoryExtractionInterval > 0 ? 'on' : ''}`} onClick={() => setPreferences({...preferences, memoryExtractionInterval: preferences.memoryExtractionInterval > 0 ? 0 : 3})} aria-label="启用记忆提取" aria-pressed={preferences.memoryExtractionInterval > 0}><i /></button>{preferences.memoryExtractionInterval > 0 && <label className="setting-slider"><span className="sr-only">记忆提取间隔</span><input className="range-input" style={memoryIntervalStyle} type="range" min="1" max={MAX_MEMORY_EXTRACTION_INTERVAL} step="1" value={preferences.memoryExtractionInterval} onChange={event => setPreferences({...preferences, memoryExtractionInterval: Number(event.target.value)})} /><output>{preferences.memoryExtractionInterval} 轮</output></label>}</div></div>
          <QueueSettings />
        </div>
      </section>}
      {section === 'model' && <section className="settings-content"><ModelSettings /></section>}
      {section === 'notifications' && <section className="settings-content">
        <div className="setting-group"><h2>消息通知</h2>
          <div className="setting-row"><div><strong>允许本地通知</strong><span>应用在后台时，角色回复后发送系统通知</span></div><Toggle label="允许本地通知" checked={preferences.notificationsEnabled} onChange={v => setPreferences({...preferences, notificationsEnabled: v})} /></div>
          <div className="setting-row"><div><strong>显示消息内容</strong><span>关闭后通知只显示“收到一条新消息”</span></div><Toggle label="显示消息内容" checked={preferences.notificationPreview} onChange={v => setPreferences({...preferences, notificationPreview: v})} /></div>
          {notificationNotice && <p className="setting-warning">{notificationNotice}</p>}
        </div>
      </section>}
      {section === 'data' && <section className="settings-content"><DataSettings roles={roles} preferences={preferences} onPreferencesChange={setPreferences} onChanged={onDataChanged} /></section>}
      </div>
    </div>
  </main>
}

function emptyRole(): Role {
  return {
    id: Date.now(),
    name: '新建',
    avatar: '/avatars/default-role.svg',
    signature: '',
    relation: '',
    status: '',
    tags: [],
    unread: 0,
    last: '',
    time: '',
    online: true,
    persona: '',
  }
}

export default function App() {
  const [page, setPage] = useState<Page>('chat')
  const [selectedId, setSelectedId] = useState<number | null>(null)
  const [dark, setDark] = useState(false)
  const [roleEditor, setRoleEditor] = useState(false)
  const [draftRole, setDraftRole] = useState<Role | null>(null)
  const [mobileConversations, setMobileConversations] = useState(() => window.matchMedia('(max-width: 820px)').matches)
  const [messages, setAllMessages] = useState<Record<number, Message[]>>({})
  const [preferences, setPreferences] = useState(loadAppPreferences)
  const [roles, setRoles] = useState<Role[]>(() => {
    try {
      const stored = JSON.parse(localStorage.getItem('mchat2-roles') ?? '[]') as Role[]
      return stored.filter(role => ![1, 2, 3, 4].includes(role.id)).map(role => ({ ...role, unread: Number.isFinite(role.unread) ? role.unread : 0 }))
    } catch {
      return []
    }
  })

  const selectedRole = useMemo(() => roles.find(role => role.id === selectedId) ?? null, [roles, selectedId])
  // 当前正在“对应聊天界面”查看的会话 id；不在该界面时为 null，收到回复即计入未读。
  const activeConversationRef = useRef<number | null>(null)

  useKeyboardInset()

  useEffect(() => {
    void removeLegacyDefaultData().catch(() => {})
  }, [])

  useEffect(() => {
    if (selectedId !== null || !roles.length) return
    setSelectedId(roles[0].id)
  }, [roles, selectedId])

  useEffect(() => {
    let cancelled = false
    const hydratePreviews = async () => {
      const conversations = await Promise.all(roles.map(async role => [role.id, await loadConversation(role.id)] as const))
      if (!cancelled) setAllMessages(previous => ({ ...previous, ...Object.fromEntries(conversations) }))
    }
    void hydratePreviews()
    return () => { cancelled = true }
  }, [roles.map(role => role.id).join(',')])

  useEffect(() => {
    if (selectedId === null) return
    let cancelled = false
    void loadConversation(selectedId).then(stored => {
      if (!cancelled) setAllMessages(previous => ({ ...previous, [selectedId]: stored }))
    })
    return () => { cancelled = true }
  }, [selectedId])

  useEffect(() => { localStorage.setItem('mchat2-roles', JSON.stringify(roles)) }, [roles])
  useEffect(() => { saveAppPreferences(preferences) }, [preferences])

  const reloadSelectedConversation = async () => {
    const conversations = await Promise.all(roles.map(async role => [role.id, await loadConversation(role.id)] as const))
    setAllMessages(previous => ({ ...previous, ...Object.fromEntries(conversations) }))
  }

  const navigate = (next: Page) => {
    // 底部导航顺序：消息(chat) → 设置(settings)。去设置为前进，回消息为返回。
    // 已在目标界面且无待关闭的编辑/草稿、列表显隐也不变时，视为无变化，跳过动画。
    const nextMobileConversations = next === 'chat' ? true : mobileConversations
    if (page === next && !roleEditor && !draftRole && mobileConversations === nextMobileConversations) return
    runViewTransition(() => {
      if (next === 'chat') setMobileConversations(true)
      setPage(next)
      setRoleEditor(false)
      setDraftRole(null)
    }, next === 'settings' ? 'forward' : 'back')
  }

  const updateRole = (changes: EditableRole) => {
    runViewTransition(() => {
      if (draftRole) {
        const created = { ...draftRole, ...changes }
        setRoles(current => [created, ...current])
        setSelectedId(created.id)
        setAllMessages(current => ({ ...current, [created.id]: [] }))
        setDraftRole(null)
        setRoleEditor(false)
        setMobileConversations(false)
        return
      }
      setRoles(current => current.map(role => role.id === changes.id ? { ...role, ...changes } : role))
      setRoleEditor(false)
    })
  }

  const createRole = () => {
    runViewTransition(() => {
      setDraftRole(emptyRole())
      setRoleEditor(true)
    }, 'forward')
  }

  const closeRoleEditor = () => {
    const isCreating = Boolean(draftRole)
    if (draftRole) void removeRoleData(draftRole.id).catch(() => {})
    runViewTransition(() => {
      setDraftRole(null)
      setRoleEditor(false)
      setMobileConversations(isCreating)
    }, 'back')
  }
  // 统一的“返回上一层”逻辑，供硬件返回键与右滑手势共用。
  // 返回 true 表示已消费本次返回；false 表示已到根（可退出应用）。
  const goBack = (): boolean => {
    if (dispatchNativeBackDismiss()) return true

    if (roleEditor) {
      const isCreating = Boolean(draftRole)
      if (draftRole) void removeRoleData(draftRole.id).catch(() => {})
      runViewTransition(() => {
        setDraftRole(null)
        setRoleEditor(false)
        setMobileConversations(isCreating)
      }, 'back')
      return true
    }

    if (page === 'settings') {
      runViewTransition(() => {
        setPage('chat')
        setMobileConversations(true)
      }, 'back')
      return true
    }

    if (!mobileConversations) {
      runViewTransition(() => setMobileConversations(true), 'back')
      return true
    }

    return false
  }

  // 左滑打开当前选中会话（从会话列表进入聊天）。
  const openSelectedChat = (): boolean => {
    if (page !== 'chat' || !mobileConversations || selectedId === null) return false
    runViewTransition(() => {
      setRoles(current => current.map(role => role.id === selectedId && role.unread ? { ...role, unread: 0 } : role))
      setRoleEditor(false)
      setDraftRole(null)
      setMobileConversations(false)
    }, 'forward')
    return true
  }

  const goBackRef = useRef(goBack)
  goBackRef.current = goBack
  const openSelectedChatRef = useRef(openSelectedChat)
  openSelectedChatRef.current = openSelectedChat

  useEffect(() => {
    let listener: PluginListenerHandle | undefined
    let disposed = false

    void CapacitorApp.addListener('backButton', () => {
      if (!goBackRef.current()) void CapacitorApp.exitApp()
    }).then(handle => {
      if (disposed) void handle.remove()
      else listener = handle
    })

    return () => {
      disposed = true
      if (listener) void listener.remove()
    }
  }, [])

  // 左右滑动手势：右滑返回上一层，左滑进入选中会话。仅响应触摸，避免桌面误触。
  useEffect(() => {
    const EDGE_IGNORE = '.settings-nav,.role-filter,.library-tabs,.model-options-popover,.range-input,.avatar-crop-stage,.image-lightbox,input[type=range],.crop-zoom'
    let startX = 0
    let startY = 0
    let pointerId: number | null = null
    let tracking = false

    const onDown = (event: PointerEvent) => {
      if (event.pointerType === 'mouse' || !event.isPrimary) return
      if ((event.target as Element | null)?.closest(EDGE_IGNORE)) return
      startX = event.clientX
      startY = event.clientY
      pointerId = event.pointerId
      tracking = true
    }
    const onUp = (event: PointerEvent) => {
      if (!tracking || event.pointerId !== pointerId) return
      tracking = false
      const dx = event.clientX - startX
      const dy = event.clientY - startY
      // 需为明显的横向滑动：水平位移足够大且明显超过纵向位移。
      if (Math.abs(dx) < 64 || Math.abs(dx) < Math.abs(dy) * 1.4) return
      if (dx > 0) goBackRef.current()
      else openSelectedChatRef.current()
    }
    const onCancel = () => { tracking = false }

    window.addEventListener('pointerdown', onDown, { passive: true })
    window.addEventListener('pointerup', onUp, { passive: true })
    window.addEventListener('pointercancel', onCancel, { passive: true })
    return () => {
      window.removeEventListener('pointerdown', onDown)
      window.removeEventListener('pointerup', onUp)
      window.removeEventListener('pointercancel', onCancel)
    }
  }, [])

  const deleteSelectedRole = async () => {
    if (!selectedRole) return
    await removeRoleData(selectedRole.id)
    resetConversationRoundCount(selectedRole.id)
    const remaining = roles.filter(role => role.id !== selectedRole.id)
    runViewTransition(() => {
      setRoles(remaining)
      setAllMessages(current => {
        const next = { ...current }
        delete next[selectedRole.id]
        return next
      })
      setSelectedId(remaining[0]?.id ?? null)
      setRoleEditor(false)
      if (!remaining.length) setMobileConversations(true)
    })
  }

  const appendSelectedMessages = (newMessages: Message[]) => {
    if (selectedId === null) return
    setAllMessages(previous => ({ ...previous, [selectedId]: [...(previous[selectedId] || []), ...newMessages] }))
    const unreadReplies = newMessages.filter(message => message.from === 'them').length
    // 只要不在“对应聊天界面”（切到列表 / 设置 / 角色编辑 / 应用后台），回复都计入未读。
    if (unreadReplies > 0 && activeConversationRef.current !== selectedId) {
      setRoles(current => current.map(role => role.id === selectedId
        ? { ...role, unread: (role.unread || 0) + unreadReplies }
        : role))
    }
    void saveConversationMessages(selectedId, newMessages)
  }

  // 后台会话事件：AI 回复由 ChatView 广播（即使已卸载），在此并入对应角色的消息状态，
  // 并在“未正在查看该会话”时累计未读——保证切界面 / 切角色 / 后台时都能接收回复。
  useEffect(() => onConversationIncoming(({ roleId, messages: incoming }) => {
    setAllMessages(previous => {
      const current = previous[roleId] || []
      const existing = new Set(current.map(message => message.id))
      const added = incoming.filter(message => !existing.has(message.id))
      if (!added.length) return previous
      return { ...previous, [roleId]: [...current, ...added] }
    })
    const unreadReplies = incoming.filter(message => message.from === 'them').length
    if (unreadReplies > 0 && activeConversationRef.current !== roleId) {
      setRoles(current => current.map(role => role.id === roleId
        ? { ...role, unread: (role.unread || 0) + unreadReplies }
        : role))
    }
  }), [])

  useEffect(() => {
    const syncActiveConversation = () => {
      // 仅当停留在该会话的聊天界面（非列表 / 非设置 / 未开角色编辑 / 前台）才算“正在查看”。
      const viewing = page === 'chat' && !mobileConversations && !roleEditor && !document.hidden
      const activeId = viewing && selectedId !== null ? selectedId : null
      activeConversationRef.current = activeId
      if (activeId === null) return
      setRoles(current => {
        let changed = false
        const next = current.map(role => {
          if (role.id !== activeId || !role.unread) return role
          changed = true
          return { ...role, unread: 0 }
        })
        return changed ? next : current
      })
      void clearRoleNotification(activeId)
    }
    syncActiveConversation()
    document.addEventListener('visibilitychange', syncActiveConversation)
    return () => document.removeEventListener('visibilitychange', syncActiveConversation)
  }, [mobileConversations, page, roleEditor, selectedId])

  const updateSelectedMessages = (changedMessages: Message[]) => {
    if (selectedId === null) return
    const changed = new Map(changedMessages.map(message => [message.id, message]))
    setAllMessages(previous => ({
      ...previous,
      [selectedId]: (previous[selectedId] || []).map(message => changed.get(message.id) ?? message),
    }))
    void updateConversationMessages(selectedId, changedMessages)
  }

  const replaceSelectedGroup = (removedIds: number[], replacement: Message[]) => {
    if (selectedId === null) return
    const removed = new Set(removedIds)
    setAllMessages(previous => {
      const current = previous[selectedId] || []
      const firstIndex = current.findIndex(message => removed.has(message.id))
      const next = current.filter(message => !removed.has(message.id))
      next.splice(Math.max(0, firstIndex), 0, ...replacement)
      return { ...previous, [selectedId]: next }
    })
    void replaceConversationGroup(selectedId, removedIds, replacement)
  }

  const editorRole = draftRole ?? selectedRole
  // 聊天分支始终挂载（切到设置只用 CSS 隐藏），使进行中的回复 / 记忆任务不被卸载打断。
  const appClass = ['app', dark ? 'dark-mode' : '', page === 'chat' && !mobileConversations ? 'chat-open' : '', page === 'settings' ? 'viewing-settings' : ''].filter(Boolean).join(' ')

  return <div className={appClass}>
    <Rail page={page} setPage={navigate} dark={dark} setDark={setDark} userName={preferences.userName} userAvatar={preferences.userAvatar} />
    <>
      <ConversationList
        roles={roles}
        messages={messages}
        selected={selectedId}
        mobileOpen={mobileConversations}
        onCreate={createRole}
        onSelect={id => runViewTransition(() => { setRoles(current => current.map(role => role.id === id && role.unread ? { ...role, unread: 0 } : role)); setSelectedId(id); setRoleEditor(false); setDraftRole(null); setMobileConversations(false) }, 'forward')}
      />
      {selectedRole ? <ChatView
        key={selectedRole.id}
        role={selectedRole}
        messages={messages[selectedRole.id] || []}
        preferences={preferences}
        appendMessages={appendSelectedMessages}
        updateMessages={updateSelectedMessages}
        replaceMessageGroup={replaceSelectedGroup}
        openEditor={() => runViewTransition(() => setRoleEditor(true), 'forward')}
        onBack={() => runViewTransition(() => { setRoleEditor(false); setMobileConversations(true) }, 'back')}
      /> : <main className="chat empty-chat"><div><MessageCircle /><h2>还没有角色</h2><p>创建一个角色，开始你们的第一段对话。</p><button className="primary" onClick={createRole}><Plus />新建角色</button></div></main>}
      {roleEditor && editorRole && <RoleEditorPanel
        role={editorRole}
        isNew={Boolean(draftRole)}
        onClose={closeRoleEditor}
        onSave={updateRole}
        onDelete={draftRole ? undefined : deleteSelectedRole}
      />}
    </>
    {page === 'settings' && <SettingsPage
      dark={dark}
      setDark={setDark}
      roles={roles}
      preferences={preferences}
      setPreferences={setPreferences}
      onDataChanged={reloadSelectedConversation}
    />}
    <DebugOverlay />
  </div>
}

