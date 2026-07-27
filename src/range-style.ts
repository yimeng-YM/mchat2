import type { CSSProperties } from 'react'

const RANGE_THUMB_SIZE = 16

export function rangeProgressStyle(value: number, min: number, max: number, fill?: string) {
  const ratio = max === min ? 0 : Math.max(0, Math.min(1, (value - min) / (max - min)))
  return {
    '--range-progress': `${ratio * 100}%`,
    '--range-offset': `${RANGE_THUMB_SIZE * (0.5 - ratio)}px`,
    ...(fill ? { '--range-fill': fill } : {}),
  } as CSSProperties
}
