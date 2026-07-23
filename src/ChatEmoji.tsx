import { useEffect, useState } from 'react'
import { emojiObjectUrl, type EmojiAsset } from './data-library'

export function ChatEmoji({ asset, name }: { asset?: EmojiAsset; name: string }) {
  const [src, setSrc] = useState(asset?.uri ?? '')

  useEffect(() => {
    if (!asset) {
      setSrc('')
      return
    }
    if (!asset.blob) {
      setSrc(asset.uri ?? '')
      return
    }
    const url = emojiObjectUrl(asset)
    setSrc(url)
    return () => URL.revokeObjectURL(url)
  }, [asset])

  if (!src) return <span className="missing-emoji">&lt;{name}&gt;</span>
  return <img className="chat-emoji" src={src} alt={`表情：${name}`} />
}
