import { useState, useEffect, useRef } from 'react'
import { useOutletContext, useParams } from 'react-router-dom'
import { useAuth } from '../auth/AuthContext.jsx'
import useChatSocket from '../hooks/useChatSocket.js'

const ALLOWED_EMOJIS = ['👍', '❤️', '😂', '🔥', '😮', '👀']

function renderBody(text, currentUsername) {
  const escaped = text
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
  return escaped
    .replace(/\*\*(.+?)\*\*/g, '<strong>$1</strong>')
    .replace(/_(.+?)_/g, '<em>$1</em>')
    .replace(/@(\w+)/g, (match, uname) => {
      const isMe = currentUsername && uname.toLowerCase() === currentUsername.toLowerCase()
      return `<span class="chat-mention${isMe ? ' chat-mention-me' : ''}">${match}</span>`
    })
}

function formatTime(iso) {
  return new Date(iso).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' })
}

function MessageRow({ msg, currentUser, isCommissioner, onDelete, onReact, onPin, onUnpin }) {
  const [showPicker, setShowPicker] = useState(false)
  const canDelete = currentUser?.id === msg.userId || isCommissioner

  return (
    <div className="chat-msg" onMouseLeave={() => setShowPicker(false)}>
      <div className="chat-avatar">{(msg.username || '?')[0].toUpperCase()}</div>
      <div className="chat-msg-body">
        <div className="chat-msg-meta">
          <span className="chat-username">{msg.username}</span>
          <span className="chat-time">{formatTime(msg.createdAt)}</span>
          <span className="chat-msg-actions">
            {canDelete && (
              <button className="chat-icon-btn" onClick={() => onDelete(msg.id)} title="Delete">✕</button>
            )}
            {isCommissioner && !msg.pinned && (
              <button className="chat-icon-btn" onClick={() => onPin(msg.id)} title="Pin">📌</button>
            )}
          </span>
        </div>
        <div
          className="chat-text"
          dangerouslySetInnerHTML={{ __html: renderBody(msg.body, currentUser?.username) }}
        />
        <div className="chat-reactions">
          {(msg.reactions || []).map(r => (
            <button
              key={r.emoji}
              className={`reaction-chip${r.userReacted ? ' reacted' : ''}`}
              onClick={() => onReact(msg.id, r.emoji)}
            >
              {r.emoji} {r.count}
            </button>
          ))}
          <div className="reaction-add-wrap">
            <button
              className="reaction-add-btn"
              onClick={() => setShowPicker(p => !p)}
              title="Add reaction"
            >+</button>
            {showPicker && (
              <div className="emoji-picker">
                {ALLOWED_EMOJIS.map(e => (
                  <button key={e} className="emoji-opt" onClick={() => { onReact(msg.id, e); setShowPicker(false) }}>
                    {e}
                  </button>
                ))}
              </div>
            )}
          </div>
        </div>
      </div>
    </div>
  )
}

export default function ChatPage() {
  const { leagueId } = useParams()
  const { league } = useOutletContext()
  const { user } = useAuth()
  const {
    messages, pinned, connected, error,
    sendMessage, deleteMessage, reactToMessage, pinMessage, unpinMessage,
  } = useChatSocket(leagueId)
  const [body, setBody] = useState('')
  const feedRef = useRef(null)
  const isCommissioner = league?.role === 'commissioner'

  useEffect(() => {
    localStorage.setItem(`chatLastRead_${leagueId}`, new Date().toISOString())
  }, [leagueId])

  useEffect(() => {
    if (feedRef.current) {
      feedRef.current.scrollTop = feedRef.current.scrollHeight
    }
  }, [messages.length])

  function handleKeyDown(e) {
    if (e.key === 'Enter' && !e.shiftKey) {
      e.preventDefault()
      const trimmed = body.trim()
      if (trimmed) { sendMessage(trimmed); setBody('') }
    }
  }

  return (
    <div className="chat-page">
      {pinned && (
        <div className="chat-pinned-bar">
          <span className="chat-pinned-icon">📌</span>
          <span
            className="chat-pinned-body"
            dangerouslySetInnerHTML={{ __html: renderBody(pinned.body, user?.username) }}
          />
          {isCommissioner && (
            <button className="chat-icon-btn chat-unpin-btn" onClick={() => unpinMessage(pinned.id)}>
              Unpin
            </button>
          )}
        </div>
      )}

      <div className="chat-feed" ref={feedRef}>
        {messages.length === 0 && (
          <div className="chat-empty">No messages yet — say something!</div>
        )}
        {messages.map(msg => (
          <MessageRow
            key={msg.id}
            msg={msg}
            currentUser={user}
            isCommissioner={isCommissioner}
            onDelete={deleteMessage}
            onReact={reactToMessage}
            onPin={pinMessage}
            onUnpin={unpinMessage}
          />
        ))}
      </div>

      {error && <div className="alert alert-error" style={{ margin: '0 16px 8px' }}>{error}</div>}

      <div className="chat-input-area">
        <div className={`chat-conn-dot ${connected ? 'conn' : 'disconn'}`} title={connected ? 'Connected' : 'Connecting…'} />
        <textarea
          className="chat-input"
          value={body}
          onChange={e => setBody(e.target.value)}
          onKeyDown={handleKeyDown}
          placeholder="Message… (Enter to send · Shift+Enter for newline · **bold** · _italic_ · @mention)"
          rows={2}
          maxLength={2000}
        />
      </div>
    </div>
  )
}
