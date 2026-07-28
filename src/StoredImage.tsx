import { useEffect, useState, type CSSProperties } from 'react'
import { isStoredUiAsset, loadUiAssetBlob } from './asset-storage'

export function useStoredImageSource(source: string) {
  const [resolved, setResolved] = useState(() => isStoredUiAsset(source) ? '' : source)

  useEffect(() => {
    if (!isStoredUiAsset(source)) {
      setResolved(source)
      return
    }
    let disposed = false
    let objectUrl = ''
    void loadUiAssetBlob(source).then(blob => {
      if (!blob || disposed) return
      objectUrl = URL.createObjectURL(blob)
      setResolved(objectUrl)
    })
    return () => {
      disposed = true
      if (objectUrl) URL.revokeObjectURL(objectUrl)
    }
  }, [source])

  return resolved
}

export function StoredImage({ source, alt, className, style, loading }: {
  source: string
  alt: string
  className?: string
  style?: CSSProperties
  loading?: 'eager' | 'lazy'
}) {
  const resolved = useStoredImageSource(source)
  return resolved ? <img src={resolved} alt={alt} className={className} style={style} loading={loading} /> : null
}
