import { beforeEach, describe, expect, it } from 'vitest'
import {
  loadConversationPreviews,
  loadQueuedMessages,
  searchConversationMessages,
} from '../src/conversation-repository'
import { libraryDb, type StoredMessage } from '../src/data-library'

function stored(roleId: number, messageId: number, text: string, createdAt: number, delivery?: StoredMessage['delivery']): StoredMessage {
  return {
    key: `${roleId}:${messageId}`,
    roleId,
    messageId,
    from: 'me',
    text,
    time: '12:00',
    createdAt,
    delivery,
  }
}

describe('conversation repository', () => {
  beforeEach(async () => {
    await libraryDb.messages.clear()
  })

  it('loads only the latest preview for each role', async () => {
    await libraryDb.messages.bulkPut([
      stored(10, 1, 'old', 100),
      stored(10, 2, 'latest', 200),
      stored(20, 3, 'other', 150),
    ])
    const previews = await loadConversationPreviews([10, 20])
    expect(previews[10]?.text).toBe('latest')
    expect(previews[20]?.text).toBe('other')
  })

  it('searches full history and restores queued messages in order', async () => {
    await libraryDb.messages.bulkPut([
      stored(10, 1, '需要查找的旧消息', 100),
      stored(10, 2, 'queued two', 300, 'queued'),
      stored(10, 3, 'queued one', 200, 'queued'),
    ])
    const matches = await searchConversationMessages('旧消息', [10])
    const queued = await loadQueuedMessages(10)
    expect(matches.get(10)?.text).toBe('需要查找的旧消息')
    expect(queued.map(message => message.text)).toEqual(['queued one', 'queued two'])
  })
})
