/**
 * OpenClaw Gateway WebSocket client with reconnection support.
 */

import { readFileSync, existsSync } from 'fs';
import { homedir } from 'os';
import { join } from 'path';
import WebSocket from 'ws';
import { randomUUID, createPrivateKey, sign } from 'crypto';

interface DeviceIdentity {
  deviceId: string;
  publicKeyPem: string;
  privateKeyPem: string;
}

interface DeviceAuth {
  deviceId: string;
  tokens: {
    operator?: {
      token: string;
      scopes: string[];
    };
  };
}
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
            // Extract challenge nonce from payload
            const challenge = msg.payload as { nonce: string; ts: number } | undefined;
            // Authenticate with challenge nonce
            this.sendConnectRequest(challenge?.nonce)
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
      // Support OPENCLAW_CONFIG_PATH env var, fallback to ~/.openclaw/openclaw.json
      const configPath = process.env.OPENCLAW_CONFIG_PATH 
        || join(homedir(), '.openclaw', 'openclaw.json');
      
      // Read config, stripping JSON5 comments
      const configText = readFileSync(configPath, 'utf-8');
      const jsonText = configText.replace(/^\s*\/\/.*$/gm, ''); // Strip // comments
      const config = JSON.parse(jsonText);
      
      const tokenValue = config?.gateway?.auth?.token;
      if (!tokenValue) return null;
      
      // If token is a string, use it directly
      if (typeof tokenValue === 'string') {
        return tokenValue;
      }
      
      // If token is a SecretRef object, resolve it
      if (typeof tokenValue === 'object' && tokenValue.source === 'file') {
        return this.resolveSecretRef(config, tokenValue);
      }
      
      return null;
    } catch {
      return null;
    }
  }

  /**
   * Resolve a SecretRef to its actual value.
   * SecretRef format: { source: "file", provider: "providerName", id: "/key-path" }
   */
  private resolveSecretRef(
    config: Record<string, unknown>,
    ref: { source: string; provider: string; id: string }
  ): string | null {
    try {
      // Get the secrets provider config
      const providers = (config?.secrets as Record<string, unknown>)?.providers as Record<string, unknown>;
      const provider = providers?.[ref.provider] as { path?: string; mode?: string } | undefined;
      
      if (!provider?.path) return null;
      
      // Expand ~ in path
      const secretsPath = provider.path.replace(/^~/, homedir());
      
      // Read secrets file
      const secretsText = readFileSync(secretsPath, 'utf-8');
      const secrets = JSON.parse(secretsText);
      
      // Extract key from id (e.g., "/gateway-token" -> "gateway-token")
      const key = ref.id.replace(/^\//, '');
      
      return secrets?.[key] ?? null;
    } catch {
      return null;
    }
  }

  private loadDeviceIdentity(): DeviceIdentity | null {
    try {
      // Support OPENCLAW_STATE_DIR env var, fallback to ~/.openclaw
      const stateDir = process.env.OPENCLAW_STATE_DIR 
        || join(homedir(), '.openclaw');
      const identityPath = join(stateDir, 'identity', 'device.json');
      if (!existsSync(identityPath)) return null;
      return JSON.parse(readFileSync(identityPath, 'utf-8'));
    } catch {
      return null;
    }
  }

  private signPayload(identity: DeviceIdentity, payload: string): string {
    const privateKey = createPrivateKey(identity.privateKeyPem);
    const signature = sign(null, Buffer.from(payload, 'utf-8'), privateKey);
    return signature.toString('base64url');
  }

  private extractRawEd25519PublicKey(pem: string): string {
    // Decode the PEM to get SubjectPublicKeyInfo
    const base64 = pem
      .replace(/-----BEGIN PUBLIC KEY-----/, '')
      .replace(/-----END PUBLIC KEY-----/, '')
      .replace(/\n/g, '')
      .trim();
    const der = Buffer.from(base64, 'base64');
    
    // Ed25519 SubjectPublicKeyInfo has a 12-byte prefix, raw key is last 32 bytes
    // Prefix: 302a300506032b6570032100
    const rawKey = der.subarray(-32);
    
    // Convert to base64url
    return rawKey.toString('base64url');
  }

  private async sendConnectRequest(challengeNonce?: string): Promise<void> {
    const identity = this.loadDeviceIdentity();
    
    const clientId = 'cli';
    const clientMode = 'backend';
    const role = 'operator';
    const scopes = ['operator.admin', 'operator.write', 'operator.read'];
    
    // Build device identity for scopes (only if we have identity, nonce, and token)
    let device: Record<string, unknown> | undefined;
    if (identity && challengeNonce && this.token) {
      const signedAt = Date.now();
      const publicKey = this.extractRawEd25519PublicKey(identity.publicKeyPem);
      
      // Build v2 payload: v2|deviceId|clientId|clientMode|role|scopes|signedAtMs|token|nonce
      const scopesStr = scopes.join(',');
      const payload = `v2|${identity.deviceId}|${clientId}|${clientMode}|${role}|${scopesStr}|${signedAt}|${this.token}|${challengeNonce}`;
      const signature = this.signPayload(identity, payload);
      
      device = {
        id: identity.deviceId,
        publicKey,
        signature,
        signedAt,
        nonce: challengeNonce,
      };
      console.error('[openclaw-acp] Using device identity for scopes');
    }

    await this.request('connect', {
      minProtocol: 3,
      maxProtocol: 3,
      client: {
        id: clientId,
        displayName: 'OpenClaw ACP',
        version: '0.0.1',
        platform: process.platform,
        mode: clientMode,
      },
      auth: { token: this.token },
      caps: ['tool-events'],
      role,
      scopes,
      ...(device && { device }),
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
    for (const [_id, req] of this.pending) {
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
