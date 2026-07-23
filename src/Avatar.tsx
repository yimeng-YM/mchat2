import type { Role } from './chat-types'

export function Avatar({ role, size = 'md' }: { role: Role; size?: 'sm' | 'md' | 'lg' | 'xl' }) {
  return <div className={`avatar avatar-${size}`}><img src={role.avatar} alt={role.name} />{role.online && <i />}</div>
}
