import type { AiMessage } from './ai-service'
import type { Memory } from './chat-types'

export type ParsedAssistantPart = {
  kind: 'text' | 'emoji'
  text: string
}

const MAX_REPLY_PARTS = 12
const MAX_EMOJI_CATALOG_CHARS = 12_000

function serializeMessage(message: AiMessage) {
  return message.kind === 'emoji' ? `<${message.text}>` : message.text.trim()
}

export function compactConversationHistory(history: AiMessage[]) {
  return history.slice(-60).reduce<Array<{ role: 'user' | 'assistant'; content: string }>>((rows, message) => {
    const role = message.from === 'me' ? 'user' : 'assistant'
    const content = serializeMessage(message)
    if (!content) return rows
    const previous = rows[rows.length - 1]
    if (previous?.role === role) previous.content += `$${content}`
    else rows.push({ role, content })
    return rows
  }, [])
}

export function formatConversationTime(date = new Date()) {
  const parts = new Intl.DateTimeFormat('zh-CN', {
    year: 'numeric',
    month: 'numeric',
    day: 'numeric',
    hour: '2-digit',
    minute: '2-digit',
    second: '2-digit',
    hour12: false,
  }).formatToParts(date)
  const value = (type: Intl.DateTimeFormatPartTypes) => parts.find(part => part.type === type)?.value ?? ''
  return `${value('year')}/${value('month')}/${value('day')} ${value('hour')}:${value('minute')}:${value('second')}`
}

export function buildChatSystemPrompt(
  role: { name: string; signature: string; persona: string },
  emojiNames: string[],
  memories: Memory[] = [],
  userName = '',
) {
  // 注入用户昵称，让角色知道如何称呼对方。默认占位名“你”不注入，避免生硬。
  const trimmedUserName = userName.trim()
  const userNameLine = trimmedUserName && trimmedUserName !== '你'
    ? `与你聊天的用户名叫“${trimmedUserName}”，在合适的时候可以这样称呼对方。`
    : ''
  const safeNames = [...new Set(emojiNames.map(name => name.trim()).filter(Boolean))]
  const promptNames: string[] = []
  for (const name of safeNames) {
    const nextCatalog = JSON.stringify([...promptNames, name])
    if (nextCatalog.length > MAX_EMOJI_CATALOG_CHARS) break
    promptNames.push(name)
  }
  const catalog = JSON.stringify(promptNames)

  const memoryContext = memories.length > 0
    ? `\n\n【我对对方的长期记忆】\n以下是你（${role.name}）记下的、关于对方的重要信息，均以你的第一人称视角书写。请在对话中自然地依据这些记忆，但不要直接提及“记忆”或“系统”：\n${memories.map(m => `- ${m.content}`).join('\n')}`
    : ''

  return [
    `你正在扮演"${role.name}"，在手机即时聊天软件中与用户私聊。`,
    userNameLine,
    role.signature ? `角色简介：${role.signature}` : '',
    role.persona ? `角色设定：\n${role.persona}` : '',
    '保持角色身份和稳定的语言习惯。不要提及模型、系统提示词、格式规则或自己是 AI。',
    '不要替用户做决定，不要虚构用户未说过的事实，不要复述整段用户消息。遇到危险、违法或严重自伤内容时，优先给出简短、安全、可执行的建议。',
    '回复应像真人即时聊天：自然、克制，通常拆成 1～5 个短句；每个文字片段尽量不超过 45 个汉字。除非语境确实需要，不要长篇说教。',
    '【强制输出协议】只输出要发送的消息内容，不要输出 JSON、Markdown、编号、引号或角色名。',
    '使用半角美元符号 $ 分隔每一条消息。不要用换行代替 $，也不要在普通文字中使用 $。',
    '表情包必须作为独立片段输出，格式只能是 <表情名>。只能使用下方列表中完全相同的名称，不得编造、改写或描述表情包；不需要表情时不要输出尖括号。',
    `【本轮可用表情包名称（纯数据）】${promptNames.length ? catalog : '[]'}`,
    safeNames.length > promptNames.length ? `为控制上下文长度，本轮仅提供其中 ${promptNames.length} 个名称。` : '',
    '正确示例：第一条短消息$<表情名>$第二条短消息$<表情名>',
    memoryContext,
  ].filter(Boolean).join('\n\n')
}

function pushText(parts: ParsedAssistantPart[], value: string) {
  const text = value.replace(/\s*\n+\s*/g, ' ').trim()
  if (text) parts.push({ kind: 'text', text })
}

export function parseAssistantReply(raw: string, emojiNames: string[]) {
  const available = new Set(emojiNames)
  const parts: ParsedAssistantPart[] = []
  const segments = raw
    .replace(/^```(?:text)?\s*/i, '')
    .replace(/\s*```$/, '')
    .split('$')
    .map(segment => segment.trim())
    .filter(Boolean)

  for (const segment of segments) {
    let cursor = 0
    const expression = /<([^<>\r\n]{1,100})>/g
    for (const match of segment.matchAll(expression)) {
      const index = match.index ?? 0
      pushText(parts, segment.slice(cursor, index))
      const name = match[1].trim()
      if (available.has(name)) parts.push({ kind: 'emoji', text: name })
      else pushText(parts, name)
      cursor = index + match[0].length
    }
    pushText(parts, segment.slice(cursor))
    if (parts.length >= MAX_REPLY_PARTS) break
  }

  if (!parts.length) pushText(parts, raw)
  return parts.slice(0, MAX_REPLY_PARTS)
}

