import { flushSync } from 'react-dom'

type TransitionDocument = Document & {
  startViewTransition?: (update: () => void) => { finished: Promise<void> }
}

// 'forward' 新界面从右侧滑入（进入下一层）；'back' 反向滑出（返回上一层）；
// 'fade' 保留原有淡入淡出（用于弹窗、裁切等非左右层级切换）。
export type TransitionDirection = 'forward' | 'back' | 'fade'

export function runViewTransition(update: () => void, direction: TransitionDirection = 'fade') {
  const start = (document as TransitionDocument).startViewTransition
  if (!start || window.matchMedia('(prefers-reduced-motion: reduce)').matches) {
    update()
    return
  }
  try {
    document.documentElement.dataset.vt = direction
    const transition = start.call(document, () => flushSync(update))
    void transition.finished.finally(() => {
      if (document.documentElement.dataset.vt === direction) delete document.documentElement.dataset.vt
    })
  } catch {
    delete document.documentElement.dataset.vt
    update()
  }
}
