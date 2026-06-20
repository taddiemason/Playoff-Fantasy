# League Chat Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Add real-time in-league chat with pinned announcements, emoji reactions, rich-text rendering, @mentions, and an unread badge on the nav link.

**Architecture:** A new `ChatRoom` Durable Object (one per league, keyed `league-{id}`) acts as a WebSocket hub, broadcasting mutations to all connected clients and writing through to D1. The worker validates auth via the existing `loadLeagueContext` helper and forwards user identity to the DO via custom request headers — the same pattern used by `DraftRoom` and `AuctionRoom`.

**Tech Stack:** Cloudflare Workers, D1 (SQLite), Durable Objects, React 18, React Router v6.

## Global Constraints

- All route conditions in `worker/index.js` must use `request.method`, never a bare `method` variable — `handleApi` does not define a shorthand and bare `method` causes a ReferenceError crashing all requests.
- Run `node --check worker/index.js` after every change to catch syntax errors.
- CSS uses variables: `--bg`, `--bg-card`, `--bg-input`, `--border`, `--primary`, `--text`, `--text-muted`, `--surface` — never hardcode colors.
- No new npm packages.

---

### Task 1: D1 Migration + wrangler.toml

**Files:**
- Create: `migrations/0017_chat.sql`
- Modify: `wrangler.toml`

**Interfaces:**
- Produces: `chat_messages` and `chat_reactions` D1 tables; `CHAT_ROOM` DO binding available to `worker/index.js`.

- [ ] **Step 1: Create migration file**

Create `migrations/0017_chat.sql`:

```sql
PRAGMA foreign_keys = ON;

CREATE TABLE IF NOT EXISTS chat_messages (
  id          INTEGER PRIMARY KEY AUTOINCREMENT,
  league_id   INTEGER NOT NULL,
  user_id     INTEGER NOT NULL,
  username    TEXT NOT NULL,
  body        TEXT NOT NULL,
  pinned      INTEGER NOT NULL DEFAULT 0,
  pinned_at   TEXT,
  deleted_at  TEXT,
  created_at  TEXT NOT NULL
);

CREATE INDEX IF NOT EXISTS idx_chat_messages_league ON chat_messages(league_id, created_at);

CREATE TABLE IF NOT EXISTS chat_reactions (
  id          INTEGER PRIMARY KEY AUTOINCREMENT,
  message_id  INTEGER NOT NULL REFERENCES chat_messages(id) ON DELETE CASCADE,
  user_id     INTEGER NOT NULL,
  emoji       TEXT NOT NULL,
  created_at  TEXT NOT NULL,
  UNIQUE(message_id, user_id, emoji)
);
```

- [ ] **Step 2: Add ChatRoom to wrangler.toml**

In `wrangler.toml`, append after the `AuctionRoom` blocks:

```toml
[[durable_objects.bindings]]
name = "CHAT_ROOM"
class_name = "ChatRoom"

[[migrations]]
tag = "v3"
new_classes = ["ChatRoom"]
```

- [ ] **Step 3: Apply migration to remote D1**

```bash
npx wrangler d1 migrations apply fantasyhockey --remote
```

Expected output includes `0017_chat.sql ✅`.

- [ ] **Step 4: Commit**

```bash
git add migrations/0017_chat.sql wrangler.toml
git commit -m "feat: chat D1 tables + ChatRoom DO binding"
```

---

### Task 2: ChatRoom Durable Object

**Files:**
- Create: `worker/chat-room.js`

**Interfaces:**
- Consumes: `env.DB` (D1), headers `X-League-Id`, `X-User-Id`, `X-Username`, `X-Is-Commissioner`
- Produces: `export class ChatRoom` used in Task 3

- [ ] **Step 1: Create worker/chat-room.js**

```js
export class ChatRoom {
  constructor(state, env) {
    this.state = state;
    this.env = env;
    this.clients = new Map(); // WebSocket -> { userId, username, isCommissioner, leagueId }
  }

  async fetch(request) {
    if (request.headers.get('Upgrade') !== 'websocket') {
      return new Response('Expected WebSocket upgrade', { status: 426 });
    }

    const leagueId = parseInt(request.headers.get('X-League-Id') || '0');
    const userId = parseInt(request.headers.get('X-User-Id') || '0');
    const username = request.headers.get('X-Username') || 'Unknown';
    const isCommissioner = request.headers.get('X-Is-Commissioner') === 'true';

    const pair = new WebSocketPair();
    const [client, server] = [pair[0], pair[1]];
    server.accept();

    const ctx = { userId, username, isCommissioner, leagueId };
    this.clients.set(server, ctx);

    const history = await this.loadHistory(leagueId);
    this.send(server, { type: 'history', messages: history });

    server.addEventListener('message', async (evt) => {
      try {
        const msg = JSON.parse(evt.data);
        await this.handleMessage(server, ctx, msg);
      } catch {
        this.send(server, { type: 'error', text: 'Invalid message' });
      }
    });

    server.addEventListener('close', () => this.clients.delete(server));
    server.addEventListener('error', () => this.clients.delete(server));

    return new Response(null, { status: 101, webSocket: client });
  }

  send(ws, data) {
    try { ws.send(JSON.stringify(data)); } catch {}
  }

  broadcast(data, leagueId) {
    for (const [ws, ctx] of this.clients) {
      if (ctx.leagueId === leagueId) this.send(ws, data);
    }
  }

  async loadHistory(leagueId) {
    const db = this.env.DB;
    const { results: msgs } = await db.prepare(
      `SELECT * FROM chat_messages WHERE league_id = ? AND deleted_at IS NULL ORDER BY created_at DESC LIMIT 50`
    ).bind(leagueId).all();

    if (!msgs || !msgs.length) return [];

    const ids = msgs.map(m => m.id);
    const ph = ids.map(() => '?').join(',');
    const { results: reactions } = await db.prepare(
      `SELECT message_id, emoji, user_id FROM chat_reactions WHERE message_id IN (${ph})`
    ).bind(...ids).all();

    const reactionsByMsg = {};
    for (const r of (reactions || [])) {
      if (!reactionsByMsg[r.message_id]) reactionsByMsg[r.message_id] = {};
      if (!reactionsByMsg[r.message_id][r.emoji]) reactionsByMsg[r.message_id][r.emoji] = [];
      reactionsByMsg[r.message_id][r.emoji].push(r.user_id);
    }

    return msgs.reverse().map(m => this.shapeMessage(m, reactionsByMsg[m.id] || {}));
  }

  shapeMessage(row, reactionMap) {
    return {
      id: row.id,
      userId: row.user_id,
      username: row.username,
      body: row.body,
      pinned: !!row.pinned,
      pinnedAt: row.pinned_at || null,
      createdAt: row.created_at,
      reactions: Object.entries(reactionMap).map(([emoji, userIds]) => ({
        emoji,
        count: userIds.length,
        reactorIds: userIds,
      })),
    };
  }

  async getReactions(db, messageId) {
    const { results } = await db.prepare(
      `SELECT emoji, user_id FROM chat_reactions WHERE message_id = ?`
    ).bind(messageId).all();
    const map = {};
    for (const r of (results || [])) {
      if (!map[r.emoji]) map[r.emoji] = [];
      map[r.emoji].push(r.user_id);
    }
    return Object.entries(map).map(([emoji, userIds]) => ({
      emoji,
      count: userIds.length,
      reactorIds: userIds,
    }));
  }

  async handleMessage(ws, ctx, msg) {
    const db = this.env.DB;
    const { userId, username, isCommissioner, leagueId } = ctx;

    if (msg.type === 'send') {
      const body = (msg.body || '').trim().slice(0, 2000);
      if (!body) return;
      const now = new Date().toISOString();
      const result = await db.prepare(
        `INSERT INTO chat_messages (league_id, user_id, username, body, created_at) VALUES (?, ?, ?, ?, ?)`
      ).bind(leagueId, userId, username, body, now).run();
      const newMsg = {
        id: result.meta.last_row_id,
        userId, username, body,
        pinned: false, pinnedAt: null, createdAt: now, reactions: [],
      };
      this.broadcast({ type: 'message', message: newMsg }, leagueId);
      return;
    }

    if (msg.type === 'delete') {
      const msgId = parseInt(msg.messageId);
      const row = await db.prepare(
        `SELECT user_id FROM chat_messages WHERE id = ? AND league_id = ? AND deleted_at IS NULL`
      ).bind(msgId, leagueId).first();
      if (!row) return;
      if (row.user_id !== userId && !isCommissioner) {
        this.send(ws, { type: 'error', text: 'Cannot delete this message' });
        return;
      }
      await db.prepare(`UPDATE chat_messages SET deleted_at = ? WHERE id = ?`)
        .bind(new Date().toISOString(), msgId).run();
      this.broadcast({ type: 'deleted', messageId: msgId }, leagueId);
      return;
    }

    if (msg.type === 'react') {
      const msgId = parseInt(msg.messageId);
      const ALLOWED = ['👍', '❤️', '😂', '🔥', '😮', '👀'];
      if (!ALLOWED.includes(msg.emoji)) return;
      const existing = await db.prepare(
        `SELECT id FROM chat_reactions WHERE message_id = ? AND user_id = ? AND emoji = ?`
      ).bind(msgId, userId, msg.emoji).first();
      if (existing) {
        await db.prepare(`DELETE FROM chat_reactions WHERE message_id = ? AND user_id = ? AND emoji = ?`)
          .bind(msgId, userId, msg.emoji).run();
      } else {
        await db.prepare(
          `INSERT INTO chat_reactions (message_id, user_id, emoji, created_at) VALUES (?, ?, ?, ?)`
        ).bind(msgId, userId, msg.emoji, new Date().toISOString()).run();
      }
      const reactions = await this.getReactions(db, msgId);
      this.broadcast({ type: 'reacted', messageId: msgId, reactions }, leagueId);
      return;
    }

    if (msg.type === 'pin') {
      if (!isCommissioner) { this.send(ws, { type: 'error', text: 'Commissioner only' }); return; }
      const msgId = parseInt(msg.messageId);
      const now = new Date().toISOString();
      await db.prepare(`UPDATE chat_messages SET pinned = 0, pinned_at = NULL WHERE league_id = ? AND pinned = 1`)
        .bind(leagueId).run();
      await db.prepare(`UPDATE chat_messages SET pinned = 1, pinned_at = ? WHERE id = ? AND league_id = ?`)
        .bind(now, msgId, leagueId).run();
      const row = await db.prepare(`SELECT * FROM chat_messages WHERE id = ?`).bind(msgId).first();
      if (row) {
        const reactions = await this.getReactions(db, msgId);
        const map = {};
        for (const r of reactions) map[r.emoji] = r.reactorIds;
        this.broadcast({ type: 'pinned', message: this.shapeMessage(row, map) }, leagueId);
      }
      return;
    }

    if (msg.type === 'unpin') {
      if (!isCommissioner) { this.send(ws, { type: 'error', text: 'Commissioner only' }); return; }
      const msgId = parseInt(msg.messageId);
      await db.prepare(`UPDATE chat_messages SET pinned = 0, pinned_at = NULL WHERE id = ? AND league_id = ?`)
        .bind(msgId, leagueId).run();
      this.broadcast({ type: 'unpinned', messageId: msgId }, leagueId);
      return;
    }
  }
}
```

- [ ] **Step 2: Syntax check**

```bash
node --check worker/chat-room.js
```

Expected: no output (clean).

- [ ] **Step 3: Commit**

```bash
git add worker/chat-room.js
git commit -m "feat: ChatRoom Durable Object"
```

---

### Task 3: Worker Routes + Export

**Files:**
- Modify: `worker/index.js` (lines 12–13 area for export; add routes near the auction WS route ~line 2009)

**Interfaces:**
- Consumes: `ChatRoom` from `./chat-room.js`; `loadLeagueContext`, `isCommissioner`, `parseId`, `json` helpers already in scope
- Produces: `GET /api/leagues/:id/chat/messages` and `GET /api/leagues/:id/chat/ws` routes

- [ ] **Step 1: Add ChatRoom export at top of worker/index.js**

Find the existing export lines near the top of `worker/index.js`:

```js
export { DraftRoom } from './draft-room.js';
export { AuctionRoom } from './auction-room.js';
```

Add immediately after `AuctionRoom` export:

```js
export { ChatRoom } from './chat-room.js';
```

- [ ] **Step 2: Add HTTP messages route**

Find the auction WebSocket proxy section. The auction WS route starts around:

```js
// GET /api/leagues/:id/auction/ws — WebSocket proxy
if (request.method === 'GET' && pathname.match(/^\/api\/leagues\/\d+\/auction\/ws$/)) {
```

Insert the following two chat routes **above** that auction block:

```js
  // GET /api/leagues/:id/chat/messages — load last 50 messages (HTTP, for initial load)
  const chatMsgsMatch = pathname.match(/^\/api\/leagues\/(\d+)\/chat\/messages$/);
  if (chatMsgsMatch && request.method === 'GET') {
    const leagueId = parseId(chatMsgsMatch[1]);
    const ctx = await loadLeagueContext(db, request, leagueId);
    if (ctx.error) return ctx.error;
    const limit = Math.min(parseInt(new URL(request.url).searchParams.get('limit') || '50'), 50);
    const { results: msgs } = await db.prepare(
      `SELECT * FROM chat_messages WHERE league_id = ? AND deleted_at IS NULL ORDER BY created_at DESC LIMIT ?`
    ).bind(leagueId, limit).all();
    if (!msgs || !msgs.length) return json([]);
    const ids = msgs.map(m => m.id);
    const ph = ids.map(() => '?').join(',');
    const { results: reactions } = await db.prepare(
      `SELECT message_id, emoji, user_id FROM chat_reactions WHERE message_id IN (${ph})`
    ).bind(...ids).all();
    const reactionsByMsg = {};
    for (const r of (reactions || [])) {
      if (!reactionsByMsg[r.message_id]) reactionsByMsg[r.message_id] = {};
      if (!reactionsByMsg[r.message_id][r.emoji]) reactionsByMsg[r.message_id][r.emoji] = [];
      reactionsByMsg[r.message_id][r.emoji].push(r.user_id);
    }
    return json(msgs.reverse().map(m => ({
      id: m.id,
      userId: m.user_id,
      username: m.username,
      body: m.body,
      pinned: !!m.pinned,
      pinnedAt: m.pinned_at || null,
      createdAt: m.created_at,
      reactions: Object.entries(reactionsByMsg[m.id] || {}).map(([emoji, userIds]) => ({
        emoji, count: userIds.length, reactorIds: userIds,
      })),
    })));
  }

  // GET /api/leagues/:id/chat/ws — WebSocket upgrade to ChatRoom DO
  const chatWsMatch = pathname.match(/^\/api\/leagues\/(\d+)\/chat\/ws$/);
  if (chatWsMatch && request.method === 'GET') {
    const leagueId = parseId(chatWsMatch[1]);
    const ctx = await loadLeagueContext(db, request, leagueId);
    if (ctx.error) return ctx.error;

    const doId = env.CHAT_ROOM.idFromName(`league-${leagueId}`);
    const stub = env.CHAT_ROOM.get(doId);

    const proxiedReq = new Request(request.url, {
      method: request.method,
      headers: new Headers({
        ...Object.fromEntries(request.headers),
        'X-League-Id': String(leagueId),
        'X-User-Id': String(ctx.user.id),
        'X-Username': ctx.user.username || 'Unknown',
        'X-Is-Commissioner': String(isCommissioner(ctx.league, ctx.role, ctx.user.id)),
      }),
    });

    return stub.fetch(proxiedReq);
  }
```

- [ ] **Step 3: Syntax check**

```bash
node --check worker/index.js
```

Expected: no output.

- [ ] **Step 4: Commit**

```bash
git add worker/index.js
git commit -m "feat: chat HTTP + WebSocket routes in worker"
```

---

### Task 4: useChatSocket Hook

**Files:**
- Create: `client/src/hooks/useChatSocket.js`

**Interfaces:**
- Consumes: `useAuth` from `../auth/AuthContext.jsx`
- Produces: `export default function useChatSocket(leagueId)` returning `{ messages, pinned, connected, error, sendMessage, deleteMessage, reactToMessage, pinMessage, unpinMessage }`
  - `messages`: `Array<{ id, userId, username, body, pinned, pinnedAt, createdAt, reactions: Array<{ emoji, count, reactorIds, userReacted }> }>`
  - `pinned`: the single pinned message object or `null`
  - `connected`: boolean
  - `error`: string or null
  - All action functions accept IDs/strings and call `ws.send`

- [ ] **Step 1: Create the hook**

Create `client/src/hooks/useChatSocket.js`:

```js
import { useState, useEffect, useRef, useCallback } from 'react'
import { useAuth } from '../auth/AuthContext.jsx'

export default function useChatSocket(leagueId) {
  const { user } = useAuth()
  const [messages, setMessages] = useState([])
  const [pinned, setPinned] = useState(null)
  const [connected, setConnected] = useState(false)
  const [error, setError] = useState(null)
  const wsRef = useRef(null)
  const reconnectRef = useRef(null)
  const pendingRef = useRef(null)

  function normalizeReactions(reactions, currentUserId) {
    return (reactions || []).map(r => ({
      emoji: r.emoji,
      count: r.count,
      reactorIds: r.reactorIds || [],
      userReacted: (r.reactorIds || []).includes(currentUserId),
    }))
  }

  function normalizeMsg(msg, currentUserId) {
    return { ...msg, reactions: normalizeReactions(msg.reactions, currentUserId) }
  }

  const handleEvent = useCallback((msg, currentUserId) => {
    switch (msg.type) {
      case 'history': {
        const normalized = (msg.messages || []).map(m => normalizeMsg(m, currentUserId))
        setMessages(normalized)
        setPinned(normalized.find(m => m.pinned) || null)
        break
      }
      case 'message': {
        const m = normalizeMsg(msg.message, currentUserId)
        setMessages(prev => [...prev, m])
        if (m.pinned) setPinned(m)
        break
      }
      case 'deleted':
        setMessages(prev => prev.filter(m => m.id !== msg.messageId))
        setPinned(prev => prev?.id === msg.messageId ? null : prev)
        break
      case 'reacted': {
        const reactions = normalizeReactions(msg.reactions, currentUserId)
        setMessages(prev => prev.map(m => m.id === msg.messageId ? { ...m, reactions } : m))
        setPinned(prev => prev?.id === msg.messageId ? { ...prev, reactions } : prev)
        break
      }
      case 'pinned': {
        const pinMsg = normalizeMsg(msg.message, currentUserId)
        setMessages(prev => prev.map(m => ({ ...m, pinned: m.id === pinMsg.id })))
        setPinned(pinMsg)
        break
      }
      case 'unpinned':
        setMessages(prev => prev.map(m => m.id === msg.messageId ? { ...m, pinned: false } : m))
        setPinned(prev => prev?.id === msg.messageId ? null : prev)
        break
      case 'error':
        setError(msg.text)
        break
      default:
        break
    }
  }, [])

  const connect = useCallback(() => {
    if (!leagueId || !user) return
    const proto = window.location.protocol === 'https:' ? 'wss' : 'ws'
    const ws = new WebSocket(`${proto}://${window.location.host}/api/leagues/${leagueId}/chat/ws`)
    wsRef.current = ws

    ws.onopen = () => {
      setConnected(true)
      setError(null)
      if (pendingRef.current) {
        ws.send(JSON.stringify({ type: 'send', body: pendingRef.current }))
        pendingRef.current = null
      }
    }

    ws.onmessage = (evt) => {
      try {
        const msg = JSON.parse(evt.data)
        handleEvent(msg, user.id)
      } catch {}
    }

    ws.onclose = (evt) => {
      setConnected(false)
      wsRef.current = null
      if (evt.code !== 1000) {
        reconnectRef.current = setTimeout(connect, 2000)
      }
    }

    ws.onerror = () => setConnected(false)
  }, [leagueId, user, handleEvent])

  useEffect(() => {
    connect()
    return () => {
      clearTimeout(reconnectRef.current)
      const ws = wsRef.current
      if (ws) { ws.onclose = null; ws.close(1000) }
      wsRef.current = null
    }
  }, [connect])

  const sendMessage = useCallback((body) => {
    if (wsRef.current?.readyState === WebSocket.OPEN) {
      wsRef.current.send(JSON.stringify({ type: 'send', body }))
    } else {
      pendingRef.current = body
      setError('Disconnected — reconnecting…')
      setTimeout(() => {
        if (pendingRef.current) {
          setError('Could not send message — please try again')
          pendingRef.current = null
        }
      }, 5000)
    }
  }, [])

  const deleteMessage = useCallback((messageId) => {
    wsRef.current?.send(JSON.stringify({ type: 'delete', messageId }))
  }, [])

  const reactToMessage = useCallback((messageId, emoji) => {
    wsRef.current?.send(JSON.stringify({ type: 'react', messageId, emoji }))
  }, [])

  const pinMessage = useCallback((messageId) => {
    wsRef.current?.send(JSON.stringify({ type: 'pin', messageId }))
  }, [])

  const unpinMessage = useCallback((messageId) => {
    wsRef.current?.send(JSON.stringify({ type: 'unpin', messageId }))
  }, [])

  return { messages, pinned, connected, error, sendMessage, deleteMessage, reactToMessage, pinMessage, unpinMessage }
}
```

- [ ] **Step 2: Commit**

```bash
git add client/src/hooks/useChatSocket.js
git commit -m "feat: useChatSocket WebSocket hook"
```

---

### Task 5: ChatPage + CSS

**Files:**
- Create: `client/src/pages/ChatPage.jsx`
- Modify: `client/src/App.css`

**Interfaces:**
- Consumes: `useChatSocket(leagueId)` from `../hooks/useChatSocket.js`; `useOutletContext` for `{ league }`; `useAuth` for `{ user }`
- Produces: `export default function ChatPage()` — the chat view mounted at `/leagues/:id/chat`

- [ ] **Step 1: Create ChatPage.jsx**

Create `client/src/pages/ChatPage.jsx`:

```jsx
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
```

- [ ] **Step 2: Add chat CSS to App.css**

Append to the end of `client/src/App.css`:

```css
/* ── Chat ─────────────────────────────────────────────────────────────────── */
.chat-page {
  display: flex;
  flex-direction: column;
  height: calc(100vh - 100px);
  max-width: 800px;
  margin: 0 auto;
}

.chat-pinned-bar {
  display: flex;
  align-items: center;
  gap: 8px;
  padding: 10px 16px;
  background: var(--bg-card);
  border-bottom: 1px solid var(--border);
  font-size: 0.85rem;
}
.chat-pinned-icon { flex-shrink: 0; }
.chat-pinned-body { flex: 1; color: var(--text-muted); }
.chat-unpin-btn { margin-left: auto; color: var(--text-muted); font-size: 0.8rem; }

.chat-feed {
  flex: 1;
  overflow-y: auto;
  padding: 16px;
  display: flex;
  flex-direction: column;
  gap: 4px;
}

.chat-empty {
  text-align: center;
  color: var(--text-muted);
  margin-top: 40px;
}

.chat-msg {
  display: flex;
  gap: 10px;
  padding: 6px 8px;
  border-radius: 6px;
}
.chat-msg:hover { background: var(--bg-card); }

.chat-avatar {
  width: 32px;
  height: 32px;
  border-radius: 50%;
  background: var(--primary-glow);
  border: 1px solid var(--primary);
  color: var(--primary);
  display: flex;
  align-items: center;
  justify-content: center;
  font-size: 0.85rem;
  font-weight: 600;
  flex-shrink: 0;
}

.chat-msg-body { flex: 1; min-width: 0; }

.chat-msg-meta {
  display: flex;
  align-items: center;
  gap: 8px;
  margin-bottom: 2px;
}
.chat-username { font-weight: 600; font-size: 0.9rem; color: var(--text); }
.chat-time { font-size: 0.75rem; color: var(--text-muted); }
.chat-msg-actions { margin-left: auto; display: flex; gap: 4px; opacity: 0; transition: opacity 0.15s; }
.chat-msg:hover .chat-msg-actions { opacity: 1; }

.chat-icon-btn {
  background: none;
  border: none;
  cursor: pointer;
  color: var(--text-muted);
  font-size: 0.8rem;
  padding: 2px 4px;
  border-radius: 3px;
}
.chat-icon-btn:hover { color: var(--text); background: var(--bg-card-hover); }

.chat-text {
  font-size: 0.9rem;
  color: var(--text);
  line-height: 1.5;
  word-break: break-word;
}

.chat-mention { color: var(--primary); font-weight: 600; }
.chat-mention-me { background: var(--primary-glow); border-radius: 3px; padding: 0 3px; }

.chat-reactions {
  display: flex;
  flex-wrap: wrap;
  gap: 4px;
  margin-top: 4px;
  align-items: center;
}

.reaction-chip {
  background: var(--bg-card);
  border: 1px solid var(--border);
  border-radius: 12px;
  padding: 2px 8px;
  font-size: 0.8rem;
  cursor: pointer;
  color: var(--text);
}
.reaction-chip:hover { border-color: var(--primary); }
.reaction-chip.reacted { border-color: var(--primary); background: var(--primary-glow); color: var(--primary); }

.reaction-add-wrap { position: relative; }
.reaction-add-btn {
  background: var(--bg-card);
  border: 1px dashed var(--border);
  border-radius: 12px;
  padding: 2px 8px;
  font-size: 0.8rem;
  cursor: pointer;
  color: var(--text-muted);
}
.reaction-add-btn:hover { border-color: var(--primary); color: var(--primary); }

.emoji-picker {
  position: absolute;
  bottom: calc(100% + 4px);
  left: 0;
  background: var(--bg-card);
  border: 1px solid var(--border);
  border-radius: 8px;
  padding: 6px;
  display: flex;
  gap: 4px;
  z-index: 10;
  box-shadow: 0 4px 12px rgba(0,0,0,0.4);
}
.emoji-opt {
  background: none;
  border: none;
  font-size: 1.2rem;
  cursor: pointer;
  padding: 4px;
  border-radius: 4px;
}
.emoji-opt:hover { background: var(--bg-card-hover); }

.chat-input-area {
  display: flex;
  align-items: flex-start;
  gap: 8px;
  padding: 12px 16px;
  border-top: 1px solid var(--border);
  background: var(--bg);
}

.chat-conn-dot {
  width: 8px;
  height: 8px;
  border-radius: 50%;
  flex-shrink: 0;
  margin-top: 10px;
}
.chat-conn-dot.conn { background: #22c55e; }
.chat-conn-dot.disconn { background: var(--text-dim); }

.chat-input {
  flex: 1;
  background: var(--bg-input);
  border: 1px solid var(--border);
  border-radius: 6px;
  padding: 8px 12px;
  color: var(--text);
  font-size: 0.9rem;
  resize: none;
  font-family: inherit;
  line-height: 1.5;
}
.chat-input:focus { outline: none; border-color: var(--primary); }
```

- [ ] **Step 3: Commit**

```bash
git add client/src/pages/ChatPage.jsx client/src/App.css
git commit -m "feat: ChatPage UI with pinned bar, feed, reactions, rich text"
```

---

### Task 6: Routing, Nav Badge + API Client

**Files:**
- Modify: `client/src/App.jsx`
- Modify: `client/src/components/LeagueLayout.jsx`
- Modify: `client/src/api.js`

**Interfaces:**
- Consumes: `ChatPage` from `./pages/ChatPage.jsx`
- Produces: `/leagues/:leagueId/chat` route; Chat nav link with unread dot badge; `api.leagues.chat.messages(id, limit?)` method

- [ ] **Step 1: Add ChatPage import and route to App.jsx**

In `client/src/App.jsx`, add the import after `KeepersPage`:

```js
import ChatPage from './pages/ChatPage.jsx'
```

Add the route inside the `<Route path="/leagues/:leagueId" ...>` block, after the `keepers` route:

```jsx
<Route path="chat" element={<ChatPage />} />
```

- [ ] **Step 2: Add Chat nav link with unread badge to LeagueLayout.jsx**

In `client/src/components/LeagueLayout.jsx`, add a state variable for the unread badge. The component already imports `useEffect` from react and has `leagueId` from `useParams`. Add:

After the existing `useState` calls, add:

```js
const [chatUnread, setChatUnread] = useState(false)
```

After the existing `useEffect` for `refreshLeague`, add:

```js
useEffect(() => {
  const lastRead = localStorage.getItem(`chatLastRead_${leagueId}`)
  setChatUnread(!lastRead)
}, [leagueId])
```

Replace the closing `</div>` of the nav (before the phaseMsg block) to insert the Chat link after the Trades link. Find this line:

```jsx
<NavLink to={`/leagues/${leagueId}/trades`} className={({ isActive }) => tab(isActive)}>Trades</NavLink>
```

Add immediately after it:

```jsx
<NavLink to={`/leagues/${leagueId}/chat`} className={({ isActive }) => tab(isActive)} onClick={() => setChatUnread(false)}>
  Chat{chatUnread && <span className="chat-unread-dot" />}
</NavLink>
```

Add to `client/src/App.css` (at the end):

```css
.chat-unread-dot {
  display: inline-block;
  width: 7px;
  height: 7px;
  border-radius: 50%;
  background: var(--primary);
  margin-left: 5px;
  vertical-align: middle;
  margin-bottom: 2px;
}
```

- [ ] **Step 3: Add chat API methods to api.js**

In `client/src/api.js`, inside the `leagues` object, add after the `rosterSnapshots` entry:

```js
chat: {
  messages: (id, limit = 50) => request(`/api/leagues/${id}/chat/messages?limit=${limit}`),
  connect: (id) => {
    const proto = window.location.protocol === 'https:' ? 'wss' : 'ws'
    return new WebSocket(`${proto}://${window.location.host}/api/leagues/${id}/chat/ws`)
  },
},
```

- [ ] **Step 4: Verify build**

```bash
cd client && npm run build 2>&1 | tail -20
```

Expected: build succeeds with no errors. If there are import errors, double-check the file paths in ChatPage.jsx and App.jsx.

- [ ] **Step 5: Commit**

```bash
git add client/src/App.jsx client/src/components/LeagueLayout.jsx client/src/api.js client/src/App.css
git commit -m "feat: chat route, nav badge, api client methods"
```

---

### Task 7: Deploy + Smoke Test

**Files:** (no new files)

- [ ] **Step 1: Run syntax check on worker**

```bash
node --check worker/index.js && node --check worker/chat-room.js
```

Expected: no output from either.

- [ ] **Step 2: Deploy worker**

```bash
npx wrangler deploy
```

Expected output ends with:
```
Deployed fantasy triggers ...
  https://fantasy.jbjhhzkdgp.workers.dev
```

- [ ] **Step 3: Smoke test in browser**

1. Open the app, navigate to any league → click **Chat** in the nav
2. Verify the chat feed loads (empty or with existing messages)
3. Type a message and press Enter — verify it appears instantly
4. Open a second browser tab to the same league → verify the message also appears there (real-time broadcast)
5. Hover a message → verify delete (✕) and pin (📌) buttons appear
6. Click an emoji reaction button → verify the chip appears with count 1
7. Pin a message (commissioner) → verify the pinned bar appears at the top
8. Close and reopen the chat page → verify the unread dot is gone from the nav

- [ ] **Step 4: Final commit + push**

```bash
git push
```
