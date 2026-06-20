import { useState, useEffect, useRef, useCallback } from 'react';
import { api } from '../api';

export function useDraftSocket(leagueId) {
  const [state, setState] = useState(null);
  const [connected, setConnected] = useState(false);
  const [error, setError] = useState(null);
  const wsRef = useRef(null);
  const retriesRef = useRef(0);
  const MAX_RETRIES = 5;

  const connect = useCallback(() => {
    if (!leagueId) return;

    const ws = api.leagues.draft.connect(leagueId);
    wsRef.current = ws;

    ws.onopen = () => {
      setConnected(true);
      setError(null);
      retriesRef.current = 0;
    };

    ws.onmessage = (evt) => {
      try {
        const msg = JSON.parse(evt.data);
        if (msg.type === 'state') setState(msg.data);
        if (msg.type === 'error') setError(msg.message);
      } catch {}
    };

    ws.onclose = () => {
      setConnected(false);
      wsRef.current = null;
      if (retriesRef.current < MAX_RETRIES) {
        const delay = Math.min(100 * Math.pow(2, retriesRef.current), 10000);
        retriesRef.current += 1;
        setTimeout(connect, delay);
      } else {
        setError('Connection lost. Please refresh the page.');
      }
    };

    ws.onerror = () => {
      ws.close();
    };
  }, [leagueId]);

  useEffect(() => {
    connect();
    return () => {
      retriesRef.current = MAX_RETRIES; // stop reconnects on unmount
      wsRef.current?.close();
    };
  }, [connect]);

  const send = useCallback((msg) => {
    if (wsRef.current?.readyState === WebSocket.OPEN) {
      wsRef.current.send(JSON.stringify(msg));
    }
  }, []);

  return { state, send, connected, error };
}
