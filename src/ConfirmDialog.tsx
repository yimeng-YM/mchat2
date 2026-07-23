import type { ReactNode } from 'react'
import { AlertTriangle, X } from 'lucide-react'
import { useNativeBackDismiss } from './native-back'
import { OverlayPortal } from './OverlayPortal'
import { runViewTransition } from './view-transitions'

export function ConfirmDialog({ title, description, confirmLabel, destructive = false, children, onCancel, onConfirm }: {
  title: string
  description: string
  confirmLabel: string
  destructive?: boolean
  children?: ReactNode
  onCancel: () => void
  onConfirm: () => void
}) {
  useNativeBackDismiss(true, onCancel)

  return <OverlayPortal><div className="dialog-overlay" role="dialog" aria-modal="true" aria-labelledby="confirm-dialog-title">
    <section className="confirm-dialog">
      <header><span className={destructive ? 'danger' : ''}><AlertTriangle /></span><div><h2 id="confirm-dialog-title">{title}</h2><p>{description}</p></div><button className="icon-btn" onClick={() => runViewTransition(onCancel)} aria-label="关闭确认弹窗"><X /></button></header>
      {children && <div className="confirm-dialog-content">{children}</div>}
      <footer><button className="secondary" onClick={() => runViewTransition(onCancel)}>取消</button><button className={destructive ? 'danger-button' : 'primary'} onClick={() => runViewTransition(onConfirm)}>{confirmLabel}</button></footer>
    </section>
  </div></OverlayPortal>
}
