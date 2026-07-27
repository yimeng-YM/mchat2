import { useEffect, useMemo, useRef, useState, type PointerEvent } from 'react'
import { Check, RotateCcw, X } from 'lucide-react'
import { useNativeBackDismiss } from './native-back'
import { OverlayPortal } from './OverlayPortal'
import { rangeProgressStyle } from './range-style'

const STAGE_SIZE = 280
const OUTPUT_SIZE = 512

type Point = { x: number; y: number }
type ImageInfo = { width: number; height: number }

function clamp(value: number, min: number, max: number) {
  return Math.min(max, Math.max(min, value))
}

export function AvatarCropper({ file, onCancel, onConfirm }: {
  file: File
  onCancel: () => void
  onConfirm: (avatar: string) => void
}) {
  const [sourceUrl, setSourceUrl] = useState('')
  const [imageInfo, setImageInfo] = useState<ImageInfo | null>(null)
  const [zoom, setZoom] = useState(1)
  const [offset, setOffset] = useState<Point>({ x: 0, y: 0 })
  const [error, setError] = useState('')
  const imageRef = useRef<HTMLImageElement>(null)
  const dragRef = useRef<{ pointerId: number; x: number; y: number; origin: Point } | null>(null)
  useNativeBackDismiss(true, onCancel)

  useEffect(() => {
    const url = URL.createObjectURL(file)
    setSourceUrl(url)
    return () => URL.revokeObjectURL(url)
  }, [file])

  const baseScale = useMemo(() => {
    if (!imageInfo) return 1
    return Math.max(STAGE_SIZE / imageInfo.width, STAGE_SIZE / imageInfo.height)
  }, [imageInfo])

  const constrain = (point: Point, nextZoom = zoom) => {
    if (!imageInfo) return { x: 0, y: 0 }
    const width = imageInfo.width * baseScale * nextZoom
    const height = imageInfo.height * baseScale * nextZoom
    const maxX = Math.max(0, (width - STAGE_SIZE) / 2)
    const maxY = Math.max(0, (height - STAGE_SIZE) / 2)
    return { x: clamp(point.x, -maxX, maxX), y: clamp(point.y, -maxY, maxY) }
  }

  const changeZoom = (value: number) => {
    const nextZoom = clamp(value, 1, 3)
    setZoom(nextZoom)
    setOffset(current => constrain(current, nextZoom))
  }

  const pointerDown = (event: PointerEvent<HTMLDivElement>) => {
    event.currentTarget.setPointerCapture(event.pointerId)
    dragRef.current = { pointerId: event.pointerId, x: event.clientX, y: event.clientY, origin: offset }
  }

  const pointerMove = (event: PointerEvent<HTMLDivElement>) => {
    const drag = dragRef.current
    if (!drag || drag.pointerId !== event.pointerId) return
    setOffset(constrain({
      x: drag.origin.x + event.clientX - drag.x,
      y: drag.origin.y + event.clientY - drag.y,
    }))
  }

  const pointerEnd = (event: PointerEvent<HTMLDivElement>) => {
    if (dragRef.current?.pointerId === event.pointerId) dragRef.current = null
  }

  const confirm = () => {
    const image = imageRef.current
    if (!image || !imageInfo) return
    const renderedScale = baseScale * zoom
    const sourceSize = STAGE_SIZE / renderedScale
    const sourceX = imageInfo.width / 2 - offset.x / renderedScale - sourceSize / 2
    const sourceY = imageInfo.height / 2 - offset.y / renderedScale - sourceSize / 2
    const canvas = document.createElement('canvas')
    canvas.width = OUTPUT_SIZE
    canvas.height = OUTPUT_SIZE
    const context = canvas.getContext('2d')
    if (!context) { setError('无法处理头像'); return }
    context.drawImage(image, sourceX, sourceY, sourceSize, sourceSize, 0, 0, OUTPUT_SIZE, OUTPUT_SIZE)
    onConfirm(canvas.toDataURL('image/webp', 0.86))
  }

  const renderedWidth = imageInfo ? imageInfo.width * baseScale : STAGE_SIZE
  const renderedHeight = imageInfo ? imageInfo.height * baseScale : STAGE_SIZE
  const zoomStyle = rangeProgressStyle(zoom, 1, 3)

  return <OverlayPortal><div className="crop-overlay" role="dialog" aria-modal="true" aria-labelledby="crop-title">
    <section className="crop-dialog">
      <header><div><h2 id="crop-title">裁切头像</h2><p>拖动图片调整位置</p></div><button className="icon-btn" onClick={onCancel} aria-label="取消裁切"><X /></button></header>
      <div className="avatar-crop-stage" onPointerDown={pointerDown} onPointerMove={pointerMove} onPointerUp={pointerEnd} onPointerCancel={pointerEnd}>
        {sourceUrl && <img
          ref={imageRef}
          src={sourceUrl}
          alt="待裁切头像"
          draggable={false}
          onLoad={event => {
            setImageInfo({ width: event.currentTarget.naturalWidth, height: event.currentTarget.naturalHeight })
            setError('')
          }}
          onError={() => setError('无法读取这张图片')}
          style={{
            width: renderedWidth,
            height: renderedHeight,
            transform: `translate(-50%, -50%) translate(${offset.x}px, ${offset.y}px) scale(${zoom})`,
          }}
        />}
        <div className="crop-mask" />
      </div>
      <div className="crop-zoom"><span>缩放</span><input className="range-input" style={zoomStyle} type="range" min="1" max="3" step="0.01" value={zoom} onChange={event => changeZoom(Number(event.target.value))} aria-label="头像缩放" /><button onClick={() => { setZoom(1); setOffset({ x: 0, y: 0 }) }} aria-label="重置裁切"><RotateCcw /></button></div>
      {error && <p className="crop-error">{error}</p>}
      <footer><button className="secondary" onClick={onCancel}>取消</button><button className="primary" onClick={confirm} disabled={!imageInfo || Boolean(error)}><Check />使用头像</button></footer>
    </section>
  </div></OverlayPortal>
}
