import { Capacitor, registerPlugin } from '@capacitor/core'
import type { ChatAttachment } from './chat-types'

type NativeAttachment = Omit<ChatAttachment, 'uri' | 'rawUri'> & { uri: string }

interface DeviceFeaturesPlugin {
  pickAttachment(options: { roleId: number; kind: 'image' | 'file' }): Promise<NativeAttachment | { cancelled: true }>
  readImageDataUrl(options: { uri: string; maxDimension: number; quality: number }): Promise<{ dataUrl: string }>
  startSpeech(): Promise<{ text: string } | { cancelled: true }>
  requestNotifications(): Promise<{ granted: boolean }>
  notify(options: { title: string; body: string; avatarDataUrl?: string }): Promise<void>
  removeRoleFiles(options: { roleId: number }): Promise<void>
}

const deviceFeatures = registerPlugin<DeviceFeaturesPlugin>('DeviceFeatures')

export function hasNativeDeviceFeatures() {
  return Capacitor.isNativePlatform() && Capacitor.isPluginAvailable('DeviceFeatures')
}

export async function pickNativeAttachment(roleId: number, kind: 'image' | 'file') {
  const result = await deviceFeatures.pickAttachment({ roleId, kind })
  if ('cancelled' in result) return null
  return {
    ...result,
    rawUri: result.uri,
    uri: Capacitor.convertFileSrc(result.uri),
  } satisfies ChatAttachment
}

async function imageBlobDataUrl(blob: Blob, maxDimension: number, quality: number) {
  const source = URL.createObjectURL(blob)
  try {
    const image = await new Promise<HTMLImageElement>((resolve, reject) => {
      const element = new Image()
      element.onload = () => resolve(element)
      element.onerror = () => reject(new Error('无法解析图片'))
      element.src = source
    })
    const scale = Math.min(1, maxDimension / Math.max(image.naturalWidth, image.naturalHeight))
    const canvas = document.createElement('canvas')
    canvas.width = Math.max(1, Math.round(image.naturalWidth * scale))
    canvas.height = Math.max(1, Math.round(image.naturalHeight * scale))
    const context = canvas.getContext('2d')
    if (!context) throw new Error('无法处理图片')
    context.drawImage(image, 0, 0, canvas.width, canvas.height)
    return canvas.toDataURL('image/jpeg', quality)
  } finally {
    URL.revokeObjectURL(source)
  }
}

export async function getAttachmentImageDataUrl(attachment: ChatAttachment) {
  if (attachment.kind !== 'image') return ''
  if (hasNativeDeviceFeatures() && attachment.rawUri) {
    return (await deviceFeatures.readImageDataUrl({
      uri: attachment.rawUri,
      maxDimension: 1600,
      quality: 82,
    })).dataUrl
  }
  const blob = attachment.blob ?? (attachment.uri ? await fetch(attachment.uri).then(response => response.blob()) : null)
  if (!blob) throw new Error('无法读取待发送的图片')
  return imageBlobDataUrl(blob, 1600, 0.82)
}

async function notificationAvatarDataUrl(source: string) {
  try {
    if (source.startsWith('data:image/') && !source.startsWith('data:image/svg')) return source
    const blob = await fetch(source).then(response => response.blob())
    return await imageBlobDataUrl(blob, 192, 0.88)
  } catch {
    return undefined
  }
}

export async function startVoiceInput() {
  if (hasNativeDeviceFeatures()) {
    const result = await deviceFeatures.startSpeech()
    return 'cancelled' in result ? '' : result.text
  }
  const SpeechRecognition = (window as typeof window & {
    SpeechRecognition?: new () => {
      lang: string
      interimResults: boolean
      maxAlternatives: number
      start: () => void
      onresult: (event: { results: ArrayLike<{ 0: { transcript: string } }> }) => void
      onerror: () => void
      onend: () => void
    }
    webkitSpeechRecognition?: new () => {
      lang: string
      interimResults: boolean
      maxAlternatives: number
      start: () => void
      onresult: (event: { results: ArrayLike<{ 0: { transcript: string } }> }) => void
      onerror: () => void
      onend: () => void
    }
  }).SpeechRecognition ?? (window as typeof window & { webkitSpeechRecognition?: new () => never }).webkitSpeechRecognition
  if (!SpeechRecognition) throw new Error('当前设备不支持语音识别')
  return new Promise<string>((resolve, reject) => {
    const recognition = new SpeechRecognition()
    let settled = false
    recognition.lang = 'zh-CN'
    recognition.interimResults = false
    recognition.maxAlternatives = 1
    recognition.onresult = event => {
      settled = true
      resolve(event.results[0]?.[0]?.transcript ?? '')
    }
    recognition.onerror = () => {
      settled = true
      reject(new Error('语音识别失败'))
    }
    recognition.onend = () => { if (!settled) resolve('') }
    recognition.start()
  })
}

export async function requestNotificationPermission() {
  if (!hasNativeDeviceFeatures()) return true
  return (await deviceFeatures.requestNotifications()).granted
}

export async function showReplyNotification(title: string, body: string, avatar?: string) {
  if (!hasNativeDeviceFeatures()) return
  await deviceFeatures.notify({ title, body, avatarDataUrl: avatar ? await notificationAvatarDataUrl(avatar) : undefined })
}

export async function removeNativeRoleFiles(roleId: number) {
  if (hasNativeDeviceFeatures()) await deviceFeatures.removeRoleFiles({ roleId })
}
