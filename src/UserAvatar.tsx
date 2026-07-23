import { UserRound } from 'lucide-react'

export function UserAvatar({ name, avatar, size = 'md' }: {
  name: string
  avatar: string
  size?: 'sm' | 'md' | 'lg'
}) {
  const label = `${name || '用户'}的头像`

  return <div className={`user-avatar user-avatar-${size}`} role="img" aria-label={label}>
    {avatar ? <img src={avatar} alt="" /> : <UserRound aria-hidden="true" />}
  </div>
}
