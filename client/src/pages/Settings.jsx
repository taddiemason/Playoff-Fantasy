import { useState } from 'react'
import { api } from '../api.js'
import { useAuth } from '../auth/AuthContext.jsx'
import Avatar from '../components/Avatar.jsx'

export default function Settings() {
  const { user, setUser } = useAuth()
  const [username, setUsername] = useState(user.username)
  const [email, setEmail] = useState(user.email)
  const [avatarUrl, setAvatarUrl] = useState(user.avatar_url || '')
  const [profileMsg, setProfileMsg] = useState(null)
  const [savingProfile, setSavingProfile] = useState(false)

  const [currentPassword, setCurrentPassword] = useState('')
  const [newPassword, setNewPassword] = useState('')
  const [confirm, setConfirm] = useState('')
  const [pwMsg, setPwMsg] = useState(null)
  const [savingPw, setSavingPw] = useState(false)

  async function saveProfile(e) {
    e.preventDefault()
    setProfileMsg(null)
    setSavingProfile(true)
    try {
      const { user: updated } = await api.me.update({ username: username.trim(), email: email.trim(), avatar_url: avatarUrl.trim() })
      setUser(updated)
      setProfileMsg({ type: 'info', text: 'Profile saved' })
    } catch (err) {
      setProfileMsg({ type: 'error', text: err.message })
    } finally {
      setSavingProfile(false)
    }
  }

  async function savePassword(e) {
    e.preventDefault()
    setPwMsg(null)
    if (newPassword !== confirm) {
      setPwMsg({ type: 'error', text: 'New passwords do not match' })
      return
    }
    setSavingPw(true)
    try {
      await api.me.changePassword(currentPassword, newPassword)
      setPwMsg({ type: 'info', text: 'Password updated' })
      setCurrentPassword(''); setNewPassword(''); setConfirm('')
    } catch (err) {
      setPwMsg({ type: 'error', text: err.message })
    } finally {
      setSavingPw(false)
    }
  }

  const preview = { username: username || user.username, avatar_url: avatarUrl }

  return (
    <div>
      <div className="page-header">
        <div className="page-title">Account Settings</div>
      </div>

      <div className="settings-grid">
        <form className="card settings-card" onSubmit={saveProfile}>
          <div className="settings-card-title">Profile</div>
          <div className="settings-avatar-row">
            <Avatar user={preview} size={64} />
            <div className="settings-avatar-hint">
              Your avatar uses your initials. Paste an image URL below to use a custom picture.
            </div>
          </div>
          {profileMsg && <div className={`alert alert-${profileMsg.type}`}>{profileMsg.text}</div>}
          <div className="form-group">
            <label className="form-label">Username</label>
            <input className="form-input" value={username} onChange={(e) => setUsername(e.target.value)} />
          </div>
          <div className="form-group">
            <label className="form-label">Email</label>
            <input className="form-input" type="email" value={email} onChange={(e) => setEmail(e.target.value)} />
          </div>
          <div className="form-group">
            <label className="form-label">Avatar Image URL (optional)</label>
            <input className="form-input" value={avatarUrl} onChange={(e) => setAvatarUrl(e.target.value)} placeholder="https://…" />
          </div>
          <button className="btn btn-primary" type="submit" disabled={savingProfile}>
            {savingProfile ? 'Saving…' : 'Save Profile'}
          </button>
        </form>

        <form className="card settings-card" onSubmit={savePassword}>
          <div className="settings-card-title">Change Password</div>
          {pwMsg && <div className={`alert alert-${pwMsg.type}`}>{pwMsg.text}</div>}
          <div className="form-group">
            <label className="form-label">Current Password</label>
            <input className="form-input" type="password" value={currentPassword} onChange={(e) => setCurrentPassword(e.target.value)} />
          </div>
          <div className="form-group">
            <label className="form-label">New Password</label>
            <input className="form-input" type="password" value={newPassword} onChange={(e) => setNewPassword(e.target.value)} placeholder="At least 8 characters" />
          </div>
          <div className="form-group">
            <label className="form-label">Confirm New Password</label>
            <input className="form-input" type="password" value={confirm} onChange={(e) => setConfirm(e.target.value)} />
          </div>
          <button className="btn btn-primary" type="submit" disabled={savingPw}>
            {savingPw ? 'Saving…' : 'Update Password'}
          </button>
        </form>
      </div>
    </div>
  )
}
