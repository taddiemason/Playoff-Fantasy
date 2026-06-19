// Generated colored-initials avatar, with an optional external image URL.
function colorFor(str) {
  let h = 0
  for (let i = 0; i < str.length; i++) h = str.charCodeAt(i) + ((h << 5) - h)
  return `hsl(${Math.abs(h) % 360} 52% 42%)`
}

export default function Avatar({ user, size = 36 }) {
  const name = user?.username || '?'
  const url = user?.avatar_url
  if (url) {
    return (
      <img
        className="avatar"
        src={url}
        alt={name}
        style={{ width: size, height: size }}
        onError={(e) => { e.currentTarget.style.display = 'none' }}
      />
    )
  }
  const initials = name.slice(0, 2).toUpperCase()
  return (
    <div
      className="avatar avatar-initials"
      style={{ width: size, height: size, background: colorFor(name), fontSize: Math.round(size * 0.4) }}
    >
      {initials}
    </div>
  )
}
