# League Chat Design

**Date:** 2026-06-20
**Branch:** feature/league-chat
**Status:** Approved

## Overview

Real-time in-league chat with a flat chronological feed, a commissioner-pinned announcement bar, emoji reactions, basic rich text, @mentions, and an unread badge on the nav link. Existing `commissionerNotes` field is unchanged.

---

## Architecture

### ChatRoom Durable Object (`worker/chat-room.js`)

One instance per league, keyed `league-{leagueId}`. Responsibilities:

- Accept WebSocket upgrades and track all connected clients for a league
- On connect: validate auth token against D1, then send `history` event (last 50 messages)
- Broadcast mutations (`message`, `deleted`, `reacted`, `pinned`, `unpinned`) to all connected clients
- Write all mutations through to D1

### Worker (`worker/index.js`)

Two new routes:

```
GET /api/leagues/:id/chat/ws          → upgrade to ChatRoom DO WebSocket
GET /api/leagues/:id/chat/messages    → HTTP, returns last 50 messages (initial load / badge check)
```

All mutations (send, delete, react, pin, unpin) go over WebSocket only.

---

## Data Model

### Migration 0017

```sql
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

Soft-deletes: `deleted_at` is set on delete; deleted messages are excluded from queries. No hard deletes.

---

## WebSocket Protocol

### Client → Server

```js
{ type: 'send',   body: string }
{ type: 'delete', messageId: number }
{ type: 'react',  messageId: number, emoji: string }   // toggles: insert or delete
{ type: 'pin',    messageId: number }                  // commissioner only
{ type: 'unpin',  messageId: number }                  // commissioner only
```

### Server → All Clients

```js
{ type: 'history',  messages: Message[] }              // sent on connect
{ type: 'message',  message: Message }
{ type: 'deleted',  messageId: number }
{ type: 'reacted',  messageId: number, reactions: Reaction[] }
{ type: 'pinned',   message: Message }
{ type: 'unpinned', messageId: number }
{ type: 'error',    text: string }
```

### Message shape

```js
{
  id: number,
  userId: number,
  username: string,
  body: string,           // raw — rendered on client
  pinned: boolean,
  pinnedAt: string | null,
  createdAt: string,
  reactions: { emoji: string, count: number, userReacted: boolean }[]
}
```

### Auth

WebSocket URL includes `?token=<session-token>`. ChatRoom DO reads it from the upgrade request and validates against D1 `sessions` table on connect. Invalid token → close with code 1008.

---

## Permissions

| Action | Who |
|--------|-----|
| Send message | Any league member |
| Delete message | Own messages; commissioner can delete any |
| Pin / unpin | Commissioner only |
| React | Any league member |

---

## Client Components

### New files

- `worker/chat-room.js` — ChatRoom Durable Object
- `client/src/pages/ChatPage.jsx` — main chat view
- `client/src/hooks/useChatSocket.js` — WebSocket hook

### ChatPage layout

1. **Pinned bar** (top) — shown when a pinned message exists; distinct background; commissioner sees unpin button
2. **Message feed** (scrollable) — flat chronological, newest at bottom, auto-scrolls on new message
3. **Message row** — avatar initial + username + timestamp + rendered body + reaction chips + delete button (own or commissioner)
4. **Emoji picker** — appears on hover; fixed set: 👍 ❤️ 😂 🔥 😮 👀
5. **Input box** (bottom) — `<textarea>`, Enter sends, Shift+Enter newline

### useChatSocket hook

```js
const { messages, pinned, connected, sendMessage, deleteMessage, reactToMessage, pinMessage, unpinMessage } = useChatSocket(leagueId)
```

- Connects on mount, reconnects on `leagueId` change
- Dispatches incoming server events into local React state
- Manages reconnect with 2s backoff on unexpected close

### Rich text rendering

`renderBody(text)` — no library, pure regex:

- `**text**` → `<strong>`
- `_text_` → `<em>`
- `@username` → `<span className="mention">` (highlighted when username matches current user)

### Unread badge

- Stored in `localStorage` as `chatLastRead_{leagueId}` (ISO timestamp)
- Updated to `Date.now()` when user opens ChatPage
- `LeagueLayout` sidebar fetches `/api/leagues/:id/chat/messages?limit=1` on mount; if `messages[0].createdAt > lastRead`, shows a dot badge on the Chat nav link

---

## `wrangler.toml` changes

Add ChatRoom DO binding:

```toml
[[durable_objects.bindings]]
name = "CHAT_ROOM"
class_name = "ChatRoom"

[[migrations]]
tag = "v3"
new_classes = ["ChatRoom"]
```

---

## Error Handling

- Auth failure on WS connect: close 1008, client shows "Unable to connect"
- Send while disconnected: `useChatSocket` queues one message and retries on reconnect; if still disconnected after 5s, shows inline error
- D1 write failure inside DO: server sends `error` event to the sender only; message not broadcast

---

## Out of Scope

- Push / email notifications (future feature)
- Message threading / replies
- File or image attachments
- Read receipts per-user on the server (localStorage is sufficient for badge)
- Message editing
