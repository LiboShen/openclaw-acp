/**
 * Edge case tests for delta accumulation bugs
 */

import { describe, it, expect, beforeEach } from 'vitest';
import { SessionManager } from '../src/acp/session.js';
import type { GatewayClient } from '../src/gateway/client.js';
import type { ChatEventPayload } from '../src/gateway/types.js';
import { vi } from 'vitest';

function createMockGateway(): GatewayClient {
  return {
    connect: vi.fn(),
    disconnect: vi.fn(),
    isConnected: vi.fn(() => true),
    getState: vi.fn(() => 'connected'),
    sendChat: vi.fn().mockResolvedValue({ runId: 'test-run-id' }),
    abortChat: vi.fn().mockResolvedValue(undefined),
    getChatHistory: vi.fn().mockResolvedValue({ sessionKey: '', sessionId: '', messages: [] }),
    listSessions: vi.fn().mockResolvedValue({ sessions: [] }),
    sessionExists: vi.fn().mockResolvedValue(false),
  } as unknown as GatewayClient;
}

describe('Edge Cases: Delta Accumulation', () => {
  let manager: SessionManager;

  beforeEach(() => {
    manager = new SessionManager(createMockGateway());
  });

  it('BUG: multiple text items in content array corrupts output', () => {
    const session = manager.createSession('/tmp/test');
    session.emittedLengths.set('run-1', { text: 0, thinking: 0 });
    
    const updates: string[] = [];
    manager.onSessionUpdate = (_, update) => {
      if (update.sessionUpdate === 'agent_message_chunk') {
        updates.push((update.content as { text: string }).text);
      }
    };

    // Simulate gateway sending content with multiple text items
    // This might happen if gateway sends separate chunks in same event
    manager.handleChatEvent({
      sessionKey: session.sessionKey,
      runId: 'run-1',
      state: 'delta',
      message: {
        role: 'assistant',
        content: [
          { type: 'text', text: 'Hello' },
          { type: 'text', text: 'World' },  // Second text item
        ],
      },
    } as ChatEventPayload);

    // Expected: "Hello" and "World" (or "HelloWorld")
    // Current bug: Second item gets sliced wrong because emitted.text = 5 from first item
    console.log('Updates received:', updates);
    
    // This test documents the bug - it will fail with current code
    const combined = updates.join('');
    expect(combined).toBe('HelloWorld');
  });

  it('BUG: text shorter than emitted length causes negative slice', () => {
    const session = manager.createSession('/tmp/test');
    session.emittedLengths.set('run-1', { text: 10, thinking: 0 }); // Already emitted 10 chars
    
    const updates: string[] = [];
    manager.onSessionUpdate = (_, update) => {
      if (update.sessionUpdate === 'agent_message_chunk') {
        updates.push((update.content as { text: string }).text);
      }
    };

    // Gateway sends shorter text (resend or different content)
    manager.handleChatEvent({
      sessionKey: session.sessionKey,
      runId: 'run-1',
      state: 'delta',
      message: {
        role: 'assistant',
        content: [{ type: 'text', text: 'short' }], // Only 5 chars
      },
    } as ChatEventPayload);

    console.log('Updates received:', updates);
    
    // "short".slice(10) = "" - empty string, nothing emitted
    // This might cause content loss
    expect(updates).toHaveLength(0); // Documents current behavior
  });

  it('simulates "add" becoming "ad" scenario', () => {
    const session = manager.createSession('/tmp/test');
    session.emittedLengths.set('run-1', { text: 0, thinking: 0 });
    
    const updates: string[] = [];
    manager.onSessionUpdate = (_, update) => {
      if (update.sessionUpdate === 'agent_message_chunk') {
        updates.push((update.content as { text: string }).text);
      }
    };

    // Chunk 1: "ad" (accumulated: "ad")
    manager.handleChatEvent({
      sessionKey: session.sessionKey,
      runId: 'run-1',
      state: 'delta',
      message: { role: 'assistant', content: [{ type: 'text', text: 'ad' }] },
    } as ChatEventPayload);

    // Chunk 2: "add" (accumulated: "add") 
    // Delta should be just "d"
    manager.handleChatEvent({
      sessionKey: session.sessionKey,
      runId: 'run-1',
      state: 'delta',
      message: { role: 'assistant', content: [{ type: 'text', text: 'add' }] },
    } as ChatEventPayload);

    console.log('Updates:', updates);
    const result = updates.join('');
    expect(result).toBe('add'); // "ad" + "d" = "add"
  });
});
