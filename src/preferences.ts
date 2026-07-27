export type MemoryModelConfig = {
  baseUrl: string
  apiKey: string
  model: string
  temperature: number
}

export type AppPreferences = {
  colorMode: 'light' | 'dark'
  interfaceStyle: 'classic' | 'glass'
  accentColor: string
  myBubbleColor: string
  theirBubbleColor: string
  myBubbleOpacity: number
  theirBubbleOpacity: number
  topBarOpacity: number
  navigationOpacity: number
  inputOpacity: number
  typingStatus: boolean
  messageSound: boolean
  notificationsEnabled: boolean
  notificationPreview: boolean
  memoryExtractionInterval: number // 0 = 禁用, 3 = 每3轮对话提取一次
  userName: string
  userAvatar: string
}

const STORAGE_KEY = 'mchat2-app-preferences'
export const MAX_MEMORY_EXTRACTION_INTERVAL = 20

export const defaultAppPreferences: AppPreferences = {
  colorMode: 'light',
  interfaceStyle: 'glass',
  accentColor: '#6D5DFB',
  myBubbleColor: '#6D5DFB',
  theirBubbleColor: '#FFFFFF',
  myBubbleOpacity: 78,
  theirBubbleOpacity: 78,
  topBarOpacity: 54,
  navigationOpacity: 64,
  inputOpacity: 68,
  typingStatus: true,
  messageSound: false,
  notificationsEnabled: false,
  notificationPreview: true,
  memoryExtractionInterval: 3,
  userName: '你',
  userAvatar: '',
}

export function loadAppPreferences(): AppPreferences {
  try {
    const stored = JSON.parse(localStorage.getItem(STORAGE_KEY) ?? '{}') as Partial<AppPreferences> & {
      bubbleOpacity?: number
    }
    const validColor = (value: unknown, fallback: string) =>
      typeof value === 'string' && /^#[0-9a-f]{6}$/i.test(value) ? value.toUpperCase() : fallback
    const validOpacity = (value: unknown, fallback: number) =>
      Number.isFinite(value) ? Math.max(0, Math.min(100, Math.round(value as number))) : fallback
    const validSurfaceOpacity = (value: unknown, fallback: number) =>
      Number.isFinite(value) ? Math.max(20, Math.min(100, Math.round(value as number))) : fallback
    const legacyBubbleOpacity = validOpacity(stored.bubbleOpacity, defaultAppPreferences.myBubbleOpacity)
    return {
      colorMode: stored.colorMode === 'dark' ? 'dark' : defaultAppPreferences.colorMode,
      interfaceStyle: stored.interfaceStyle === 'classic' ? 'classic' : defaultAppPreferences.interfaceStyle,
      accentColor: validColor(stored.accentColor, defaultAppPreferences.accentColor),
      myBubbleColor: validColor(stored.myBubbleColor, defaultAppPreferences.myBubbleColor),
      theirBubbleColor: validColor(stored.theirBubbleColor, defaultAppPreferences.theirBubbleColor),
      myBubbleOpacity: validOpacity(stored.myBubbleOpacity, legacyBubbleOpacity),
      theirBubbleOpacity: validOpacity(stored.theirBubbleOpacity, legacyBubbleOpacity),
      topBarOpacity: validSurfaceOpacity(stored.topBarOpacity, defaultAppPreferences.topBarOpacity),
      navigationOpacity: validSurfaceOpacity(stored.navigationOpacity, defaultAppPreferences.navigationOpacity),
      inputOpacity: validSurfaceOpacity(stored.inputOpacity, defaultAppPreferences.inputOpacity),
      typingStatus: stored.typingStatus ?? defaultAppPreferences.typingStatus,
      messageSound: stored.messageSound ?? defaultAppPreferences.messageSound,
      notificationsEnabled: stored.notificationsEnabled ?? defaultAppPreferences.notificationsEnabled,
      notificationPreview: stored.notificationPreview ?? defaultAppPreferences.notificationPreview,
      memoryExtractionInterval: Number.isFinite(stored.memoryExtractionInterval)
        ? Math.max(0, Math.min(MAX_MEMORY_EXTRACTION_INTERVAL, Math.round(stored.memoryExtractionInterval!)))
        : defaultAppPreferences.memoryExtractionInterval,
      userName: typeof stored.userName === 'string' && stored.userName.trim()
        ? stored.userName.trim().slice(0, 32)
        : defaultAppPreferences.userName,
      userAvatar: typeof stored.userAvatar === 'string' ? stored.userAvatar : defaultAppPreferences.userAvatar,
    }
  } catch {
    return defaultAppPreferences
  }
}

export function saveAppPreferences(preferences: AppPreferences) {
  localStorage.setItem(STORAGE_KEY, JSON.stringify(preferences))
}

const MEMORY_MODEL_KEY = 'mchat2-memory-model-config'

export const defaultMemoryModelConfig: MemoryModelConfig = {
  baseUrl: '',
  apiKey: '',
  model: '',
  temperature: 0.3,
}

export function loadMemoryModelConfig(): MemoryModelConfig {
  try {
    const stored = JSON.parse(localStorage.getItem(MEMORY_MODEL_KEY) ?? '{}') as Partial<MemoryModelConfig>
    return {
      baseUrl: String(stored.baseUrl ?? ''),
      apiKey: String(stored.apiKey ?? ''),
      model: String(stored.model ?? ''),
      temperature: Number.isFinite(stored.temperature) ? Math.min(2, Math.max(0, stored.temperature as number)) : defaultMemoryModelConfig.temperature,
    }
  } catch {
    return defaultMemoryModelConfig
  }
}

export function saveMemoryModelConfig(config: MemoryModelConfig) {
  localStorage.setItem(MEMORY_MODEL_KEY, JSON.stringify(config))
}

let audioContext: AudioContext | null = null

export function playMessageTone(type: 'sent' | 'received') {
  try {
    audioContext ??= new AudioContext()
    const oscillator = audioContext.createOscillator()
    const gain = audioContext.createGain()
    oscillator.type = 'sine'
    oscillator.frequency.value = type === 'sent' ? 620 : 760
    gain.gain.setValueAtTime(0.0001, audioContext.currentTime)
    gain.gain.exponentialRampToValueAtTime(0.055, audioContext.currentTime + 0.015)
    gain.gain.exponentialRampToValueAtTime(0.0001, audioContext.currentTime + 0.12)
    oscillator.connect(gain)
    gain.connect(audioContext.destination)
    oscillator.start()
    oscillator.stop(audioContext.currentTime + 0.13)
  } catch {
    // Some WebViews disable audio until the first user gesture.
  }
}
