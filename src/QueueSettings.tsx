import { MessageSquareMore, TimerReset } from 'lucide-react'
import { useState, type CSSProperties } from 'react'
import { loadModelConfig, saveModelConfig, type ModelConfig } from './ai-service'

export function QueueSettings() {
  const [config, setConfig] = useState<ModelConfig>(loadModelConfig)

  const update = <K extends keyof ModelConfig>(key: K, value: ModelConfig[K]) => {
    setConfig(current => {
      const next = { ...current, [key]: value }
      saveModelConfig(next)
      return next
    })
  }
  const queueDelayStyle = { '--range-progress': `${(config.queueDelaySeconds - 1) / 14 * 100}%` } as CSSProperties

  return <div className="queue-settings chat-queue-settings">
    <div className="queue-settings-heading">
      <div><MessageSquareMore /><span><strong>消息等待队列</strong><small>把连续消息合并成一次模型请求</small></span></div>
      <span className="queue-mode-badge">{config.queueMode === 'auto' ? '自动' : '手动'}</span>
    </div>
    <div className="queue-mode-options" role="group" aria-label="消息队列模式">
      <button className={config.queueMode === 'auto' ? 'active' : ''} onClick={() => update('queueMode', 'auto')}><TimerReset /><span><strong>自动计时</strong><small>新消息会重新开始倒计时</small></span></button>
      <button className={config.queueMode === 'manual' ? 'active' : ''} onClick={() => update('queueMode', 'manual')}><MessageSquareMore /><span><strong>手动提交</strong><small>双击发送按钮提交完整队列</small></span></button>
    </div>
    {config.queueMode === 'auto' && <label className="queue-delay"><span>等待时间</span><input className="range-input" style={queueDelayStyle} type="range" min="1" max="15" step="1" value={config.queueDelaySeconds} onChange={event => update('queueDelaySeconds', Number(event.target.value))} aria-label="自动队列等待时间" /><output>{config.queueDelaySeconds} 秒</output></label>}
  </div>
}
