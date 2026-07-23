import { flushSync } from 'react-dom'

type TransitionDocument = Document & {
  startViewTransition?: (update: () => void) => { finished: Promise<void> }
}

export function runViewTransition(update: () => void) {
  const start = (document as TransitionDocument).startViewTransition
  if (!start || window.matchMedia('(prefers-reduced-motion: reduce)').matches) {
    update()
    return
  }
  try {
    start.call(document, () => flushSync(update))
  } catch {
    update()
  }
}
