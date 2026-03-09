/**
 * OpenClaw Gateway WebSocket client with reconnection support.
 */

import { readFileSync } from 'fs';
import { homedir } from 'os';
import { join } from 'path';
import WebSocket from 'ws';
import { randomUUID } from 'crypto';
import type {
  GatewayRequest,
  GatewayMessage,
  ChatEventPayload,
  AgentEventPayload,
  ChatHistoryResponse,
  SessionInfo,
} from './types.js';

const GATEWAY_URL = 'ws://127.0.0.1:18789';
const CONNECT_TIMEOUT = 10000;
const REQUEST_TIMEOUT = 30000;
const RECONNECT_DELAY_MS = 1000;
const MAX_RECONNECT_DELAY_MS = 30000;
const RECONNECT_BACKOFF_MULTIPLIER = 1.5;

interface PendingRequest {
  resolve: (value: unknown) => void;
  reject: (error: Error) => void;
  timer: ReturnType<typeof setTimeout>;
}

export interface GatewayClientEvents {
  onChat?: (payload: ChatEventPayload) => void;
  onAgent?: (payload: AgentEventPayload) => void;
  onDisconnect?: () => void;
  onReconnect?: () => void;
}

export type ConnectionState = 'disconnected' | 'connecting' | 'connected';

export class GatewayClient {
  private ws: WebSocket | null = null;
  private pending = new Map<string, PendingRequest>();
  private token: string | null = null;
  private events: GatewayClientEvents = {};
  private state: ConnectionState = 'disconnected';
  
  // Reconnection state
  private reconnectTimer: ReturnType<typeof setTimeout> | null = null;
  private reconnectDelay = RECONNECT_DELAY_MS;
  private shouldReconnect = false;
  private connectPromise: Promise<void> | null = null;

  constructor(events?: GatewayClientEvents) {
    if (events) this.events = events;
  }

  /**
   * Connect to the gateway. Safe to call multiple times.
   */
  async connect(): Promise<void> {
    // If already connecting, wait for that attempt
    if (this.connectPromise) {
      return this.connectPromise;
    }

    // If already connected, return immediately
    if (this.state === 'connected') {
      return;
    }

    this.shouldReconnect = true;
    this.connectPromise = this.doConnect();
    
    try {
      await this.connectPromise;
    } finally {
      this.connectPromise = null;
    }
  }

  private async doConnect(): Promise<void> {
    this.token = this.loadToken();
    if (!this.token) {
      throw new Error('No gateway token found. Run `openclaw configure` first.');
    }

    this.state = 'connecting';

    return new Promise((resolve, reject) => {
      const timeout = setTimeout(() => {
        this.cleanup();
        reject(new Error('Gateway connection timeout'));
      }, CONNECT_TIMEOUT);

      try {
        this.ws = new WebSocket(GATEWAY_URL);
      } catch (err) {
        clearTimeout(timeout);
        this.state = 'disconnected';
        reject(err);
        return;
      }

      this.ws.on('open', () => {
        // Wait for challenge event
      });

      this.ws.on('message', (data) => {
        const msg = JSON.parse(data.toString()) as GatewayMessage;
        
        if (msg.type === 'event') {
          if (msg.event === 'connect.challenge') {
            // Authenticate
            this.sendConnectRequest()
              .then(() => {
                clearTimeout(timeout);
                this.state = 'connected';
                this.reconnectDelay = RECONNECT_DELAY_MS; // Reset backoff
                resolve();
              })
              .catch((err) => {
                clearTimeout(timeout);
                this.cleanup();
                reject(err);
              });
          } else {
            this.handleEvent(msg.event, msg.payload);
          }
        } else if (msg.type === 'res') {
          this.handleResponse(msg.id, msg.ok, msg.payload, msg.error);
        }
      });

      this.ws.on('error', (err) => {
        if (this.state === 'connecting') {
          clearTimeout(timeout);
          this.cleanup();
          reject(err);
        }
        // If already connected, error will trigger close
      });

      this.ws.on('close', () => {
        const wasConnected = this.state === 'connected';
        this.cleanup();
        
        if (wasConnected) {
          this.events.onDisconnect?.();
          this.scheduleReconnect();
        }
      });
    });
  }

  /**
   * Disconnect from the gateway and stop reconnection attempts.
   */
  disconnect(): void {
    this.shouldReconnect = false;
    this.cancelReconnect();
    this.cleanup();
  }

  /**
   * Check if connected to the gateway.
   */
  isConnected(): boolean {
    return this.state === 'connected';
  }

  /**
   * Get current connection state.
   */
  getState(): ConnectionState {
    return this.state;
  }

  // --- Chat API ---

  async sendChat(sessionKey: string, message: string): Promise<{ runId: string }> {
    const idempotencyKey = randomUUID();
    const result = await this.request('chat.send', {
      sessionKey,
      message,
      idempotencyKey,
    });
    return { runId: result.runId as string };
  }

  async abortChat(sessionKey: string, runId?: string): Promise<void> {
    await this.request('chat.abort', { sessionKey, runId });
  }

  async getChatHistory(sessionKey: string, limit = 100): Promise<ChatHistoryResponse> {
    const result = await this.request('chat.history', { sessionKey, limit });
    return result as unknown as ChatHistoryResponse;
  }

  // --- Sessions API ---

  async listSessions(): Promise<{ sessions: SessionInfo[] }> {
    const result = await this.request('sessions.list', {});
    return result as { sessions: SessionInfo[] };
  }

  /**
   * Check if a session exists in the gateway.
   */
  async sessionExists(sessionKey: string): Promise<boolean> {
    try {
      const { sessions } = await this.listSessions();
      return sessions.some(s => s.key === sessionKey);
    } catch {
      return false;
    }
  }

  // --- Private ---

  private loadToken(): string | null {
    try {
      const configPath = join(homedir(), '.openclaw', 'openclaw.json');
      const config = JSON.parse(readFileSync(configPath, 'utf-8'));
      return config?.gateway?.auth?.token ?? null;
    } catch {
      return null;
    }
  }

  private async sendConnectRequest(): Promise<void> {
    await this.request('connect', {
      minProtocol: 3,
      maxProtocol: 3,
      client: {
        id: 'gateway-client',
        displayName: 'OpenClaw ACP',
        version: '0.0.1',
        platform: process.platform,
        mode: 'backend',
      },
      auth: { token: this.token },
      caps: ['tool-events'],
      role: 'operator',
      scopes: ['operator.admin'],
    });
  }

  private request(method: string, params: Record<string, unknown>): Promise<Record<string, unknown>> {
    return new Promise((resolve, reject) => {
      if (!this.ws || this.ws.readyState !== WebSocket.OPEN) {
        reject(new Error('Not connected to gateway'));
        return;
      }

      const id = randomUUID();
      const timer = setTimeout(() => {
        this.pending.delete(id);
        reject(new Error(`Request timeout: ${method}`));
      }, REQUEST_TIMEOUT);

      this.pending.set(id, {
        resolve: resolve as (value: unknown) => void,
        reject,
        timer,
      });

      const request: GatewayRequest = { type: 'req', id, method, params };
      this.ws.send(JSON.stringify(request));
    });
  }

  private handleResponse(
    id: string,
    ok: boolean,
    payload?: Record<string, unknown>,
    error?: { code: string; message: string }
  ): void {
    const req = this.pending.get(id);
    if (!req) return;

    this.pending.delete(id);
    clearTimeout(req.timer);

    if (ok) {
      req.resolve(payload ?? {});
    } else {
      req.reject(new Error(error?.message ?? 'Unknown error'));
    }
  }

  private handleEvent(event: string, payload?: Record<string, unknown>): void {
    switch (event) {
      case 'chat':
        this.events.onChat?.(payload as unknown as ChatEventPayload);
        break;
      case 'agent':
        this.events.onAgent?.(payload as unknown as AgentEventPayload);
        break;
      // Ignore tick, health, presence
    }
  }

  private cleanup(): void {
    this.state = 'disconnected';
    
    // Reject all pending requests
    for (const [id, req] of this.pending) {
      clearTimeout(req.timer);
      req.reject(new Error('Connection closed'));
    }
    this.pending.clear();

    // Close WebSocket
    if (this.ws) {
      try {
        this.ws.removeAllListeners();
        this.ws.close();
      } catch {
        // Ignore close errors
      }
      this.ws = null;
    }
  }

  private scheduleReconnect(): void {
    if (!this.shouldReconnect) return;

    this.cancelReconnect();

    this.reconnectTimer = setTimeout(async () => {
      if (!this.shouldReconnect) return;

      try {
        await this.doConnect();
        this.events.onReconnect?.();
      } catch {
        // Increase backoff for next attempt
        this.reconnectDelay = Math.min(
          this.reconnectDelay * RECONNECT_BACKOFF_MULTIPLIER,
          MAX_RECONNECT_DELAY_MS
        );
        this.scheduleReconnect();
      }
    }, this.reconnectDelay);
  }

  private cancelReconnect(): void {
    if (this.reconnectTimer) {
      clearTimeout(this.reconnectTimer);
      this.reconnectTimer = null;
    }
  }
}
