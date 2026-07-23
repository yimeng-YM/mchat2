import { Save, X } from 'lucide-react'
import { useMemo, useState } from 'react'
import type { Message } from './chat-types'
import { useNativeBackDismiss } from './native-back'
import { OverlayPortal } from './OverlayPortal'
import { runViewTransition } from './view-transitions'

function editableText(messages: Message[]) {
  return messages.map(message => {
    if (message.kind === 'emoji') return `<${message.text}>`
    if (message.kind === 'attachment') return message.text
    return message.text
  }).join('$')
}

export function MessageGroupEditor({ messages, onCancel, onSave }: {
  messages: Message[]
  onCancel: () => void
  onSave: (value: string) => void
}) {
  const initial = useMemo(() => editableText(messages), [messages])
  const [value, setValue] = useState(initial)
  useNativeBackDismiss(true, onCancel)

  return <OverlayPortal><div className="modal-overlay" role="presentation" onPointerDown={event => {
    if (event.target === event.currentTarget) runViewTransition(onCancel)
  }}>
    <section className="message-editor-dialog" role="dialog" aria-modal="true" aria-labelledby="message-editor-title">
      <header>
        <div><h2 id="message-editor-title">编辑整组消息</h2><p>使用 $ 分隔多条消息，表情包使用 &lt;名称&gt;</p></div>
        <button className="icon-btn" onClick={() => runViewTransition(onCancel)} aria-label="关闭"><X /></button>
      </header>
      <textarea autoFocus rows={9} value={value} onChange={event => setValue(event.target.value)} />
      <footer>
        <button className="secondary" onClick={() => runViewTransition(onCancel)}>取消</button>
        <button className="primary" onClick={() => runViewTransition(() => onSave(value))} disabled={!value.trim()}><Save />保存</button>
      </footer>
    </section>
  </div></OverlayPortal>
}
