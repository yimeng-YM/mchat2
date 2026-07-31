import { useState } from 'react'
import { CheckCircle2, ChevronDown, ChevronUp, CircleAlert, Eye, EyeOff, Info, ListRestart, LoaderCircle, MessageSquare, PlugZap, Save, Wifi } from 'lucide-react'
import {
  fetchModelList, inspectModelEndpoint, loadModelConfig, normalizeModelBaseUrl, saveModelConfig, testModelConnection,
  type ModelConfig,
} from './ai-service'
import { ModelPicker } from './ModelPicker'
import { loadMemoryModelConfig, saveMemoryModelConfig, type MemoryModelConfig } from './preferences'
import { rangeProgressStyle } from './range-style'

type ModelStatus = { kind: 'idle' | 'info' | 'success' | 'error'; text: string }
const idleStatus: ModelStatus = { kind: 'idle', text: '' }

function endpointInfo(value: string) {
  if (!value.trim()) return null
  try {
    return inspectModelEndpoint(value)
  } catch {
    return null
  }
}

export function ModelSettings() {
  const [config, setConfig] = useState<ModelConfig>(loadModelConfig)
  const [showKey, setShowKey] = useState(false)
  const [testing, setTesting] = useState(false)
  const [fetchingModels, setFetchingModels] = useState(false)
  const [status, setStatus] = useState<ModelStatus>(idleStatus)
  const [memoryConfig, setMemoryConfig] = useState<MemoryModelConfig>(loadMemoryModelConfig)
  const [showMemoryModel, setShowMemoryModel] = useState(false)
  const [showMemoryKey, setShowMemoryKey] = useState(false)
  const [memoryStatus, setMemoryStatus] = useState<ModelStatus>(idleStatus)

  const update = <K extends keyof ModelConfig>(key: K, value: ModelConfig[K]) => {
    setConfig(current => ({ ...current, [key]: value }))
    setStatus(idleStatus)
  }

  const updateMemoryConfig = <K extends keyof MemoryModelConfig>(key: K, value: MemoryModelConfig[K]) => {
    setMemoryConfig(current => ({ ...current, [key]: value }))
    setMemoryStatus(idleStatus)
  }

  const saveMemoryModel = async () => {
    try {
      const next = {
        ...memoryConfig,
        baseUrl: memoryConfig.baseUrl.trim() ? normalizeModelBaseUrl(memoryConfig.baseUrl) : '',
      }
      setMemoryConfig(next)
      await saveMemoryModelConfig(next)
      setMemoryStatus({ kind: 'success', text: '记忆模型设置已保存' })
    } catch (error) {
      setMemoryStatus({ kind: 'error', text: error instanceof Error ? error.message : '保存失败' })
    }
  }

  const save = async () => {
    try {
      const next = { ...config, baseUrl: normalizeModelBaseUrl(config.baseUrl) }
      setConfig(next)
      await saveModelConfig(next)
      setStatus({ kind: 'success', text: '设置已保存' })
    } catch (error) {
      setStatus({ kind: 'error', text: error instanceof Error ? error.message : '保存失败' })
    }
  }

  const test = async () => {
    setTesting(true)
    setStatus({ kind: 'info', text: '正在检查模型列表并发送测试消息…' })
    try {
      const report = await testModelConnection(config)
      const next = {
        ...config,
        baseUrl: report.baseUrl,
        model: report.model,
        models: report.models.length ? report.models : config.models,
      }
      setConfig(next)
      await saveModelConfig(next)
      const listNote = report.models.length ? ` · ${report.models.length} 个模型` : ' · 模型列表接口不可用'
      setStatus({
        kind: 'success',
        text: `连接成功 · ${report.model} · ${report.latencyMs}ms${listNote} · ${report.reply}`,
      })
    } catch (error) {
      setStatus({ kind: 'error', text: error instanceof Error ? error.message : '连接失败' })
    } finally {
      setTesting(false)
    }
  }

  const loadModels = async () => {
    setFetchingModels(true)
    setStatus({ kind: 'info', text: '正在获取模型列表…' })
    try {
      const baseUrl = normalizeModelBaseUrl(config.baseUrl)
      const models = await fetchModelList({ ...config, baseUrl })
      const next = { ...config, baseUrl, models, model: config.model || models[0] }
      setConfig(next)
      await saveModelConfig(next)
      setStatus({ kind: 'success', text: `已获取并保存 ${models.length} 个模型` })
    } catch (error) {
      setStatus({ kind: 'error', text: error instanceof Error ? error.message : '获取模型列表失败' })
    } finally {
      setFetchingModels(false)
    }
  }

  const temperatureStyle = rangeProgressStyle(config.temperature, 0, 2)
  const memoryTemperatureStyle = rangeProgressStyle(memoryConfig.temperature, 0, 2)
  const contextCountStyle = rangeProgressStyle(config.contextMessageCount, 10, 120)
  const usesCustomMemoryModel = Boolean(memoryConfig.baseUrl.trim() || memoryConfig.apiKey.trim() || memoryConfig.model.trim())
  const currentEndpoint = endpointInfo(config.baseUrl)
  const currentMemoryEndpoint = endpointInfo(memoryConfig.baseUrl)

  return <div className="model-settings">
    <section className="setting-group">
      <div className="model-heading"><div><h2>API 设置</h2><p>支持 OpenAI 兼容的 Chat Completions 接口</p></div><span>仅保存在本机</span></div>
      <div className="model-form">
        <label className="field wide"><span>请求地址 {currentEndpoint?.isLan && <b>局域网</b>}</span><input value={config.baseUrl} onChange={event => update('baseUrl', event.target.value)} placeholder="http://192.168.1.100:17892/v1" inputMode="url" autoCapitalize="none" autoCorrect="off" spellCheck={false} /></label>
        {currentEndpoint?.isLan && <div className={`lan-endpoint-notice wide ${currentEndpoint.isLoopback ? 'danger' : ''}`}>
          {currentEndpoint.isLoopback ? <CircleAlert /> : <Wifi />}
          <div>
            <strong>{currentEndpoint.isLoopback ? '手机端不能使用本机回环地址' : `已识别局域网${currentEndpoint.isCleartext ? ' HTTP' : ''} 地址`}</strong>
            <span>{currentEndpoint.isLoopback
              ? 'localhost/127.0.0.1 会指向手机自身，请改填运行 API 的电脑局域网 IP。'
              : `请保持手机与电脑在同一网络，并让服务监听 0.0.0.0、放行 Windows 防火墙端口。${currentEndpoint.isCleartext ? 'HTTP 不加密，只应在可信网络使用。' : ''}`}</span>
            {!currentEndpoint.isLoopback && <code>{currentEndpoint.normalizedBaseUrl}</code>}
          </div>
        </div>}
        <label className="field wide"><span>API Key</span><div className="secret-input"><input type={showKey ? 'text' : 'password'} value={config.apiKey} onChange={event => update('apiKey', event.target.value)} placeholder="sk-..." autoComplete="off" /><button type="button" onClick={() => setShowKey(value => !value)} aria-label={showKey ? '隐藏 API Key' : '显示 API Key'}>{showKey ? <EyeOff /> : <Eye />}</button></div></label>
        <div className="field wide"><label htmlFor="model-name">模型名称</label><div className="model-picker-row"><ModelPicker value={config.model} models={config.models} onChange={value => update('model', value)} /><button className="model-fetch-button" type="button" onClick={() => void loadModels()} disabled={fetchingModels}>{fetchingModels ? <LoaderCircle className="spin" /> : <ListRestart />}{config.models.length ? `更新列表 (${config.models.length})` : '获取模型列表'}</button></div></div>
        <label className="field wide"><span>温度</span><div className="range-field"><input className="range-input temperature-range" style={temperatureStyle} type="range" min="0" max="2" step="0.01" value={config.temperature} onChange={event => update('temperature', Number(event.target.value))} /><input className="temperature-value" type="number" min="0" max="2" step="0.01" value={config.temperature} onChange={event => update('temperature', Math.min(2, Math.max(0, Number(event.target.value))))} aria-label="温度数值" /></div></label>
        <label className="field"><span>Max tokens</span><input type="number" min="1" max="128000" value={config.maxTokens} onChange={event => update('maxTokens', Number(event.target.value))} /></label>
      </div>
      <div className="model-actions">
        <span className={status.kind}>{status.kind === 'success' && <CheckCircle2 />}{status.kind === 'error' && <CircleAlert />}{status.kind === 'info' && <Info />}{status.text}</span>
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
        <label className="field wide"><span>请求地址 {currentMemoryEndpoint?.isLan && <b>局域网</b>}</span><input value={memoryConfig.baseUrl}
          onChange={event => updateMemoryConfig('baseUrl', event.target.value)}
          placeholder="留空使用聊天模型" inputMode="url" autoCapitalize="none" autoCorrect="off" spellCheck={false} /></label>
        {currentMemoryEndpoint?.isLoopback && <div className="lan-endpoint-notice danger wide"><CircleAlert /><div><strong>手机端不能使用 localhost/127.0.0.1</strong><span>请改填运行记忆模型 API 的电脑局域网 IP。</span></div></div>}
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
          <span className={memoryStatus.kind}>{memoryStatus.kind === 'success' && <CheckCircle2 />}{memoryStatus.kind === 'error' && <CircleAlert />}{memoryStatus.text}</span>
          <button className="secondary" onClick={() => void saveMemoryModel()}><Save />保存记忆模型</button>
        </div>
      </div>}
    </section>
  </div>
}
