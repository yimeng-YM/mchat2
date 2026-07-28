import Dexie, { type EntityTable } from 'dexie'

export type UiAsset = {
  id: string
  owner: string
  mime: string
  blob: Blob
  createdAt: number
}

class UiAssetDatabase extends Dexie {
  assets!: EntityTable<UiAsset, 'id'>

  constructor() {
    super('mchat2-ui-assets')
    this.version(1).stores({ assets: '&id,owner,createdAt' })
  }
}

const uiAssetDb = new UiAssetDatabase()

export const UI_ASSET_PREFIX = 'mchat2-asset:'

export function isStoredUiAsset(source: string) {
  return source.startsWith(UI_ASSET_PREFIX)
}

function assetId(source: string) {
  return source.slice(UI_ASSET_PREFIX.length)
}

export async function persistUiAsset(source: string, owner: string) {
  if (isStoredUiAsset(source)) return source
  if (!source || !source.startsWith('data:image/')) {
    await uiAssetDb.assets.where('owner').equals(owner).delete()
    return source
  }
  const response = await fetch(source)
  const blob = await response.blob()
  const id = crypto.randomUUID()
  const asset: UiAsset = {
    id,
    owner,
    mime: blob.type || 'image/webp',
    blob,
    createdAt: Date.now(),
  }
  await uiAssetDb.transaction('rw', uiAssetDb.assets, async () => {
    await uiAssetDb.assets.where('owner').equals(owner).delete()
    await uiAssetDb.assets.put(asset)
  })
  return `${UI_ASSET_PREFIX}${id}`
}

export async function loadUiAssetBlob(source: string) {
  if (!isStoredUiAsset(source)) return null
  return (await uiAssetDb.assets.get(assetId(source)))?.blob ?? null
}

export async function uiAssetDataUrl(source: string) {
  const blob = await loadUiAssetBlob(source)
  if (!blob) return source
  return new Promise<string>((resolve, reject) => {
    const reader = new FileReader()
    reader.onload = () => resolve(String(reader.result ?? ''))
    reader.onerror = () => reject(reader.error ?? new Error('无法读取图片资源'))
    reader.readAsDataURL(blob)
  })
}

export async function migrateRoleUiAssets<T extends {
  id: number
  avatar: string
  background?: { image: string; blur: number; overlay: number }
}>(roles: T[]) {
  let changed = false
  const migrated: T[] = []
  for (const role of roles) {
    const [avatar, backgroundImage] = await Promise.all([
      persistUiAsset(role.avatar, `role:${role.id}:avatar`),
      role.background?.image
        ? persistUiAsset(role.background.image, `role:${role.id}:background`)
        : Promise.resolve(''),
    ])
    const background = role.background && backgroundImage
      ? { ...role.background, image: backgroundImage }
      : role.background
    if (avatar !== role.avatar || background?.image !== role.background?.image) changed = true
    migrated.push({ ...role, avatar, background } as T)
  }
  return { roles: migrated, changed }
}

export async function listUiAssetsForBackup(selectedRoleIds?: number[]) {
  const selected = selectedRoleIds?.length ? new Set(selectedRoleIds) : null
  return uiAssetDb.assets.filter(asset => {
    if (asset.owner === 'user:avatar') return !selected
    const match = /^role:(\d+):/.exec(asset.owner)
    return Boolean(match && (!selected || selected.has(Number(match[1]))))
  }).toArray()
}

export async function restoreUiAssets(assets: UiAsset[]) {
  if (!assets.length) return
  const owners = [...new Set(assets.map(asset => asset.owner))]
  await uiAssetDb.transaction('rw', uiAssetDb.assets, async () => {
    await uiAssetDb.assets.where('owner').anyOf(owners).delete()
    await uiAssetDb.assets.bulkPut(assets)
  })
}

export async function removeRoleUiAssets(roleId: number) {
  await uiAssetDb.assets.where('owner').anyOf([`role:${roleId}:avatar`, `role:${roleId}:background`]).delete()
}
