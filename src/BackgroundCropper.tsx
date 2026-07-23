import { useEffect, useMemo, useRef, useState, type PointerEvent } from 'react'
import { Check, RotateCcw, X } from 'lucide-react'
import { useNativeBackDismiss } from './native-back'
import { OverlayPortal } from './OverlayPortal'

const STAGE_WIDTH = 210
const STAGE_HEIGHT = 330
const OUTPUT_WIDTH = 720
const OUTPUT_HEIGHT = 1280

type Point = { x: number; y: number }
type ImageInfo = { width: number; height: number }

function clamp(value: number, min: number, max: number) {
  return Math.min(max, Math.max(min, value))
}

export function BackgroundCropper({ file, onCancel, onConfirm }: {
  file: File
  onCancel: () => void
  onConfirm: (image: string) => void
}) {
  const [sourceUrl, setSourceUrl] = useState('')
  const [imageInfo, setImageInfo] = useState<ImageInfo | null>(null)
  const [zoom, setZoom] = useState(1)
  const [offset, setOffset] = useState<Point>({ x: 0, y: 0 })
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
    return Math.max(STAGE_WIDTH / imageInfo.width, STAGE_HEIGHT / imageInfo.height)
  }, [imageInfo])

  const constrain = (point: Point, nextZoom = zoom) => {
    if (!imageInfo) return { x: 0, y: 0 }
    const width = imageInfo.width * baseScale * nextZoom
    const height = imageInfo.height * baseScale * nextZoom
    return {
      x: clamp(point.x, -Math.max(0, (width - STAGE_WIDTH) / 2), Math.max(0, (width - STAGE_WIDTH) / 2)),
      y: clamp(point.y, -Math.max(0, (height - STAGE_HEIGHT) / 2), Math.max(0, (height - STAGE_HEIGHT) / 2)),
    }
  }

  const confirm = () => {
    if (!imageRef.current || !imageInfo) return
    const scale = baseScale * zoom
    const sourceWidth = STAGE_WIDTH / scale
    const sourceHeight = STAGE_HEIGHT / scale
    const sourceX = imageInfo.width / 2 - offset.x / scale - sourceWidth / 2
    const sourceY = imageInfo.height / 2 - offset.y / scale - sourceHeight / 2
    const canvas = document.createElement('canvas')
    canvas.width = OUTPUT_WIDTH
    canvas.height = OUTPUT_HEIGHT
    const context = canvas.getContext('2d')
    if (!context) return
    context.drawImage(imageRef.current, sourceX, sourceY, sourceWidth, sourceHeight, 0, 0, OUTPUT_WIDTH, OUTPUT_HEIGHT)
    onConfirm(canvas.toDataURL('image/webp', 0.8))
  }

  return <OverlayPortal><div className="crop-overlay" role="dialog" aria-modal="true" aria-labelledby="background-crop-title">
    <section className="crop-dialog background-crop-dialog">
      <header><div><h2 id="background-crop-title">裁切聊天背景</h2><p>拖动图片选择聊天中显示的区域</p></div><button className="icon-btn" onClick={onCancel} aria-label="取消背景裁切"><X /></button></header>
      <div
        className="background-crop-stage"
        onPointerDown={(event: PointerEvent<HTMLDivElement>) => {
          event.currentTarget.setPointerCapture(event.pointerId)
          dragRef.current = { pointerId: event.pointerId, x: event.clientX, y: event.clientY, origin: offset }
        }}
        onPointerMove={(event: PointerEvent<HTMLDivElement>) => {
          const drag = dragRef.current
          if (!drag || drag.pointerId !== event.pointerId) return
          setOffset(constrain({ x: drag.origin.x + event.clientX - drag.x, y: drag.origin.y + event.clientY - drag.y }))
        }}
        onPointerUp={() => { dragRef.current = null }}
        onPointerCancel={() => { dragRef.current = null }}
      >
        {sourceUrl && <img
          ref={imageRef}
          src={sourceUrl}
          alt="待裁切聊天背景"
          draggable={false}
          onLoad={event => setImageInfo({ width: event.currentTarget.naturalWidth, height: event.currentTarget.naturalHeight })}
          style={{
            width: imageInfo ? imageInfo.width * baseScale : STAGE_WIDTH,
            height: imageInfo ? imageInfo.height * baseScale : STAGE_HEIGHT,
            transform: `translate(-50%, -50%) translate(${offset.x}px, ${offset.y}px) scale(${zoom})`,
          }}
        />}
        <div className="background-crop-guide" />
      </div>
      <div className="crop-zoom"><span>缩放</span><input type="range" min="1" max="3" step="0.01" value={zoom} onChange={event => { const next = Number(event.target.value); setZoom(next); setOffset(current => constrain(current, next)) }} aria-label="背景缩放" /><button onClick={() => { setZoom(1); setOffset({ x: 0, y: 0 }) }} aria-label="重置背景裁切"><RotateCcw /></button></div>
      <footer><button className="secondary" onClick={onCancel}>取消</button><button className="primary" onClick={confirm} disabled={!imageInfo}><Check />使用背景</button></footer>
    </section>
  </div></OverlayPortal>
}
