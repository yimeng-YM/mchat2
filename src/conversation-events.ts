import type { Message } from './chat-types'

// 会话消息事件：ChatView 收到 AI 回复后广播（即使自身即将卸载），
// 由常驻的 App 统一处理未读计数、提示音、系统通知与列表预览刷新。
// 这样切到设置页 / 切换到其它角色 / 应用后台时，回复都能被完整接收。
const INCOMING_EVENT = 'mchat2:conversation-incoming'

export type ConversationIncomingDetail = {
  roleId: number
  roleName: string
  avatar: string
  messages: Message[]
}

export function emitConversationIncoming(detail: ConversationIncomingDetail) {
  window.dispatchEvent(new CustomEvent(INCOMING_EVENT, { detail }))
}

export function onConversationIncoming(handler: (detail: ConversationIncomingDetail) => void) {
  const listener = (event: Event) => handler((event as CustomEvent<ConversationIncomingDetail>).detail)
  window.addEventListener(INCOMING_EVENT, listener)
  return () => window.removeEventListener(INCOMING_EVENT, listener)
}
