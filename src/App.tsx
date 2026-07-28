import { useDeferredValue, useEffect, useLayoutEffect, useMemo, useRef, useState, type CSSProperties } from 'react'
import { App as CapacitorApp } from '@capacitor/app'
import type { PluginListenerHandle } from '@capacitor/core'
import {
  Bell, Bot, BrainCircuit, Check, Database, Droplets, Layers, MessageCircle, MessageSquareText, Moon, Palette, Plus,
  RotateCcw, Search, Settings, Sparkles, Sun, X,
} from 'lucide-react'
import { Avatar } from './Avatar'
import { ChatView } from './ChatView'
import { ColorPicker } from './ColorPicker'
import { DataSettings } from './DataSettings'
import { DebugOverlay } from './DebugOverlay'
import {
  checkNotificationPermission,
  clearRoleNotification,
  consumePendingNotificationOpen,
  onNotificationOpened,
  openNativeAppSettings,
  requestNotificationPermission,
} from './device-features'
import { useKeyboardInset } from './keyboard-inset'
import { ModelSettings } from './ModelSettings'
import { QueueSettings } from './QueueSettings'
import { RoleEditorPanel, type EditableRole } from './RoleEditorPanel'
import {
  loadConversation, normalizeArchivedRole, removeLegacyDefaultData, removeRoleData, replaceConversationGroup,
} from './data-library'
import {
  defaultAppPreferences, initializeMemoryModelSecret, loadAppPreferences, MAX_MEMORY_EXTRACTION_INTERVAL, saveAppPreferences, type AppPreferences,
} from './preferences'
import type { Message, Role } from './chat-types'
import { resetConversationRoundCount } from './memory-service'
import { dispatchNativeBackDismiss } from './native-back'
import { onConversationIncoming } from './conversation-events'
import { rangeProgressStyle } from './range-style'
import { runViewTransition } from './view-transitions'
import { UserAvatar } from './UserAvatar'
import { initializeModelSecret } from './ai-service'
import { loadConversationPreviews, searchConversationMessages } from './conversation-repository'
import {
  bootstrapConversationRuntimes,
  clearConversationRuntime,
  configureConversationRuntime,
  refreshConversationRuntimes,
} from './conversation-runtime'
import { migrateRoleUiAssets, persistUiAsset } from './asset-storage'
import { StoredImage } from './StoredImage'

type Page = 'chat' | 'settings'
type FluidPillDirection = 'forward' | 'backward'

const DEFAULT_OUTLINE_HIGHLIGHT_ANGLE = 0
const HANDHELD_PORTRAIT_BETA = 55
const OUTLINE_FRAME_INTERVAL = 1000 / 30

function useFluidPill(activeKey: string, activeIndex: number) {
  const navRef = useRef<HTMLElement | null>(null)
  const previousIndexRef = useRef(activeIndex)
  const [direction, setDirection] = useState<FluidPillDirection>('forward')
  const [pill, setPill] = useState({ x: 0, y: 0, width: 0, height: 0, ready: false })

  useLayoutEffect(() => {
    const previousIndex = previousIndexRef.current
    previousIndexRef.current = activeIndex
    if (activeIndex !== previousIndex) setDirection(activeIndex > previousIndex ? 'forward' : 'backward')
  }, [activeIndex])

  useLayoutEffect(() => {
    const nav = navRef.current
    if (!nav) return

    const measure = () => {
      const active = nav.querySelector<HTMLElement>('[data-fluid-active="true"]')
      if (!active) return
      const navRect = nav.getBoundingClientRect()
      const activeRect = active.getBoundingClientRect()
      const next = {
        x: activeRect.left - navRect.left - nav.clientLeft + nav.scrollLeft,
        y: activeRect.top - navRect.top - nav.clientTop + nav.scrollTop,
        width: activeRect.width,
        height: activeRect.height,
        ready: true,
      }
      setPill(current => (
        Math.abs(current.x - next.x) < 0.5
        && Math.abs(current.y - next.y) < 0.5
        && Math.abs(current.width - next.width) < 0.5
        && Math.abs(current.height - next.height) < 0.5
        && current.ready
          ? current
          : next
      ))
    }

    const frame = window.requestAnimationFrame(measure)
    const resizeObserver = typeof ResizeObserver === 'undefined' ? null : new ResizeObserver(measure)
    resizeObserver?.observe(nav)
    nav.querySelectorAll('button').forEach(button => resizeObserver?.observe(button))
    nav.addEventListener('scroll', measure, { passive: true })
    window.addEventListener('resize', measure)

    return () => {
      window.cancelAnimationFrame(frame)
      resizeObserver?.disconnect()
      nav.removeEventListener('scroll', measure)
      window.removeEventListener('resize', measure)
    }
  }, [activeKey])

  return {
    navRef,
    direction,
    pillStyle: {
      '--fluid-x': `${pill.x}px`,
      '--fluid-y': `${pill.y}px`,
      '--fluid-width': `${pill.width}px`,
      '--fluid-height': `${pill.height}px`,
      opacity: pill.ready ? 1 : 0,
    } as CSSProperties,
  }
}

function useOutlineHighlight(enabled: boolean) {
  const rootRef = useRef<HTMLDivElement | null>(null)

  useEffect(() => {
    const root = rootRef.current
    if (!root || !enabled || window.matchMedia('(prefers-reduced-motion: reduce)').matches) return

    let currentAngle = DEFAULT_OUTLINE_HIGHLIGHT_ANGLE
    let targetAngle = currentAngle
    let paintedAngle = currentAngle
    let animationFrame = 0
    let lastFrameTime = 0
    let sensorPausedUntil = 0
    const finePointer = window.matchMedia('(pointer:fine)').matches
    const angleDelta = (to: number, from: number) => ((to - from + 540) % 360) - 180

    const paint = (angle: number) => {
      const quantized = Math.round(angle * 2) / 2
      if (Math.abs(angleDelta(quantized, paintedAngle)) < 0.45) return
      paintedAngle = quantized
      root.style.setProperty('--outline-highlight-angle', `${quantized.toFixed(1)}deg`)
    }
    const animate = (time: number) => {
      if (document.hidden) {
        animationFrame = 0
        lastFrameTime = 0
        return
      }
      if (lastFrameTime && time - lastFrameTime < OUTLINE_FRAME_INTERVAL) {
        animationFrame = window.requestAnimationFrame(animate)
        return
      }

      const elapsed = lastFrameTime ? Math.min(time - lastFrameTime, 64) : OUTLINE_FRAME_INTERVAL
      lastFrameTime = time
      const delta = angleDelta(targetAngle, currentAngle)
      const smoothing = 1 - Math.pow(0.84, elapsed / (1000 / 60))
      currentAngle = (currentAngle + delta * smoothing + 360) % 360
      paint(currentAngle)

      if (Math.abs(delta) > 0.35) {
        animationFrame = window.requestAnimationFrame(animate)
      } else {
        currentAngle = targetAngle
        paint(currentAngle)
        animationFrame = 0
        lastFrameTime = 0
      }
    }
    const aimHighlight = (angle: number, deadZone: number) => {
      const nextAngle = (angle + 360) % 360
      if (Math.abs(angleDelta(nextAngle, targetAngle)) < deadZone) return
      targetAngle = nextAngle
      if (!animationFrame) animationFrame = window.requestAnimationFrame(animate)
    }
    const followOrientation = (event: DeviceOrientationEvent) => {
      if (performance.now() < sensorPausedUntil) return
      if (event.beta === null || event.gamma === null) return

      // A phone held at roughly 55° in portrait is the neutral pose. This keeps
      // the highlight responsive around a normal one-handed grip instead of
      // treating a phone lying flat on a table as the center point.
      const pitchDelta = Math.max(-70, Math.min(70, event.beta - HANDHELD_PORTRAIT_BETA)) * Math.PI / 180
      const roll = Math.max(-60, Math.min(60, event.gamma)) * Math.PI / 180
      const restingDirection = (DEFAULT_OUTLINE_HIGHLIGHT_ANGLE - 90) * Math.PI / 180
      const restingStrength = 0.32
      const naturalX = Math.cos(restingDirection) * restingStrength - Math.sin(roll) * Math.cos(pitchDelta) * 1.15
      const naturalY = Math.sin(restingDirection) * restingStrength - Math.sin(pitchDelta) * 0.9

      const screenRotation = (window.screen.orientation?.angle ?? 0) * Math.PI / 180
      const screenX = naturalX * Math.cos(screenRotation) + naturalY * Math.sin(screenRotation)
      const screenY = -naturalX * Math.sin(screenRotation) + naturalY * Math.cos(screenRotation)
      aimHighlight(Math.atan2(screenY, screenX) * 180 / Math.PI + 90, 1.25)
    }
    const followPointer = (event: PointerEvent) => {
      if (!finePointer) return
      const bounds = root.getBoundingClientRect()
      const x = event.clientX - bounds.left - bounds.width / 2
      const y = event.clientY - bounds.top - bounds.height / 2
      aimHighlight(Math.atan2(y, x) * 180 / Math.PI + 90, 0.4)
    }
    const pauseSensorHighlight = () => {
      sensorPausedUntil = performance.now() + 160
      targetAngle = currentAngle
      lastFrameTime = 0
      if (animationFrame) {
        window.cancelAnimationFrame(animationFrame)
        animationFrame = 0
      }
    }

    window.addEventListener('deviceorientation', followOrientation, { passive: true })
    window.addEventListener('pointermove', followPointer, { passive: true })
    root.addEventListener('scroll', pauseSensorHighlight, { capture: true, passive: true })
    return () => {
      window.removeEventListener('deviceorientation', followOrientation)
      window.removeEventListener('pointermove', followPointer)
      root.removeEventListener('scroll', pauseSensorHighlight, { capture: true })
      if (animationFrame) window.cancelAnimationFrame(animationFrame)
      root.style.removeProperty('--outline-highlight-angle')
    }
  }, [enabled])

  return rootRef
}

function releaseActiveFocus() {
  const blurActive = () => {
    const active = document.activeElement
    if (active instanceof HTMLElement && active !== document.body) active.blur()
  }
  blurActive()
  window.requestAnimationFrame(blurActive)
}

function messagePreview(message?: Message) {
  if (!message) return '开始一段新对话'
  if (message.kind === 'emoji') return `[表情] ${message.text}`
  if (message.kind === 'attachment') return message.text
  return message.text
}

function lastMessage(messages?: Message[]) {
  return messages?.[messages.length - 1]
}

const accentPresets = ['#6D5DFB', '#248B78', '#2878F0', '#D65C8D', '#E1773D', '#4D5562']

function colorWithOpacity(color: string, opacity: number) {
  const normalized = color.replace('#', '')
  const channels = normalized.match(/.{2}/g)?.map(value => Number.parseInt(value, 16)) ?? [109, 93, 251]
  return `rgba(${channels[0]}, ${channels[1]}, ${channels[2]}, ${Math.max(0, Math.min(100, opacity)) / 100})`
}

function accentInk(color: string) {
  const normalized = color.replace('#', '')
  const channels = normalized.match(/.{2}/g)?.map(value => Number.parseInt(value, 16)) ?? [109, 93, 251]
  const luminance = (channels[0] * 299 + channels[1] * 587 + channels[2] * 114) / 1000
  return luminance > 168 ? '#17201C' : '#FFFFFF'
}

function bubbleInk(color: string, opacity: number, dark: boolean) {
  const normalized = color.replace('#', '')
  const foreground = normalized.match(/.{2}/g)?.map(value => Number.parseInt(value, 16)) ?? [109, 93, 251]
  const backdrop = dark ? [22, 26, 24] : [246, 245, 241]
  const alpha = Math.max(0, Math.min(100, opacity)) / 100
  const composite = foreground.map((channel, index) => channel * alpha + backdrop[index] * (1 - alpha))
  const relativeLuminance = composite.reduce((sum, channel, index) => {
    const linear = channel / 255 <= 0.03928
      ? channel / 255 / 12.92
      : ((channel / 255 + 0.055) / 1.055) ** 2.4
    return sum + linear * [0.2126, 0.7152, 0.0722][index]
  }, 0)
  const darkContrast = (relativeLuminance + 0.05) / 0.064
  const lightContrast = 1.05 / (relativeLuminance + 0.05)
  return darkContrast >= lightContrast ? '#17201C' : '#FFFFFF'
}

function Rail({ page, setPage, dark, setDark, userName, userAvatar }: {
  page: Page
  setPage: (page: Page) => void
  dark: boolean
  setDark: (value: boolean) => void
  userName: string
  userAvatar: string
}) {
  const fluidPill = useFluidPill(page, page === 'chat' ? 0 : 1)

  return <aside className="rail">
    <button className="brand" onClick={() => setPage('chat')} aria-label="近聊首页"><MessageCircle /></button>
    <nav ref={fluidPill.navRef} className="fluid-pill-nav main-fluid-nav">
      <span className="fluid-pill-indicator" data-direction={fluidPill.direction} style={fluidPill.pillStyle} aria-hidden="true">
        <i key={page} />
      </span>
      <button data-fluid-active={page === 'chat'} className={page === 'chat' ? 'active' : ''} onClick={() => setPage('chat')}><MessageCircle /><span>消息</span></button>
      <button data-fluid-active={page === 'settings'} className={page === 'settings' ? 'active' : ''} onClick={() => setPage('settings')}><Settings /><span>设置</span></button>
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
  const deferredQuery = useDeferredValue(query)
  const [searchMatches, setSearchMatches] = useState<Map<number, Message>>(new Map())
  const roleIdsKey = roles.map(role => role.id).join(',')
  const searchableRoleIds = useMemo(
    () => roleIdsKey ? roleIdsKey.split(',').map(Number) : [],
    [roleIdsKey],
  )
  useEffect(() => {
    let cancelled = false
    if (!deferredQuery.trim()) {
      setSearchMatches(new Map())
      return
    }
    void searchConversationMessages(deferredQuery, searchableRoleIds).then(matches => {
      if (!cancelled) setSearchMatches(matches)
    })
    return () => { cancelled = true }
  }, [deferredQuery, searchableRoleIds])
  // 会话按最近活跃排序：最后一条消息越新越靠上，收到新消息的角色自然置顶；
  // 尚无消息的角色用其 id（创建时间）作为排序键。消息 id 由 Date.now() 生成，可跨角色比较。
  const recency = (role: Role) => {
    const latest = lastMessage(messages[role.id])
    return latest?.createdAt ?? latest?.id ?? role.id
  }
  const filtered = roles
    .filter(role => {
      const last = lastMessage(messages[role.id])
      const normalized = query.toLocaleLowerCase()
      return role.name.toLocaleLowerCase().includes(normalized)
        || messagePreview(last).toLocaleLowerCase().includes(normalized)
        || searchMatches.has(role.id)
    })
    .sort((a, b) => recency(b) - recency(a))

  return <section className={`conversations ${mobileOpen ? 'mobile-open' : ''}`}>
    <header className="section-title"><h1>消息</h1><button className="icon-btn accent-soft create-role" onClick={onCreate} aria-label="新建角色"><Plus /></button></header>
    <label className="search"><Search /><input value={query} onChange={event => setQuery(event.target.value)} placeholder="搜索联系人或消息" />{query && <button onClick={() => setQuery('')} aria-label="清空搜索"><X /></button>}</label>
    <div className="conversation-list">
      {filtered.map(role => {
        const last = query.trim() ? searchMatches.get(role.id) ?? lastMessage(messages[role.id]) : lastMessage(messages[role.id])
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

function AppearanceOpacityControl({ label, value, onChange }: {
  label: string
  value: number
  onChange: (value: number) => void
}) {
  return <label className="surface-opacity-control">
    <span>{label}</span>
    <input
      className="range-input"
      style={rangeProgressStyle(value, 20, 100)}
      type="range"
      min="20"
      max="100"
      step="1"
      value={value}
      onChange={event => onChange(Number(event.target.value))}
      aria-label={`${label}透明度`}
    />
    <output>{value}%</output>
  </label>
}

function SettingsPage({ dark, setDark, roles, preferences, setPreferences, onDataChanged, onRolesImported }: {
  dark: boolean
  setDark: (value: boolean) => void
  roles: Role[]
  preferences: AppPreferences
  setPreferences: (preferences: AppPreferences) => void
  onDataChanged: () => Promise<void>
  onRolesImported: (roles: Role[], orphanRoleIds?: number[]) => Promise<number>
}) {
  const [section, setSection] = useState<'appearance' | 'chat' | 'model' | 'notifications' | 'data'>('appearance')
  const [notificationNotice, setNotificationNotice] = useState('')
  const patchPreference = (changes: Partial<AppPreferences>) => setPreferences({ ...preferences, ...changes })
  const chooseSection = (next: typeof section) => setSection(next)
  const sectionOrder: Array<typeof section> = ['appearance', 'chat', 'model', 'notifications', 'data']
  const fluidPill = useFluidPill(section, sectionOrder.indexOf(section))
  const memoryIntervalStyle = rangeProgressStyle(
    preferences.memoryExtractionInterval > 0 ? preferences.memoryExtractionInterval : 1,
    1,
    MAX_MEMORY_EXTRACTION_INTERVAL,
  )
  const setNotifications = async (enabled: boolean) => {
    setNotificationNotice('')
    if (!enabled) {
      patchPreference({ notificationsEnabled: false })
      return
    }
    try {
      const granted = await requestNotificationPermission()
      if (granted) patchPreference({ notificationsEnabled: true })
      else setNotificationNotice('系统未授予通知权限，请在 Android 应用设置中允许通知。')
    } catch (error) {
      patchPreference({ notificationsEnabled: false })
      setNotificationNotice(error instanceof Error ? error.message : '无法申请通知权限')
    }
  }

  return <main className="page settings-page view-surface">
    <header className="page-header"><div><h1>偏好设置</h1><p>把 MChat2 调整成你最舒服的样子。</p></div></header>
    <div className="settings-layout">
      <nav ref={fluidPill.navRef} className="settings-nav fluid-pill-nav settings-fluid-nav">
        <span className="fluid-pill-indicator" data-direction={fluidPill.direction} style={fluidPill.pillStyle} aria-hidden="true">
          <i key={section} />
        </span>
        <button data-fluid-active={section === 'appearance'} className={section === 'appearance' ? 'active' : ''} onClick={() => chooseSection('appearance')}><Palette />外观</button>
        <button data-fluid-active={section === 'chat'} className={section === 'chat' ? 'active' : ''} onClick={() => chooseSection('chat')}><MessageSquareText />聊天体验</button>
        <button data-fluid-active={section === 'model'} className={section === 'model' ? 'active' : ''} onClick={() => chooseSection('model')}><Bot />模型</button>
        <button data-fluid-active={section === 'notifications'} className={section === 'notifications' ? 'active' : ''} onClick={() => chooseSection('notifications')}><Bell />消息通知</button>
        <button data-fluid-active={section === 'data'} className={section === 'data' ? 'active' : ''} onClick={() => chooseSection('data')}><Database />账户与数据</button>
      </nav>
      <div className="settings-stage">
      {section === 'appearance' && <section className="settings-content">
        <div className="setting-group appearance-shell">
          <div className="appearance-heading">
            <span><Sparkles /></span>
            <div><h2>界面风格</h2><p>在熟悉的经典界面和全新的液态玻璃界面之间自由切换。</p></div>
          </div>
          <div className="interface-options">
            <button className={preferences.interfaceStyle === 'glass' ? 'selected' : ''} onClick={() => patchPreference({ interfaceStyle: 'glass' })}>
              <div className="interface-preview glass-preview"><i /><span><b /><b /><b /></span><em /></div>
              <span><strong><Sparkles />液态玻璃</strong><small>通透、轻盈、圆润</small></span>
              {preferences.interfaceStyle === 'glass' && <i className="option-check"><Check /></i>}
            </button>
            <button className={preferences.interfaceStyle === 'classic' ? 'selected' : ''} onClick={() => patchPreference({ interfaceStyle: 'classic' })}>
              <div className="interface-preview classic-preview"><i /><span><b /><b /><b /></span><em /></div>
              <span><strong><Layers />经典界面</strong><small>清晰、紧凑、稳重</small></span>
              {preferences.interfaceStyle === 'classic' && <i className="option-check"><Check /></i>}
            </button>
          </div>
          <div className="surface-opacity-settings">
            <header>
              <Droplets />
              <div><strong>界面透明度</strong><span>同时作用于经典与液态玻璃界面的主要表面，最低保留 20% 以保证可读性。</span></div>
            </header>
            <div>
              <AppearanceOpacityControl label="顶栏" value={preferences.topBarOpacity} onChange={value => patchPreference({ topBarOpacity: value })} />
              <AppearanceOpacityControl label="导航栏" value={preferences.navigationOpacity} onChange={value => patchPreference({ navigationOpacity: value })} />
              <AppearanceOpacityControl label="输入框" value={preferences.inputOpacity} onChange={value => patchPreference({ inputOpacity: value })} />
            </div>
          </div>
        </div>
        <div className="setting-group appearance-colors"><h2>明暗模式</h2><p>选择更适合当前环境的显示方式。</p>
          <div className="theme-options">
            <button className={!dark ? 'selected' : ''} onClick={() => setDark(false)}><div className="theme-preview light"><i /><span /><span /></div><strong><Sun />浅色</strong></button>
            <button className={dark ? 'selected' : ''} onClick={() => setDark(true)}><div className="theme-preview dark"><i /><span /><span /></div><strong><Moon />深色</strong></button>
          </div>
        </div>
        <div className="setting-group appearance-motion"><h2>动态效果</h2><p>单独控制界面转场、液态胶囊和姿态高光。</p>
          <div className="setting-row">
            <div><strong>减少动态效果</strong><span>关闭界面切换与动态高光；系统启用减少动态效果时也会自动遵循</span></div>
            <Toggle label="减少动态效果" checked={preferences.reduceMotion} onChange={value => patchPreference({ reduceMotion: value })} />
          </div>
        </div>
        <div className="setting-group appearance-colors">
          <div className="appearance-section-title"><div><h2>主题色</h2><p>选择预设色，或用取色器创建你的专属主题。</p></div><output>{preferences.accentColor}</output></div>
          <div className="accent-palette">
            {accentPresets.map(color => <button
              key={color}
              className={preferences.accentColor === color ? 'selected' : ''}
              style={{ '--swatch': color } as CSSProperties}
              onClick={() => patchPreference({ accentColor: color })}
              aria-label={`选择主题色 ${color}`}
            >{preferences.accentColor === color && <Check />}</button>)}
            <ColorPicker
              compact
              label="主题色"
              value={preferences.accentColor}
              accentColor={preferences.accentColor}
              dark={dark}
              glass={preferences.interfaceStyle === 'glass'}
              onChange={color => patchPreference({ accentColor: color })}
            />
          </div>
        </div>
        <div className="setting-group bubble-customizer">
          <div className="appearance-section-title"><div><h2>聊天气泡</h2><p>点击预览中的气泡，调整对应一侧的颜色与透明度。</p></div></div>
          <div className="bubble-preview-card">
            <header className="bubble-preview-header">
              <span><MessageCircle />即时预览</span>
              <small>点击气泡进行设置</small>
            </header>
            <div className="bubble-chat-preview" aria-label="聊天气泡样式预览">
              <ColorPicker
                label="对方 / AI 气泡"
                triggerClassName="demo-bubble them"
                triggerAriaLabel="设置对方 / AI 气泡"
                triggerContent="这个配色看起来很舒服。"
                value={preferences.theirBubbleColor}
                opacity={preferences.theirBubbleOpacity}
                accentColor={preferences.accentColor}
                dark={dark}
                glass={preferences.interfaceStyle === 'glass'}
                onChange={(color, opacity) => patchPreference({
                  theirBubbleColor: color,
                  theirBubbleOpacity: opacity ?? preferences.theirBubbleOpacity,
                })}
              />
              <ColorPicker
                label="我的气泡"
                triggerClassName="demo-bubble me"
                triggerAriaLabel="设置我的气泡"
                triggerContent="就用这套吧！"
                value={preferences.myBubbleColor}
                opacity={preferences.myBubbleOpacity}
                accentColor={preferences.accentColor}
                dark={dark}
                glass={preferences.interfaceStyle === 'glass'}
                onChange={(color, opacity) => patchPreference({
                  myBubbleColor: color,
                  myBubbleOpacity: opacity ?? preferences.myBubbleOpacity,
                })}
              />
            </div>
          </div>
          <button className="appearance-reset" onClick={() => {
            patchPreference({
              interfaceStyle: defaultAppPreferences.interfaceStyle,
              accentColor: defaultAppPreferences.accentColor,
              myBubbleColor: defaultAppPreferences.myBubbleColor,
              theirBubbleColor: defaultAppPreferences.theirBubbleColor,
              myBubbleOpacity: defaultAppPreferences.myBubbleOpacity,
              theirBubbleOpacity: defaultAppPreferences.theirBubbleOpacity,
              topBarOpacity: defaultAppPreferences.topBarOpacity,
              navigationOpacity: defaultAppPreferences.navigationOpacity,
              inputOpacity: defaultAppPreferences.inputOpacity,
              reduceMotion: defaultAppPreferences.reduceMotion,
            })
          }}><RotateCcw />恢复默认外观</button>
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
          <div className="setting-row"><div><strong>允许本地通知</strong><span>应用在后台时，角色回复后发送系统通知</span></div><Toggle label="允许本地通知" checked={preferences.notificationsEnabled} onChange={v => void setNotifications(v)} /></div>
          <div className="setting-row"><div><strong>显示消息内容</strong><span>关闭后通知只显示“收到一条新消息”</span></div><Toggle label="显示消息内容" checked={preferences.notificationPreview} disabled={!preferences.notificationsEnabled} onChange={v => setPreferences({...preferences, notificationPreview: v})} /></div>
          {notificationNotice && <p className="setting-warning">{notificationNotice}<button className="secondary compact" type="button" onClick={() => void openNativeAppSettings()}>打开系统设置</button></p>}
        </div>
      </section>}
      {section === 'data' && <section className="settings-content"><DataSettings roles={roles} preferences={preferences} onPreferencesChange={setPreferences} onChanged={onDataChanged} onRolesImported={onRolesImported} /></section>}
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
  const [roleEditor, setRoleEditor] = useState(false)
  const [draftRole, setDraftRole] = useState<Role | null>(null)
  const [mobileConversations, setMobileConversations] = useState(() => window.matchMedia('(max-width: 820px)').matches)
  const [messages, setAllMessages] = useState<Record<number, Message[]>>({})
  const [preferences, setPreferences] = useState(loadAppPreferences)
  const outlineHighlightRef = useOutlineHighlight(preferences.interfaceStyle === 'glass' && !preferences.reduceMotion)
  const [roles, setRoles] = useState<Role[]>(() => {
    try {
      const parsed = JSON.parse(localStorage.getItem('mchat2-roles') ?? '[]') as Role[] | { version?: number; roles?: Role[] }
      const stored = Array.isArray(parsed) ? parsed : Array.isArray(parsed.roles) ? parsed.roles : []
      return stored.filter(role => ![1, 2, 3, 4].includes(role.id)).map(role => ({ ...role, unread: Number.isFinite(role.unread) ? role.unread : 0 }))
    } catch {
      return []
    }
  })
  const roleIdsKey = roles.map(role => role.id).join(',')
  const roleIds = useMemo(() => roleIdsKey ? roleIdsKey.split(',').map(Number) : [], [roleIdsKey])

  const selectedRole = useMemo(() => roles.find(role => role.id === selectedId) ?? null, [roles, selectedId])
  const dark = preferences.colorMode === 'dark'
  const setDark = (value: boolean) => setPreferences(current => ({ ...current, colorMode: value ? 'dark' : 'light' }))
  // 当前正在“对应聊天界面”查看的会话 id；不在该界面时为 null，收到回复即计入未读。
  const activeConversationRef = useRef<number | null>(null)
  const rolesRef = useRef(roles)
  const preferencesRef = useRef(preferences)
  useLayoutEffect(() => { rolesRef.current = roles }, [roles])
  useLayoutEffect(() => { preferencesRef.current = preferences }, [preferences])

  const applyMessageUpdates = (roleId: number, changedMessages: Message[]) => {
    const changed = new Map(changedMessages.map(message => [message.id, message]))
    setAllMessages(previous => ({
      ...previous,
      [roleId]: (previous[roleId] || []).map(message => changed.get(message.id) ?? message),
    }))
  }

  useKeyboardInset()

  useEffect(() => {
    void removeLegacyDefaultData().catch(() => {})
    void Promise.all([initializeModelSecret(), initializeMemoryModelSecret()])
    let disposed = false
    void migrateRoleUiAssets(rolesRef.current).then(async result => {
      if (!disposed && result.changed) setRoles(result.roles)
      const currentAvatar = preferencesRef.current.userAvatar
      if (currentAvatar.startsWith('data:image/')) {
        const userAvatar = await persistUiAsset(currentAvatar, 'user:avatar')
        if (!disposed) setPreferences(current => ({ ...current, userAvatar }))
      }
    }).catch(() => {})
    return () => { disposed = true }
  }, [])

  useEffect(() => {
    if (selectedId !== null || !roles.length) return
    setSelectedId(roles[0].id)
  }, [roles, selectedId])

  useEffect(() => {
    let cancelled = false
    const hydratePreviews = async () => {
      const previews = await loadConversationPreviews(roleIds)
      if (!cancelled) setAllMessages(previous => {
        const next = { ...previous }
        for (const [rawRoleId, preview] of Object.entries(previews)) {
          const roleId = Number(rawRoleId)
          if (!next[roleId]?.length) next[roleId] = preview ? [preview] : []
        }
        return next
      })
    }
    void hydratePreviews()
    return () => { cancelled = true }
  }, [roleIds])

  useEffect(() => {
    if (selectedId === null) return
    let cancelled = false
    void loadConversation(selectedId).then(stored => {
      if (!cancelled) setAllMessages(previous => ({ ...previous, [selectedId]: stored }))
    })
    return () => { cancelled = true }
  }, [selectedId])

  useEffect(() => {
    try {
      localStorage.setItem('mchat2-roles', JSON.stringify({ version: 2, roles }))
    } catch (error) {
      console.error('保存角色索引失败', error)
    }
  }, [roles])
  useEffect(() => { saveAppPreferences(preferences) }, [preferences])

  useEffect(() => {
    configureConversationRuntime({
      getRole: roleId => rolesRef.current.find(role => role.id === roleId) ?? null,
      getPreferences: () => preferencesRef.current,
      onMessagesUpdated: applyMessageUpdates,
    })
    void bootstrapConversationRuntimes(roleIds)
  }, [roleIds])

  useEffect(() => {
    const openRole = (roleId: number) => {
      if (!rolesRef.current.some(role => role.id === roleId)) return
      runViewTransition(() => {
        setPage('chat')
        setSelectedId(roleId)
        setRoleEditor(false)
        setDraftRole(null)
        setMobileConversations(false)
        setRoles(current => current.map(role => role.id === roleId ? { ...role, unread: 0 } : role))
      }, 'forward')
    }
    let listener: PluginListenerHandle | null = null
    let disposed = false
    void onNotificationOpened(openRole).then(handle => {
      if (disposed && handle) void handle.remove()
      else listener = handle
    })
    void consumePendingNotificationOpen().then(roleId => { if (roleId !== null) openRole(roleId) })
    return () => {
      disposed = true
      if (listener) void listener.remove()
    }
  }, [])

  useEffect(() => {
    if (!preferences.notificationsEnabled) return
    let listener: PluginListenerHandle | null = null
    let disposed = false
    void CapacitorApp.addListener('appStateChange', event => {
      if (!event.isActive) return
      void checkNotificationPermission().then(granted => {
        if (!granted) setPreferences(current => ({ ...current, notificationsEnabled: false }))
      })
    }).then(handle => {
      if (disposed) void handle.remove()
      else listener = handle
    })
    return () => {
      disposed = true
      if (listener) void listener.remove()
    }
  }, [preferences.notificationsEnabled])

  const reloadSelectedConversation = async () => {
    const previews = await loadConversationPreviews(roles.map(role => role.id))
    const selected = selectedId === null ? null : await loadConversation(selectedId)
    setAllMessages(previous => ({
      ...previous,
      ...Object.fromEntries(Object.entries(previews).map(([roleId, preview]) => [roleId, preview ? [preview] : []])),
      ...(selectedId !== null && selected ? { [selectedId]: selected } : {}),
    }))
    await refreshConversationRuntimes(roleIds)
  }

  // 导入对话归档时恢复角色：优先用归档自带的角色定义，旧版归档（无角色定义）则按消息里
  // 出现的 roleId 建占位角色兜底。两种都只补齐本机不存在的角色，不覆盖用户已有编辑。
  // 返回实际新增的角色数量，供导入提示显示。
  const restoreImportedRoles = async (imported: Role[], orphanRoleIds: number[] = []): Promise<number> => {
    const migratedImport = await migrateRoleUiAssets(imported)
    const safeImported = migratedImport.roles
    const existing = new Set(roles.map(role => role.id))
    const defined = new Set(safeImported.map(role => role.id))
    // 归档没给定义、本机也没有的 roleId，用默认值建占位角色（名字为“角色 #id”，可后续改名）。
    const placeholders = orphanRoleIds
      .filter(id => !defined.has(id) && !existing.has(id))
      .map(id => normalizeArchivedRole({ id }))
      .filter((role): role is Role => role !== null)
    const missing = [...safeImported.filter(role => !existing.has(role.id)), ...placeholders]
    if (!missing.length) return 0
    setRoles(current => {
      const have = new Set(current.map(role => role.id))
      const toAdd = missing.filter(role => !have.has(role.id))
      return toAdd.length ? [...toAdd, ...current] : current
    })
    return missing.length
  }

  const navigate = (next: Page) => {
    // 底部导航顺序：消息(chat) → 设置(settings)。去设置为前进，回消息为返回。
    // 已在目标界面且无待关闭的编辑/草稿、列表显隐也不变时，视为无变化，跳过动画。
    const nextMobileConversations = next === 'chat' ? true : mobileConversations
    if (page === next && !roleEditor && !draftRole && mobileConversations === nextMobileConversations) return
    const updatePage = () => {
      if (next === 'chat') setMobileConversations(true)
      setPage(next)
      setRoleEditor(false)
      setDraftRole(null)
    }
    runViewTransition(updatePage, next === 'settings' ? 'forward' : 'back')
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
      const returnToChat = () => {
        releaseActiveFocus()
        setPage('chat')
        setMobileConversations(true)
      }
      runViewTransition(returnToChat, 'back')
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
    clearConversationRuntime(selectedRole.id)
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
  const appBackground = selectedRole?.background
  // 聊天分支始终挂载（切到设置只用 CSS 隐藏），使进行中的回复 / 记忆任务不被卸载打断。
  const appClass = [
    'app',
    dark ? 'dark-mode' : '',
    preferences.interfaceStyle === 'glass' ? 'glass-ui' : 'classic-ui',
    preferences.reduceMotion ? 'reduce-motion' : '',
    appBackground?.image ? 'has-app-background' : '',
    page === 'chat' && !mobileConversations ? 'chat-open' : '',
    page === 'settings' ? 'viewing-settings' : '',
  ].filter(Boolean).join(' ')
  const appStyle = {
    '--accent': preferences.accentColor,
    '--accent-ink': accentInk(preferences.accentColor),
    '--accent-2': colorWithOpacity(preferences.accentColor, dark ? 22 : 12),
    '--bubble-me-custom': colorWithOpacity(preferences.myBubbleColor, preferences.myBubbleOpacity),
    '--bubble-them-custom': colorWithOpacity(preferences.theirBubbleColor, preferences.theirBubbleOpacity),
    '--bubble-me-ink': bubbleInk(preferences.myBubbleColor, preferences.myBubbleOpacity, dark),
    '--bubble-them-ink': bubbleInk(preferences.theirBubbleColor, preferences.theirBubbleOpacity, dark),
    '--topbar-surface': colorWithOpacity(dark ? '#313341' : '#FFFFFF', preferences.topBarOpacity),
    '--navigation-surface': colorWithOpacity(dark ? '#1D1F2A' : '#FFFFFF', preferences.navigationOpacity),
    '--input-surface': colorWithOpacity(dark ? '#1D1F2A' : '#FFFFFF', preferences.inputOpacity),
  } as CSSProperties

  return <div ref={outlineHighlightRef} className={appClass} style={appStyle}>
    {appBackground?.image && <div className="app-background" aria-hidden="true">
      <StoredImage
        className="app-background-fill"
        source={appBackground.image}
        alt=""
        style={{ filter: `blur(${Math.max(14, appBackground.blur + 10)}px)` }}
      />
      <StoredImage
        className="app-background-focus"
        source={appBackground.image}
        alt=""
        style={{ filter: `blur(${appBackground.blur}px)` }}
      />
      <i style={{ opacity: appBackground.overlay / 100 }} />
    </div>}
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
      onRolesImported={restoreImportedRoles}
    />}
    <DebugOverlay />
  </div>
}
