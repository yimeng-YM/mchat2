import { describe, expect, it } from 'vitest'
import { createBackupSettings, normalizeBackupSettings } from '../src/backup-settings'
import { defaultModelConfig } from '../src/ai-service'
import { defaultAppPreferences, defaultMemoryModelConfig } from '../src/preferences'

describe('backup settings', () => {
  it('never exports API keys', () => {
    const result = createBackupSettings(
      defaultAppPreferences,
      { ...defaultModelConfig, apiKey: 'chat-secret' },
      { ...defaultMemoryModelConfig, apiKey: 'memory-secret' },
    )
    expect(result.model).not.toHaveProperty('apiKey')
    expect(result.memoryModel).not.toHaveProperty('apiKey')
  })

  it('sanitizes imported settings and keeps current secrets', () => {
    const result = normalizeBackupSettings({
      preferences: { accentColor: 'not-a-color', memoryExtractionInterval: 999, notificationsEnabled: true },
      model: { maxTokens: -20, temperature: 99, queueMode: 'manual' },
      memoryModel: { temperature: -5 },
    }, defaultAppPreferences, { ...defaultModelConfig, apiKey: 'current-chat-key' }, {
      ...defaultMemoryModelConfig,
      apiKey: 'current-memory-key',
    })

    expect(result?.preferences.accentColor).toBe(defaultAppPreferences.accentColor)
    expect(result?.preferences.memoryExtractionInterval).toBe(20)
    expect(result?.preferences.notificationsEnabled).toBe(false)
    expect(result?.model.apiKey).toBe('current-chat-key')
    expect(result?.model.maxTokens).toBe(1)
    expect(result?.model.temperature).toBe(2)
    expect(result?.memoryModel.apiKey).toBe('current-memory-key')
    expect(result?.memoryModel.temperature).toBe(0)
  })
})
