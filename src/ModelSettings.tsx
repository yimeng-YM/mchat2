import { useState } from 'react'
import { CheckCircle2, ChevronDown, ChevronUp, Eye, EyeOff, ListRestart, LoaderCircle, MessageSquare, PlugZap, Save } from 'lucide-react'
import {
  fetchModelList, loadModelConfig, saveModelConfig, testModelConnection,
  type ModelConfig,
} from './ai-service'
import { ModelPicker } from './ModelPicker'
import { loadMemoryModelConfig, saveMemoryModelConfig, type MemoryModelConfig } from './preferences'
import { rangeProgressStyle } from './range-style'

export function ModelSettings() {
  const [config, setConfig] = useState<ModelConfig>(loadModelConfig)
  const [showKey, setShowKey] = useState(false)
  const [testing, setTesting] = useState(false)
  const [fetchingModels, setFetchingModels] = useState(false)
  const [status, setStatus] = useState('')
  const [memoryConfig, setMemoryConfig] = useState<MemoryModelConfig>(loadMemoryModelConfig)
  const [showMemoryModel, setShowMemoryModel] = useState(false)
  const [showMemoryKey, setShowMemoryKey] = useState(false)
  const [memoryStatus, setMemoryStatus] = useState('')

  const update = <K extends keyof ModelConfig>(key: K, value: ModelConfig[K]) => {
    setConfig(current => ({ ...current, [key]: value }))
    setStatus('')
  }

  const updateMemoryConfig = <K extends keyof MemoryModelConfig>(key: K, value: MemoryModelConfig[K]) => {
    setMemoryConfig(current => ({ ...current, [key]: value }))
    setMemoryStatus('')
  }

  const saveMemoryModel = async () => {
    await saveMemoryModelConfig(memoryConfig)
    setMemoryStatus('记忆模型设置已保存')
  }

  const save = async () => {
    await saveModelConfig(config)
    setStatus('设置已保存')
  }

  const test = async () => {
    await saveModelConfig(config)
    setTesting(true)
    setStatus('')
    try {
      const reply = await testModelConnection(config)
      setStatus(`连接成功 · ${reply}`)
    } catch (error) {
      setStatus(error instanceof Error ? error.message : '连接失败')
    } finally {
      setTesting(false)
    }
  }

  const loadModels = async () => {
    setFetchingModels(true)
    setStatus('')
    try {
      const models = await fetchModelList(config)
      const next = { ...config, models }
      setConfig(next)
      await saveModelConfig(next)
      setStatus(`已获取并保存 ${models.length} 个模型`)
    } catch (error) {
      setStatus(error instanceof Error ? error.message : '获取模型列表失败')
    } finally {
      setFetchingModels(false)
    }
  }

  const temperatureStyle = rangeProgressStyle(config.temperature, 0, 2)
  const memoryTemperatureStyle = rangeProgressStyle(memoryConfig.temperature, 0, 2)
  const contextCountStyle = rangeProgressStyle(config.contextMessageCount, 10, 120)
  const usesCustomMemoryModel = Boolean(memoryConfig.baseUrl.trim() || memoryConfig.apiKey.trim() || memoryConfig.model.trim())

  return <div className="model-settings">
    <section className="setting-group">
      <div className="model-heading"><div><h2>API 设置</h2><p>支持 OpenAI 兼容的 Chat Completions 接口</p></div><span>仅保存在本机</span></div>
      <div className="model-form">
        <label className="field wide"><span>请求地址</span><input value={config.baseUrl} onChange={event => update('baseUrl', event.target.value)} placeholder="https://api.openai.com/v1" /></label>
        <label className="field wide"><span>API Key</span><div className="secret-input"><input type={showKey ? 'text' : 'password'} value={config.apiKey} onChange={event => update('apiKey', event.target.value)} placeholder="sk-..." autoComplete="off" /><button type="button" onClick={() => setShowKey(value => !value)} aria-label={showKey ? '隐藏 API Key' : '显示 API Key'}>{showKey ? <EyeOff /> : <Eye />}</button></div></label>
        <div className="field wide"><label htmlFor="model-name">模型名称</label><div className="model-picker-row"><ModelPicker value={config.model} models={config.models} onChange={value => update('model', value)} /><button className="model-fetch-button" type="button" onClick={() => void loadModels()} disabled={fetchingModels}>{fetchingModels ? <LoaderCircle className="spin" /> : <ListRestart />}{config.models.length ? `更新列表 (${config.models.length})` : '获取模型列表'}</button></div></div>
        <label className="field wide"><span>温度</span><div className="range-field"><input className="range-input temperature-range" style={temperatureStyle} type="range" min="0" max="2" step="0.01" value={config.temperature} onChange={event => update('temperature', Number(event.target.value))} /><input className="temperature-value" type="number" min="0" max="2" step="0.01" value={config.temperature} onChange={event => update('temperature', Math.min(2, Math.max(0, Number(event.target.value))))} aria-label="温度数值" /></div></label>
        <label className="field"><span>Max tokens</span><input type="number" min="1" max="128000" value={config.maxTokens} onChange={event => update('maxTokens', Number(event.target.value))} /></label>
      </div>
      <div className="model-actions">
        <span className={status.startsWith('连接成功') || status.startsWith('已获取') || status === '设置已保存' ? 'success' : ''}>{status && <CheckCircle2 />}{status}</span>
        <button className="secondary" onClick={() => void test()} disabled={testing}>{testing ? <LoaderCircle className="spin" /> : <PlugZap />}测试连接</button>
        <button className="primary" onClick={() => void save()}><Save />保存设置</button>
      </div>
    </section>

    <section className="setting-group">
      <div className="model-heading"><div><h2>上下文消息数</h2><p>同时用于聊天回复与长期记忆提取，数值越高会消耗更多上下文。</p></div><span>{config.contextMessageCount} 条</span></div>
      <div className="setting-row context-count-row">
        <MessageSquare />
        <label className="context-count-control">
          <span className="sr-only">上下文消息数</span>
          <input className="range-input" style={contextCountStyle} type="range" min="10" max="120" step="1" value={config.contextMessageCount}
            onChange={event => update('contextMessageCount', Number(event.target.value))} />
          <input type="number" min="10" max="120" step="1" value={config.contextMessageCount}
            onChange={event => update('contextMessageCount', Math.max(10, Math.min(120, Math.round(Number(event.target.value) || 10))))}
            aria-label="上下文消息数值" />
          <span>条</span>
        </label>
      </div>
    </section>

    <section className="setting-group">
      <button className="collapsible-header" onClick={() => setShowMemoryModel(value => !value)} aria-expanded={showMemoryModel}>
        <div><h2>记忆提取模型</h2><p>可单独配置；独立配置中的空字段会继续继承聊天模型。</p></div>
        <span className={`memory-model-mode ${usesCustomMemoryModel ? 'custom' : ''}`}>{usesCustomMemoryModel ? '独立模型' : '继承聊天模型'}</span>
        {showMemoryModel ? <ChevronUp /> : <ChevronDown />}
      </button>
      {showMemoryModel && <div className="model-form">
        <label className="field wide"><span>请求地址</span><input value={memoryConfig.baseUrl}
          onChange={event => updateMemoryConfig('baseUrl', event.target.value)}
          placeholder="留空使用聊天模型" /></label>
        <label className="field wide"><span>API Key</span><div className="secret-input">
          <input type={showMemoryKey ? 'text' : 'password'} value={memoryConfig.apiKey}
            onChange={event => updateMemoryConfig('apiKey', event.target.value)}
            placeholder="留空使用聊天模型" autoComplete="off" />
          <button type="button" onClick={() => setShowMemoryKey(v => !v)}
            aria-label={showMemoryKey ? '隐藏 API Key' : '显示 API Key'}>
            {showMemoryKey ? <EyeOff /> : <Eye />}
          </button>
        </div></label>
        <div className="field wide"><label>模型名称</label><ModelPicker value={memoryConfig.model} models={config.models} onChange={value => updateMemoryConfig('model', value)} /></div>
        <label className="field wide"><span>温度</span><div className="range-field">
          <input className="range-input temperature-range" style={memoryTemperatureStyle} type="range" min="0" max="2" step="0.01"
            value={memoryConfig.temperature}
            onChange={event => updateMemoryConfig('temperature', Number(event.target.value))} />
          <input className="temperature-value" type="number" min="0" max="2" step="0.01"
            value={memoryConfig.temperature}
            onChange={event => updateMemoryConfig('temperature', Math.min(2, Math.max(0, Number(event.target.value))))}
            aria-label="记忆模型温度数值" />
        </div></label>
        <div className="memory-model-actions">
          <span className={memoryStatus ? 'success' : ''}>{memoryStatus && <CheckCircle2 />}{memoryStatus}</span>
          <button className="secondary" onClick={() => void saveMemoryModel()}><Save />保存记忆模型</button>
        </div>
      </div>}
    </section>
  </div>
}
