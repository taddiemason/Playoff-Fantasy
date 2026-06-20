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
