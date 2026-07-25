import { useEffect } from 'react'

// 通过 VisualViewport 追踪软键盘高度，写入 --keyboard-inset 变量并切换 body.kb-open。
// 兼容各机型 / 输入法：即使原生窗口未随键盘缩放（沉浸式全面屏常见），
// 也能把输入区抬升到键盘之上，避免盲打。
export function useKeyboardInset() {
  useEffect(() => {
    const viewport = window.visualViewport
    if (!viewport) return

    let frame = 0
    const apply = () => {
      frame = 0
      // 布局视口高度减去可视视口（含滚动偏移）即为被键盘遮挡的高度。
      // 若原生已随键盘 resize，innerHeight 同步缩小，inset≈0，交给 dvh 处理。
      const inset = Math.max(0, window.innerHeight - viewport.height - viewport.offsetTop)
      const open = inset > 80
      document.body.classList.toggle('kb-open', open)
      document.documentElement.style.setProperty('--keyboard-inset', `${open ? Math.round(inset) : 0}px`)
    }
    const schedule = () => {
      if (frame) return
      frame = requestAnimationFrame(apply)
    }

    apply()
    viewport.addEventListener('resize', schedule)
    viewport.addEventListener('scroll', schedule)
    window.addEventListener('orientationchange', schedule)
    return () => {
      if (frame) cancelAnimationFrame(frame)
      viewport.removeEventListener('resize', schedule)
      viewport.removeEventListener('scroll', schedule)
      window.removeEventListener('orientationchange', schedule)
      document.body.classList.remove('kb-open')
      document.documentElement.style.removeProperty('--keyboard-inset')
    }
  }, [])
}
