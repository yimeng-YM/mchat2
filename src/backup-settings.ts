import type { ModelConfig } from './ai-service'
import type { AppPreferences, MemoryModelConfig } from './preferences'

export type BackupSettings = {
  preferences: AppPreferences
  model: Omit<ModelConfig, 'apiKey'>
  memoryModel: Omit<MemoryModelConfig, 'apiKey'>
}

export function createBackupSettings(
  preferences: AppPreferences,
  model: ModelConfig,
  memoryModel: MemoryModelConfig,
): BackupSettings {
  const { apiKey: _chatKey, ...safeModel } = model
  const { apiKey: _memoryKey, ...safeMemoryModel } = memoryModel
  return { preferences, model: safeModel, memoryModel: safeMemoryModel }
}

function numberIn(value: unknown, fallback: number, min: number, max: number) {
  const number = Number(value)
  return Number.isFinite(number) ? Math.max(min, Math.min(max, number)) : fallback
}

function safeColor(value: unknown, fallback: string) {
  return typeof value === 'string' && /^#[0-9a-f]{6}$/i.test(value) ? value.toUpperCase() : fallback
}

export function normalizeBackupSettings(
  raw: unknown,
  currentPreferences: AppPreferences,
  currentModel: ModelConfig,
  currentMemoryModel: MemoryModelConfig,
) {
  if (!raw || typeof raw !== 'object') return null
  const input = raw as Partial<BackupSettings>
  const preference = input.preferences && typeof input.preferences === 'object'
    ? input.preferences as Partial<AppPreferences>
    : {}
  const model = input.model && typeof input.model === 'object'
    ? input.model as Partial<ModelConfig>
    : {}
  const memoryModel = input.memoryModel && typeof input.memoryModel === 'object'
    ? input.memoryModel as Partial<MemoryModelConfig>
    : {}
  const preferences: AppPreferences = {
    colorMode: preference.colorMode === 'dark' ? 'dark' : 'light',
    interfaceStyle: preference.interfaceStyle === 'classic' ? 'classic' : 'glass',
    accentColor: safeColor(preference.accentColor, currentPreferences.accentColor),
    myBubbleColor: safeColor(preference.myBubbleColor, currentPreferences.myBubbleColor),
    theirBubbleColor: safeColor(preference.theirBubbleColor, currentPreferences.theirBubbleColor),
    myBubbleOpacity: numberIn(preference.myBubbleOpacity, currentPreferences.myBubbleOpacity, 0, 100),
    theirBubbleOpacity: numberIn(preference.theirBubbleOpacity, currentPreferences.theirBubbleOpacity, 0, 100),
    topBarOpacity: numberIn(preference.topBarOpacity, currentPreferences.topBarOpacity, 20, 100),
    navigationOpacity: numberIn(preference.navigationOpacity, currentPreferences.navigationOpacity, 20, 100),
    inputOpacity: numberIn(preference.inputOpacity, currentPreferences.inputOpacity, 20, 100),
    reduceMotion: preference.reduceMotion === true,
    typingStatus: preference.typingStatus !== false,
    messageSound: preference.messageSound === true,
    notificationsEnabled: false,
    notificationPreview: preference.notificationPreview !== false,
    memoryExtractionInterval: Math.round(numberIn(preference.memoryExtractionInterval, currentPreferences.memoryExtractionInterval, 0, 20)),
    userName: typeof preference.userName === 'string' && preference.userName.trim()
      ? preference.userName.trim().slice(0, 32)
      : currentPreferences.userName,
    userAvatar: typeof preference.userAvatar === 'string' ? preference.userAvatar : currentPreferences.userAvatar,
  }
  const restoredModel: ModelConfig = {
    ...currentModel,
    baseUrl: typeof model.baseUrl === 'string' ? model.baseUrl.slice(0, 2048) : currentModel.baseUrl,
    model: typeof model.model === 'string' ? model.model.slice(0, 256) : currentModel.model,
    models: Array.isArray(model.models) ? model.models.filter((item): item is string => typeof item === 'string').slice(0, 1000) : currentModel.models,
    temperature: numberIn(model.temperature, currentModel.temperature, 0, 2),
    maxTokens: Math.round(numberIn(model.maxTokens, currentModel.maxTokens, 1, 128_000)),
    queueMode: model.queueMode === 'manual' ? 'manual' : 'auto',
    queueDelaySeconds: Math.round(numberIn(model.queueDelaySeconds, currentModel.queueDelaySeconds, 1, 15)),
    contextMessageCount: Math.round(numberIn(model.contextMessageCount, currentModel.contextMessageCount, 10, 120)),
  }
  const restoredMemoryModel: MemoryModelConfig = {
    ...currentMemoryModel,
    baseUrl: typeof memoryModel.baseUrl === 'string' ? memoryModel.baseUrl.slice(0, 2048) : currentMemoryModel.baseUrl,
    model: typeof memoryModel.model === 'string' ? memoryModel.model.slice(0, 256) : currentMemoryModel.model,
    temperature: numberIn(memoryModel.temperature, currentMemoryModel.temperature, 0, 2),
  }
  return { preferences, model: restoredModel, memoryModel: restoredMemoryModel }
}
