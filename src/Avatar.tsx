import type { Role } from './chat-types'
import { StoredImage } from './StoredImage'

export function Avatar({ role, size = 'md' }: { role: Role; size?: 'sm' | 'md' | 'lg' | 'xl' }) {
  return <div className={`avatar avatar-${size}`}><StoredImage source={role.avatar} alt={role.name} />{role.online && <i />}</div>
}
