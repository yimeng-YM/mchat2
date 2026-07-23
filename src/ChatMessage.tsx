import { Check, Pencil } from 'lucide-react'
import { useRef } from 'react'
import { Avatar } from './Avatar'
import { ChatAttachmentView } from './ChatAttachmentView'
import { ChatEmoji } from './ChatEmoji'
import { UserAvatar } from './UserAvatar'
import type { EmojiAsset } from './data-library'
import type { Message, Role } from './chat-types'

export function ChatMessage({ message, role, emoji, userName, userAvatar, onEdit }: {
  message: Message
  role: Role
  emoji?: EmojiAsset
  userName: string
  userAvatar: string
  onEdit: (message: Message) => void
}) {
  const longPressTimer = useRef<number | null>(null)
  const moved = useRef(false)
  const cancelLongPress = () => {
    if (longPressTimer.current !== null) window.clearTimeout(longPressTimer.current)
    longPressTimer.current = null
  }
  const beginLongPress = () => {
    moved.current = false
    cancelLongPress()
    longPressTimer.current = window.setTimeout(() => {
      if (!moved.current) onEdit(message)
      longPressTimer.current = null
    }, 520)
  }

  return <div
    className={`message-row ${message.from} ${message.kind === 'emoji' ? 'emoji-message' : ''}`}
    onPointerDown={beginLongPress}
    onPointerMove={() => { moved.current = true; cancelLongPress() }}
    onPointerUp={cancelLongPress}
    onPointerCancel={cancelLongPress}
    onContextMenu={event => { event.preventDefault(); cancelLongPress(); onEdit(message) }}
  >
    {message.from === 'them' && <Avatar role={role} size="sm" />}
    <div className="bubble-wrap">
      {message.kind === 'emoji'
        ? <ChatEmoji asset={emoji} name={message.text} />
        : message.kind === 'attachment'
          ? <ChatAttachmentView attachment={message.attachment} />
          : <div className="bubble">{message.text}</div>}
      <time>
        {message.delivery === 'queued' ? <b className="delivery-unread">未读</b> : message.time}
        {message.edited && <span>已编辑</span>}
        {message.from === 'me' && message.delivery !== 'queued' && <Check />}
        <Pencil className="edit-hint" />
      </time>
    </div>
    {message.from === 'me' && <UserAvatar name={userName} avatar={userAvatar} size="sm" />}
  </div>
}
