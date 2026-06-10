import { useEffect, useRef, useState } from 'react'
import type { WsMessage } from './api'

export type WsStatus = 'connecting' | 'open' | 'closed'

type MessageListener = (msg: WsMessage) => void
type StatusListener = (status: WsStatus) => void

/**
 * Singleton WebSocket client with automatic reconnection (exponential
 * backoff, capped at 10s). All components share the same connection.
 */
class WsClient {
  private listeners = new Set<MessageListener>()
  private statusListeners = new Set<StatusListener>()
  private retry = 0
  private reconnectTimer: ReturnType<typeof setTimeout> | null = null
  private started = false
  status: WsStatus = 'closed'

  private url(): string {
    const proto = window.location.protocol === 'https:' ? 'wss' : 'ws'
    return `${proto}://${window.location.host}/ws`
  }

  start() {
    if (this.started) return
    this.started = true
    this.connect()
  }

  private setStatus(s: WsStatus) {
    this.status = s
    this.statusListeners.forEach((l) => l(s))
  }

  private connect() {
    this.setStatus('connecting')
    let ws: WebSocket
    try {
      ws = new WebSocket(this.url())
    } catch {
      this.scheduleReconnect()
      return
    }

    ws.onopen = () => {
      this.retry = 0
      this.setStatus('open')
    }
    ws.onmessage = (ev) => {
      try {
        const msg = JSON.parse(ev.data as string) as WsMessage
        this.listeners.forEach((l) => l(msg))
      } catch {
        // ignore malformed frames
      }
    }
    ws.onclose = () => {
      this.setStatus('closed')
      this.scheduleReconnect()
    }
    ws.onerror = () => {
      ws.close()
    }
  }

  private scheduleReconnect() {
    if (this.reconnectTimer) return
    const delay = Math.min(10_000, 500 * 2 ** this.retry)
    this.retry += 1
    this.reconnectTimer = setTimeout(() => {
      this.reconnectTimer = null
      this.connect()
    }, delay)
  }

  subscribe(listener: MessageListener): () => void {
    this.listeners.add(listener)
    return () => this.listeners.delete(listener)
  }

  subscribeStatus(listener: StatusListener): () => void {
    this.statusListeners.add(listener)
    return () => this.statusListeners.delete(listener)
  }
}

export const wsClient = new WsClient()

/**
 * Subscribe to all WS messages. The handler is kept in a ref so the
 * subscription survives re-renders without churn.
 */
export function useWsMessages(handler: MessageListener) {
  const ref = useRef(handler)
  ref.current = handler
  useEffect(() => {
    wsClient.start()
    const unsub = wsClient.subscribe((msg) => ref.current(msg))
    return unsub
  }, [])
}

/** Current connection status, reactive. */
export function useWsStatus(): WsStatus {
  const [status, setStatus] = useState<WsStatus>(wsClient.status)
  useEffect(() => {
    wsClient.start()
    setStatus(wsClient.status)
    return wsClient.subscribeStatus(setStatus)
  }, [])
  return status
}
