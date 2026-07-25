import { useEffect, useState } from 'react'
import { Image as ImageIcon, X } from 'lucide-react'
import { useNativeBackDismiss } from './native-back'
import { OverlayPortal } from './OverlayPortal'
import type { ChatAttachment } from './chat-types'
import { runViewTransition } from './view-transitions'

export function ChatAttachmentView({ attachment }: { attachment?: ChatAttachment }) {
  const [src, setSrc] = useState(attachment?.uri ?? '')
  const [expanded, setExpanded] = useState(false)
  useNativeBackDismiss(expanded, () => setExpanded(false))

  useEffect(() => {
    if (!attachment?.blob) {
      setSrc(attachment?.uri ?? '')
      return
    }
    const url = URL.createObjectURL(attachment.blob)
    setSrc(url)
    return () => URL.revokeObjectURL(url)
  }, [attachment])

  if (!attachment) return null
  return <>
      <button
        className="chat-image-attachment"
        onPointerDown={event => event.stopPropagation()}
        onClick={event => { event.stopPropagation(); if (src) runViewTransition(() => setExpanded(true)) }}
        aria-label={`展开图片 ${attachment.name}`}
      >
        {src ? <img src={src} alt={attachment.name} /> : <ImageIcon />}
      </button>
      {expanded && <OverlayPortal><div
        className="image-lightbox"
        role="dialog"
        aria-modal="true"
        aria-label={attachment.name}
        onPointerDown={event => event.stopPropagation()}
        onClick={() => runViewTransition(() => setExpanded(false))}
      >
        <button className="image-lightbox-close" onClick={event => { event.stopPropagation(); runViewTransition(() => setExpanded(false)) }} aria-label="关闭图片预览"><X /></button>
        <img src={src} alt={attachment.name} onClick={event => event.stopPropagation()} />
      </div></OverlayPortal>}
    </>
}
