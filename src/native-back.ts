import { useEffect, useRef } from 'react'

const nativeBackEvent = 'jinyu:native-back'

export function dispatchNativeBackDismiss() {
  const event = new Event(nativeBackEvent, { cancelable: true })
  window.dispatchEvent(event)
  return event.defaultPrevented
}

export function useNativeBackDismiss(active: boolean, onDismiss: () => void) {
  const dismissRef = useRef(onDismiss)

  useEffect(() => {
    dismissRef.current = onDismiss
  }, [onDismiss])

  useEffect(() => {
    if (!active) return
    const handleBack = (event: Event) => {
      if (event.defaultPrevented) return
      event.preventDefault()
      event.stopImmediatePropagation()
      dismissRef.current()
    }
    window.addEventListener(nativeBackEvent, handleBack)
    return () => window.removeEventListener(nativeBackEvent, handleBack)
  }, [active])
}
