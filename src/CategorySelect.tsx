import { useEffect, useRef, useState } from 'react'
import { Check, ChevronDown } from 'lucide-react'
import { MEMORY_CATEGORIES } from './chat-types'
import type { MemoryCategory } from './chat-types'

export const MEMORY_CATEGORY_LABELS: Record<MemoryCategory, string> = {
  preference: '偏好',
  habit: '习惯',
  event: '事件',
  person: '人际',
  numeric: '数值',
  other: '其他',
}

const CATEGORY_ORDER: readonly MemoryCategory[] = MEMORY_CATEGORIES

// 自适应 UI 的记忆分类选择器，替换原生 <select> 弹窗，深浅色主题一致。
export function CategorySelect({ value, onChange }: {
  value: MemoryCategory
  onChange: (value: MemoryCategory) => void
}) {
  const [open, setOpen] = useState(false)
  const rootRef = useRef<HTMLDivElement>(null)

  useEffect(() => {
    if (!open) return
    const handlePointer = (event: PointerEvent) => {
      if (!rootRef.current?.contains(event.target as Node)) setOpen(false)
    }
    const handleKey = (event: KeyboardEvent) => {
      if (event.key === 'Escape') setOpen(false)
    }
    window.addEventListener('pointerdown', handlePointer)
    window.addEventListener('keydown', handleKey)
    return () => {
      window.removeEventListener('pointerdown', handlePointer)
      window.removeEventListener('keydown', handleKey)
    }
  }, [open])

  return <div className={`category-select ${open ? 'open' : ''}`} ref={rootRef}>
    <button type="button" className="category-select-trigger" onClick={() => setOpen(value => !value)} aria-haspopup="listbox" aria-expanded={open}>
      <span>{MEMORY_CATEGORY_LABELS[value]}</span><ChevronDown />
    </button>
    {open && <ul className="category-select-menu" role="listbox">
      {CATEGORY_ORDER.map(category => <li key={category} role="option" aria-selected={category === value}>
        <button type="button" className={category === value ? 'selected' : ''} onClick={() => { onChange(category); setOpen(false) }}>
          <span>{MEMORY_CATEGORY_LABELS[category]}</span>{category === value && <Check />}
        </button>
      </li>)}
    </ul>}
  </div>
}
