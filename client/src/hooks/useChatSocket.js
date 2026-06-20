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
