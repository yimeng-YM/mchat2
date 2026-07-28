export type Role = {
  id: number
  name: string
  avatar: string
  signature: string
  relation: string
  status: string
  tags: string[]
  unread: number
  last: string
  time: string
  online: boolean
  persona: string
  background?: {
    image: string
    blur: number
    overlay: number
  }
}

export type ChatAttachment = {
  id: string
  kind: 'image'
  name: string
  mime: string
  size: number
  uri?: string
  rawUri?: string
  blob?: Blob
}

export type Message = {
  id: number
  createdAt?: number
  from: 'me' | 'them'
  text: string
  kind?: 'text' | 'emoji' | 'attachment'
  groupId?: string
  delivery?: 'queued' | 'sent' | 'read'
  attachment?: ChatAttachment
  edited?: boolean
  time: string
}

export const MEMORY_CATEGORIES = ['preference', 'habit', 'event', 'person', 'numeric', 'other'] as const

export type MemoryCategory = (typeof MEMORY_CATEGORIES)[number]

export type Memory = {
  id: string
  roleId: number
  category: MemoryCategory
  content: string
  importance: number // 1-5
  createdAt: number
  updatedAt: number
  archived?: boolean
  lastRoundAccessed?: number
}

export type MemoryInput = {
  category: MemoryCategory
  content: string
  importance: number
}

export type MemoryAdjustment = {
  memoryId: string
  newImportance: number
  reason: string
}

export type ExtractionOutput = {
  newMemories: MemoryInput[]
  memoryAdjustments: MemoryAdjustment[]
  archiveIds: string[]
}
