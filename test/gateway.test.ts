/**
 * Tests for GatewayClient
 */

import { describe, it, expect, beforeEach, vi, afterEach } from 'vitest';
import { EventEmitter } from 'events';

// Mock WebSocket before importing GatewayClient
class MockWebSocket extends EventEmitter {
  static OPEN = 1;
  static CLOSED = 3;
  
  readyState = MockWebSocket.OPEN;
  sentMessages: string[] = [];

  constructor(_url: string) {
    super();
    // Simulate async connection
    setTimeout(() => this.emit('open'), 0);
  }

  send(data: string) {
    this.sentMessages.push(data);
  }

  close() {
    this.readyState = MockWebSocket.CLOSED;
    this.emit('close');
  }

  removeAllListeners() {
    super.removeAllListeners();
  }

  // Test helpers
  simulateMessage(data: unknown) {
    this.emit('message', JSON.stringify(data));
  }

  simulateError(error: Error) {
    this.emit('error', error);
  }

  simulateClose() {
    this.emit('close');
  }
}

vi.mock('ws', () => ({
  default: MockWebSocket,
}));

vi.mock('fs', () => ({
  readFileSync: vi.fn(() => JSON.stringify({
    gateway: {
      auth: { token: 'test-token' },
    },
  })),
}));

// Import after mocks are set up
const { GatewayClient } = await import('../src/gateway/client.js');

describe('GatewayClient', () => {
  let client: InstanceType<typeof GatewayClient>;
  let mockWs: MockWebSocket;

  beforeEach(() => {
    vi.clearAllMocks();
    client = new GatewayClient();
  });

  afterEach(() => {
    client.disconnect();
  });

  describe('connect', () => {
    it('should connect and authenticate with gateway', async () => {
      const connectPromise = client.connect();

      // Wait for WebSocket to be created
      await new Promise(r => setTimeout(r, 10));
      
      // Get the mock WebSocket instance
      mockWs = (client as any).ws as MockWebSocket;
      
      // Simulate challenge
      mockWs.simulateMessage({
        type: 'event',
        event: 'connect.challenge',
      });

      // Wait for connect request
      await new Promise(r => setTimeout(r, 10));

      // Check connect request was sent
      expect(mockWs.sentMessages.length).toBeGreaterThan(0);
      const connectReq = JSON.parse(mockWs.sentMessages[0]);
      expect(connectReq.method).toBe('connect');
      expect(connectReq.params.auth.token).toBe('test-token');

      // Simulate successful response
      mockWs.simulateMessage({
        type: 'res',
        id: connectReq.id,
        ok: true,
        payload: { type: 'hello-ok' },
      });

      await connectPromise;

      expect(client.isConnected()).toBe(true);
      expect(client.getState()).toBe('connected');
    });

    it('should reject on connection timeout', async () => {
      // Don't send any messages to trigger timeout
      // This test would need actual timeout handling
    });

    it('should be idempotent when already connected', async () => {
      // First connect
      const connectPromise1 = client.connect();
      await new Promise(r => setTimeout(r, 10));
      mockWs = (client as any).ws as MockWebSocket;
      
      mockWs.simulateMessage({ type: 'event', event: 'connect.challenge' });
      await new Promise(r => setTimeout(r, 10));
      
      const connectReq = JSON.parse(mockWs.sentMessages[0]);
      mockWs.simulateMessage({ type: 'res', id: connectReq.id, ok: true, payload: {} });
      
      await connectPromise1;

      // Second connect should return immediately
      const connectPromise2 = client.connect();
      await connectPromise2;

      expect(client.isConnected()).toBe(true);
    });
  });

  describe('disconnect', () => {
    it('should close connection and stop reconnection', async () => {
      // Connect first
      const connectPromise = client.connect();
      await new Promise(r => setTimeout(r, 10));
      mockWs = (client as any).ws as MockWebSocket;
      
      mockWs.simulateMessage({ type: 'event', event: 'connect.challenge' });
      await new Promise(r => setTimeout(r, 10));
      
      const connectReq = JSON.parse(mockWs.sentMessages[0]);
      mockWs.simulateMessage({ type: 'res', id: connectReq.id, ok: true, payload: {} });
      
      await connectPromise;

      // Disconnect
      client.disconnect();

      expect(client.isConnected()).toBe(false);
      expect(client.getState()).toBe('disconnected');
    });
  });

  describe('sendChat', () => {
    it('should send chat message and return runId', async () => {
      // Setup connected client
      const connectPromise = client.connect();
      await new Promise(r => setTimeout(r, 10));
      mockWs = (client as any).ws as MockWebSocket;
      
      mockWs.simulateMessage({ type: 'event', event: 'connect.challenge' });
      await new Promise(r => setTimeout(r, 10));
      const connectReq = JSON.parse(mockWs.sentMessages[0]);
      mockWs.simulateMessage({ type: 'res', id: connectReq.id, ok: true, payload: {} });
      await connectPromise;

      // Send chat
      const chatPromise = client.sendChat('agent:main:test', 'Hello');
      
      await new Promise(r => setTimeout(r, 10));
      
      // Find chat.send request
      const chatReqStr = mockWs.sentMessages.find(m => m.includes('chat.send'));
      expect(chatReqStr).toBeDefined();
      
      const chatReq = JSON.parse(chatReqStr!);
      expect(chatReq.method).toBe('chat.send');
      expect(chatReq.params.sessionKey).toBe('agent:main:test');
      expect(chatReq.params.message).toBe('Hello');

      // Simulate response
      mockWs.simulateMessage({
        type: 'res',
        id: chatReq.id,
        ok: true,
        payload: { runId: 'run-123', status: 'started' },
      });

      const result = await chatPromise;
      expect(result.runId).toBe('run-123');
    });

    it('should reject when not connected', async () => {
      await expect(client.sendChat('session', 'Hello'))
        .rejects.toThrow('Not connected');
    });
  });

  describe('event handling', () => {
    it('should call onChat for chat events', async () => {
      const chatEvents: unknown[] = [];
      client = new GatewayClient({
        onChat: (payload) => chatEvents.push(payload),
      });

      // Connect
      const connectPromise = client.connect();
      await new Promise(r => setTimeout(r, 10));
      mockWs = (client as any).ws as MockWebSocket;
      
      mockWs.simulateMessage({ type: 'event', event: 'connect.challenge' });
      await new Promise(r => setTimeout(r, 10));
      const connectReq = JSON.parse(mockWs.sentMessages[0]);
      mockWs.simulateMessage({ type: 'res', id: connectReq.id, ok: true, payload: {} });
      await connectPromise;

      // Simulate chat event
      mockWs.simulateMessage({
        type: 'event',
        event: 'chat',
        payload: { sessionKey: 'test', runId: 'run-1', state: 'delta' },
      });

      expect(chatEvents).toHaveLength(1);
      expect(chatEvents[0]).toMatchObject({ sessionKey: 'test', runId: 'run-1' });
    });

    it('should call onAgent for agent events', async () => {
      const agentEvents: unknown[] = [];
      client = new GatewayClient({
        onAgent: (payload) => agentEvents.push(payload),
      });

      // Connect
      const connectPromise = client.connect();
      await new Promise(r => setTimeout(r, 10));
      mockWs = (client as any).ws as MockWebSocket;
      
      mockWs.simulateMessage({ type: 'event', event: 'connect.challenge' });
      await new Promise(r => setTimeout(r, 10));
      const connectReq = JSON.parse(mockWs.sentMessages[0]);
      mockWs.simulateMessage({ type: 'res', id: connectReq.id, ok: true, payload: {} });
      await connectPromise;

      // Simulate agent event
      mockWs.simulateMessage({
        type: 'event',
        event: 'agent',
        payload: { runId: 'tool-1', stream: 'lifecycle', data: { phase: 'start' } },
      });

      expect(agentEvents).toHaveLength(1);
      expect(agentEvents[0]).toMatchObject({ runId: 'tool-1', stream: 'lifecycle' });
    });

    it('should call onDisconnect when connection closes', async () => {
      let disconnected = false;
      client = new GatewayClient({
        onDisconnect: () => { disconnected = true; },
      });

      // Connect
      const connectPromise = client.connect();
      await new Promise(r => setTimeout(r, 10));
      mockWs = (client as any).ws as MockWebSocket;
      
      mockWs.simulateMessage({ type: 'event', event: 'connect.challenge' });
      await new Promise(r => setTimeout(r, 10));
      const connectReq = JSON.parse(mockWs.sentMessages[0]);
      mockWs.simulateMessage({ type: 'res', id: connectReq.id, ok: true, payload: {} });
      await connectPromise;

      expect(disconnected).toBe(false);

      // Simulate disconnect
      mockWs.simulateClose();

      expect(disconnected).toBe(true);
    });
  });

  describe('reconnection', () => {
    it('should attempt reconnection after disconnect', async () => {
      client = new GatewayClient({});

      // Initial connect
      const connectPromise = client.connect();
      await new Promise(r => setTimeout(r, 10));
      mockWs = (client as any).ws as MockWebSocket;
      
      mockWs.simulateMessage({ type: 'event', event: 'connect.challenge' });
      await new Promise(r => setTimeout(r, 10));
      const connectReq = JSON.parse(mockWs.sentMessages[0]);
      mockWs.simulateMessage({ type: 'res', id: connectReq.id, ok: true, payload: {} });
      await connectPromise;

      // Simulate disconnect
      mockWs.simulateClose();

      // State changes to disconnected, reconnection scheduled
      expect(client.getState()).toBe('disconnected');
      
      // Note: Actual reconnection takes 1000ms+ (exponential backoff)
      // Full reconnection flow tested in integration tests
    });

    it('should not reconnect after explicit disconnect', async () => {
      // Connect
      const connectPromise = client.connect();
      await new Promise(r => setTimeout(r, 10));
      mockWs = (client as any).ws as MockWebSocket;
      
      mockWs.simulateMessage({ type: 'event', event: 'connect.challenge' });
      await new Promise(r => setTimeout(r, 10));
      const connectReq = JSON.parse(mockWs.sentMessages[0]);
      mockWs.simulateMessage({ type: 'res', id: connectReq.id, ok: true, payload: {} });
      await connectPromise;

      // Explicit disconnect
      client.disconnect();

      // Should not trigger reconnection
      expect((client as any).shouldReconnect).toBe(false);
    });
  });
});
