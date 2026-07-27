import { useMemo, useState, type CSSProperties, type ReactNode } from 'react'
import { Check, ChevronRight, Droplets, Palette, X } from 'lucide-react'
import { useNativeBackDismiss } from './native-back'
import { OverlayPortal } from './OverlayPortal'
import { rangeProgressStyle } from './range-style'

const COLOR_PRESETS = [
  '#FFFFFF', '#E9EDF5', '#C9D3E6', '#7B8498', '#303746', '#171B24',
  '#6D5DFB', '#8B6FF7', '#2878F0', '#38A2DB', '#25A994', '#248B78',
  '#65B75D', '#E0B542', '#E1773D', '#E75858', '#D65C8D', '#A85FC1',
]

type Rgb = { r: number; g: number; b: number }

function normalizeHex(value: string) {
  const normalized = value.trim().replace(/^#?/, '#').toUpperCase()
  return /^#[0-9A-F]{6}$/.test(normalized) ? normalized : null
}

function hexToRgb(value: string): Rgb {
  const valid = normalizeHex(value) ?? '#6D5DFB'
  return {
    r: Number.parseInt(valid.slice(1, 3), 16),
    g: Number.parseInt(valid.slice(3, 5), 16),
    b: Number.parseInt(valid.slice(5, 7), 16),
  }
}

function rgbToHex({ r, g, b }: Rgb) {
  return `#${[r, g, b].map(channel => Math.round(channel).toString(16).padStart(2, '0')).join('')}`.toUpperCase()
}

function alphaColor(color: string, opacity: number) {
  const { r, g, b } = hexToRgb(color)
  return `rgba(${r}, ${g}, ${b}, ${opacity})`
}

function inkColor(color: string) {
  const { r, g, b } = hexToRgb(color)
  return (r * 299 + g * 587 + b * 114) / 1000 > 168 ? '#18201D' : '#FFFFFF'
}

export function ColorPicker({
  label, triggerLabel, triggerClassName, triggerAriaLabel, triggerContent,
  value, opacity, accentColor, dark, glass, compact = false, onChange,
}: {
  label: string
  triggerLabel?: string
  triggerClassName?: string
  triggerAriaLabel?: string
  triggerContent?: ReactNode
  value: string
  opacity?: number
  accentColor: string
  dark: boolean
  glass: boolean
  compact?: boolean
  onChange: (color: string, opacity?: number) => void
}) {
  const [open, setOpen] = useState(false)
  const [draft, setDraft] = useState(value)
  const [hexDraft, setHexDraft] = useState(value)
  const [draftOpacity, setDraftOpacity] = useState(opacity ?? 100)
  const hasOpacity = opacity !== undefined
  const rgb = useMemo(() => hexToRgb(draft), [draft])

  const close = () => setOpen(false)
  useNativeBackDismiss(open, close)

  const openPicker = () => {
    setDraft(value)
    setHexDraft(value)
    setDraftOpacity(opacity ?? 100)
    setOpen(true)
  }
  const choose = (color: string) => {
    const normalized = normalizeHex(color)
    if (!normalized) return
    setDraft(normalized)
    setHexDraft(normalized)
  }
  const updateChannel = (channel: keyof Rgb, channelValue: number) => {
    choose(rgbToHex({ ...rgb, [channel]: channelValue }))
  }
  const overlayStyle = {
    '--picker-accent': accentColor,
    '--picker-accent-soft': alphaColor(accentColor, dark ? .22 : .12),
    '--picker-bg': dark ? 'rgba(25,27,37,.94)' : 'rgba(255,255,255,.94)',
    '--picker-bg-soft': dark ? 'rgba(53,55,69,.72)' : 'rgba(241,244,250,.82)',
    '--picker-line': dark ? 'rgba(235,238,255,.12)' : 'rgba(62,72,98,.14)',
    '--picker-text': dark ? '#F3F4FA' : '#202534',
    '--picker-muted': dark ? '#AAAEBD' : '#6B7284',
    '--picker-draft-alpha': alphaColor(draft, draftOpacity / 100),
  } as CSSProperties

  return <>
    {triggerContent !== undefined ? <button
      type="button"
      className={triggerClassName}
      onClick={openPicker}
      aria-label={triggerAriaLabel ?? label}
      aria-haspopup="dialog"
      aria-expanded={open}
    >{triggerContent}</button> : compact ? <button
      type="button"
      className="custom-color color-picker-compact-trigger"
      onClick={openPicker}
      aria-label={`自定义${label}`}
      aria-haspopup="dialog"
      aria-expanded={open}
    ><i style={{ background: value }} /><Palette /></button> : <button
      type="button"
      className="bubble-color-trigger"
      onClick={openPicker}
      aria-haspopup="dialog"
      aria-expanded={open}
    >
      <span><i style={{ background: value }} />{triggerLabel ?? label}</span>
      <b>{value}<ChevronRight /></b>
    </button>}

    {open && <OverlayPortal><div
      className={`color-picker-overlay ${glass ? 'color-picker-glass' : ''} ${dark ? 'color-picker-dark' : ''}`}
      style={overlayStyle}
      onPointerDown={event => { if (event.target === event.currentTarget) close() }}
    >
      <section className="color-picker-dialog" role="dialog" aria-modal="true" aria-labelledby="color-picker-title">
        <header>
          <div><span>自定义颜色</span><h2 id="color-picker-title">{label}</h2></div>
          <button className="color-picker-close" onClick={close} aria-label="关闭颜色选择"><X /></button>
        </header>

        <div className={`color-picker-hero ${hasOpacity ? 'with-opacity' : ''}`} style={{ '--picker-draft': draft } as CSSProperties}>
          <i />
          <span>
            <small>{hasOpacity ? '当前气泡样式' : '当前颜色'}</small>
            <strong>{draft}</strong>
            {hasOpacity && <output>{draftOpacity}% 透明度</output>}
          </span>
        </div>

        <div className="color-picker-presets" aria-label="预设颜色">
          {COLOR_PRESETS.map(color => <button
            type="button"
            key={color}
            className={draft === color ? 'selected' : ''}
            style={{ '--picker-swatch': color } as CSSProperties}
            onClick={() => choose(color)}
            aria-label={`选择颜色 ${color}`}
          >{draft === color && <Check />}</button>)}
        </div>

        <div className="color-picker-rgb">
          {([
            ['r', 'R', '#F05B61'],
            ['g', 'G', '#36A96B'],
            ['b', 'B', '#4B82EB'],
          ] as const).map(([channel, shortLabel, color]) => <label key={channel}>
            <span><b style={{ background: color }}>{shortLabel}</b><small>{channel === 'r' ? '红色' : channel === 'g' ? '绿色' : '蓝色'}</small></span>
            <input
              className="range-input"
              style={rangeProgressStyle(rgb[channel], 0, 255, color)}
              type="range"
              min="0"
              max="255"
              step="1"
              value={rgb[channel]}
              onChange={event => updateChannel(channel, Number(event.target.value))}
              aria-label={`${label}${channel === 'r' ? '红色' : channel === 'g' ? '绿色' : '蓝色'}通道`}
            />
            <output>{rgb[channel]}</output>
          </label>)}
        </div>

        {hasOpacity && <label className="color-picker-opacity">
          <span><Droplets />透明度</span>
          <input
            className="range-input"
            style={rangeProgressStyle(draftOpacity, 0, 100, accentColor)}
            type="range"
            min="0"
            max="100"
            step="1"
            value={draftOpacity}
            onChange={event => setDraftOpacity(Number(event.target.value))}
            aria-label={`${label}透明度`}
          />
          <output>{draftOpacity}%</output>
        </label>}

        <label className="color-picker-hex">
          <span>HEX 色值</span>
          <input
            value={hexDraft}
            onChange={event => {
              const next = event.target.value.toUpperCase().slice(0, 7)
              setHexDraft(next)
              const normalized = normalizeHex(next)
              if (normalized) setDraft(normalized)
            }}
            onBlur={() => setHexDraft(draft)}
            maxLength={7}
            spellCheck={false}
            aria-label={`${label} HEX 色值`}
          />
        </label>

        <footer>
          <button className="secondary" onClick={close}>取消</button>
          <button className="primary" style={{ background: draft, color: inkColor(draft) }} onClick={() => { onChange(draft, hasOpacity ? draftOpacity : undefined); close() }}><Check />{hasOpacity ? '应用样式' : '应用颜色'}</button>
        </footer>
      </section>
    </div></OverlayPortal>}
  </>
}
