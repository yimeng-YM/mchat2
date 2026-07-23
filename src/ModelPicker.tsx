import { useEffect, useMemo, useRef, useState } from 'react'
import { Check, ChevronDown, Search } from 'lucide-react'

export function ModelPicker({ value, models, onChange }: {
  value: string
  models: string[]
  onChange: (value: string) => void
}) {
  const [open, setOpen] = useState(false)
  const [activeIndex, setActiveIndex] = useState(0)
  const rootRef = useRef<HTMLDivElement>(null)
  const filteredModels = useMemo(() => {
    const query = value.trim().toLocaleLowerCase()
    if (!query) return models
    return models.filter(model => model.toLocaleLowerCase().includes(query))
  }, [models, value])

  useEffect(() => {
    const closeOnOutsidePointer = (event: PointerEvent) => {
      if (!rootRef.current?.contains(event.target as Node)) setOpen(false)
    }
    document.addEventListener('pointerdown', closeOnOutsidePointer)
    return () => document.removeEventListener('pointerdown', closeOnOutsidePointer)
  }, [])

  const choose = (model: string) => {
    onChange(model)
    setOpen(false)
    setActiveIndex(0)
  }

  return <div className="model-combobox" ref={rootRef}>
    <div className="model-combobox-input">
      <Search />
      <input
        id="model-name"
        role="combobox"
        aria-expanded={open}
        aria-controls="model-options"
        aria-autocomplete="list"
        aria-activedescendant={open && filteredModels[activeIndex] ? `model-option-${activeIndex}` : undefined}
        value={value}
        onFocus={() => setOpen(true)}
        onChange={event => { onChange(event.target.value); setOpen(true); setActiveIndex(0) }}
        onKeyDown={event => {
          if (event.key === 'ArrowDown') {
            event.preventDefault()
            setOpen(true)
            setActiveIndex(index => filteredModels.length ? Math.min(filteredModels.length - 1, index + 1) : 0)
          } else if (event.key === 'ArrowUp') {
            event.preventDefault()
            setActiveIndex(index => Math.max(0, index - 1))
          } else if (event.key === 'Enter' && open && filteredModels[activeIndex]) {
            event.preventDefault()
            choose(filteredModels[activeIndex])
          } else if (event.key === 'Escape') {
            setOpen(false)
          }
        }}
        placeholder="输入或选择模型"
        autoComplete="off"
      />
      <button type="button" onClick={() => setOpen(current => !current)} aria-label={open ? '收起模型列表' : '展开模型列表'} aria-expanded={open}>
        <ChevronDown />
      </button>
    </div>
    {open && <div className="model-options-popover">
      <div className="model-options-summary"><span>{value ? '筛选结果' : '已保存的模型'}</span><b>{filteredModels.length}</b></div>
      <ul id="model-options" role="listbox" aria-label="模型列表">
        {filteredModels.map((model, index) => <li key={model}>
          <button
            id={`model-option-${index}`}
            type="button"
            role="option"
            aria-selected={model === value}
            className={`${index === activeIndex ? 'active' : ''} ${model === value ? 'selected' : ''}`}
            onPointerMove={() => setActiveIndex(index)}
            onClick={() => choose(model)}
          >
            <span>{model}</span>{model === value && <Check />}
          </button>
        </li>)}
        {!filteredModels.length && <li className="model-options-empty">{models.length ? '没有匹配的模型，可直接使用当前输入' : '请先获取模型列表'}</li>}
      </ul>
    </div>}
  </div>
}
