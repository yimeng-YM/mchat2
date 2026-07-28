import { beforeEach, describe, expect, it, vi } from 'vitest'
import type { Message, Role } from '../src/chat-types'

const queued: Message = {
  id: 10,
  createdAt: 100,
  from: 'me',
  text: '等待恢复',
  time: '12:00',
  delivery: 'queued',
  groupId: 'user-restored',
}

vi.mock('../src/ai-service', () => ({
  MODEL_CONFIG_CHANGED_EVENT: 'model-change',
  loadModelConfig: () => ({
    baseUrl: '',
    apiKey: '',
    model: '',
    models: [],
    temperature: 0,
    maxTokens: 100,
    queueMode: 'manual',
    queueDelaySeconds: 4,
    contextMessageCount: 20,
  }),
  requestAiReply: vi.fn(),
}))

vi.mock('../src/conversation-repository', () => ({
  loadQueuedMessages: vi.fn(async () => [queued]),
  getConversationJob: vi.fn(async () => null),
  saveConversationJob: vi.fn(),
  deleteConversationJob: vi.fn(),
}))

vi.mock('../src/data-library', () => ({
  loadConversation: vi.fn(async () => [queued]),
  saveConversationMessages: vi.fn(),
  updateConversationMessages: vi.fn(),
  listRoleEmojiCatalog: vi.fn(async () => []),
}))

vi.mock('../src/preferences', () => ({
  loadAppPreferences: () => ({
    notificationsEnabled: false,
    notificationPreview: true,
    memoryExtractionInterval: 0,
    messageSound: false,
    userName: '你',
  }),
  playMessageTone: vi.fn(),
}))

vi.mock('../src/conversation-events', () => ({ emitConversationIncoming: vi.fn() }))
vi.mock('../src/device-features', () => ({ showReplyNotification: vi.fn() }))
vi.mock('../src/memory-service', () => ({
  loadRelevantMemories: vi.fn(async () => []),
  incrementConversationRound: vi.fn(),
  shouldExtractMemory: vi.fn(() => false),
  updateMemoryRoundAccess: vi.fn(),
  extractMemoriesFromConversation: vi.fn(),
  deduplicateAndSaveMemories: vi.fn(),
}))

describe('conversation runtime', () => {
  beforeEach(() => {
    vi.resetModules()
  })

  it('restores a persisted manual queue without mounting ChatView', async () => {
    const runtime = await import('../src/conversation-runtime')
    const role: Role = {
      id: 1,
      name: '角色',
      avatar: '',
      signature: '',
      relation: '',
      status: '',
      tags: [],
      unread: 0,
      last: '',
      time: '',
      online: true,
      persona: '',
    }
    runtime.configureConversationRuntime({
      getRole: roleId => roleId === role.id ? role : null,
      getPreferences: () => ({
        colorMode: 'light',
        interfaceStyle: 'classic',
        accentColor: '#000000',
        myBubbleColor: '#000000',
        theirBubbleColor: '#FFFFFF',
        myBubbleOpacity: 100,
        theirBubbleOpacity: 100,
        topBarOpacity: 100,
        navigationOpacity: 100,
        inputOpacity: 100,
        reduceMotion: false,
        typingStatus: true,
        messageSound: false,
        notificationsEnabled: false,
        notificationPreview: false,
        memoryExtractionInterval: 0,
        userName: '你',
        userAvatar: '',
      }),
      onMessagesUpdated: vi.fn(),
    })

    await runtime.bootstrapConversationRuntimes([role.id])

    expect(runtime.getConversationRuntimeSnapshot(role.id).queuedCount).toBe(1)
  })
})
