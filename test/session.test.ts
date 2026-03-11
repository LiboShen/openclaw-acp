/**
 * Tests for SessionManager
 */

import { describe, it, expect, beforeEach, vi } from 'vitest';
import { SessionManager } from '../src/acp/session.js';
import type { GatewayClient } from '../src/gateway/client.js';
import type { ChatEventPayload, AgentEventPayload, ChatMessage } from '../src/gateway/types.js';

// Mock GatewayClient
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

describe('SessionManager', () => {
  let manager: SessionManager;
  let mockGateway: GatewayClient;

  beforeEach(() => {
    mockGateway = createMockGateway();
    manager = new SessionManager(mockGateway);
  });

  describe('createSession', () => {
    it('should create a new session with UUID', () => {
      const session = manager.createSession('/tmp/test');
      
      expect(session.sessionId).toBeDefined();
      expect(session.sessionId).toMatch(/^[0-9a-f-]{36}$/);
      expect(session.cwd).toBe('/tmp/test');
      expect(session.agentId).toBe('main');
      expect(session.currentRunId).toBeNull();
    });

    it('should build correct session key', () => {
      const session = manager.createSession('/tmp/test');
      
      expect(session.sessionKey).toBe(`agent:main:${session.sessionId}`);
    });

    it('should store session for retrieval', () => {
      const session = manager.createSession('/tmp/test');
      
      const retrieved = manager.getSession(session.sessionId);
      expect(retrieved).toBe(session);
    });

    it('should create unique sessions', () => {
      const session1 = manager.createSession('/tmp/test1');
      const session2 = manager.createSession('/tmp/test2');
      
      expect(session1.sessionId).not.toBe(session2.sessionId);
    });
  });

  describe('loadSession', () => {
    it('should load session and fetch history', async () => {
      const mockHistory: ChatMessage[] = [
        { role: 'user', content: [{ type: 'text', text: 'Hello' }] },
        { role: 'assistant', content: [{ type: 'text', text: 'Hi there!' }] },
      ];
      
      vi.mocked(mockGateway.getChatHistory).mockResolvedValue({
        sessionKey: 'agent:main:test-id',
        sessionId: 'internal-id',
        messages: mockHistory,
      });

      const { state, history } = await manager.loadSession('test-id', '/tmp/test');
      
      expect(state.sessionId).toBe('test-id');
      expect(state.sessionKey).toBe('agent:main:test-id');
      expect(history).toEqual(mockHistory);
    });

    it('should handle missing session gracefully', async () => {
      vi.mocked(mockGateway.getChatHistory).mockRejectedValue(new Error('Not found'));

      const { state, history } = await manager.loadSession('new-session', '/tmp/test');
      
      expect(state.sessionId).toBe('new-session');
      expect(history).toEqual([]);
    });
  });

  describe('sendPrompt', () => {
    it('should send prompt via gateway', async () => {
      const session = manager.createSession('/tmp/test');
      
      // Start prompt (don't await - it waits for completion)
      const promptPromise = manager.sendPrompt(session.sessionId, 'Hello world');
      
      // Need to wait a tick for the promise to set up
      await new Promise(r => setImmediate(r));
      
      expect(mockGateway.sendChat).toHaveBeenCalledWith(
        session.sessionKey,
        'Hello world'
      );

      // Simulate completion
      manager.handleChatEvent({
        sessionKey: session.sessionKey,
        runId: 'test-run-id',
        state: 'final',
        message: { role: 'assistant', content: [] },
      });

      await promptPromise;
    });

    it('should store run ID', async () => {
      const session = manager.createSession('/tmp/test');
      
      const promptPromise = manager.sendPrompt(session.sessionId, 'Hello');
      
      // Need to wait a tick for the async operations
      await new Promise(r => setImmediate(r));
      
      expect(session.currentRunId).toBe('test-run-id');

      // Complete it
      manager.handleChatEvent({
        sessionKey: session.sessionKey,
        runId: 'test-run-id',
        state: 'final',
        message: { role: 'assistant', content: [] },
      });

      await promptPromise;
    });

    it('should throw for unknown session', async () => {
      await expect(manager.sendPrompt('unknown', 'Hello'))
        .rejects.toThrow('Session not found');
    });

    it('should resolve when response completes', async () => {
      const session = manager.createSession('/tmp/test');
      
      const promptPromise = manager.sendPrompt(session.sessionId, 'Hello');
      
      // Need to wait a tick for the async operations
      await new Promise(r => setImmediate(r));
      
      // Simulate streaming
      manager.handleChatEvent({
        sessionKey: session.sessionKey,
        runId: 'test-run-id',
        state: 'delta',
        message: { role: 'assistant', content: [{ type: 'text', text: 'Hi' }] },
      });

      // Simulate completion
      manager.handleChatEvent({
        sessionKey: session.sessionKey,
        runId: 'test-run-id',
        state: 'final',
        message: { role: 'assistant', content: [{ type: 'text', text: 'Hi there!' }] },
      });

      // Should resolve now
      await promptPromise;
    });
  });

  describe('cancelPrompt', () => {
    it('should abort current run and resolve prompt', async () => {
      const session = manager.createSession('/tmp/test');
      const promptPromise = manager.sendPrompt(session.sessionId, 'Hello');
      
      // Wait for sendChat to complete
      await new Promise(r => setImmediate(r));
      
      await manager.cancelPrompt(session.sessionId);
      
      expect(mockGateway.abortChat).toHaveBeenCalledWith(
        session.sessionKey,
        'test-run-id'
      );
      expect(session.currentRunId).toBeNull();

      // Prompt should resolve after cancel
      await promptPromise;
    });

    it('should do nothing if no active run', async () => {
      const session = manager.createSession('/tmp/test');
      
      await manager.cancelPrompt(session.sessionId);
      
      expect(mockGateway.abortChat).not.toHaveBeenCalled();
    });
  });

  describe('handleChatEvent', () => {
    it('should emit agent_message_chunk for delta state', () => {
      const session = manager.createSession('/tmp/test');
      // Initialize run tracking
      session.emittedLengths.set('run-1', { text: 0, thinking: 0 });
      
      const updates: Array<{ sessionId: string; update: unknown }> = [];
      manager.onSessionUpdate = (id, update) => updates.push({ sessionId: id, update });

      const payload: ChatEventPayload = {
        sessionKey: session.sessionKey,
        runId: 'run-1',
        state: 'delta',
        message: {
          role: 'assistant',
          content: [{ type: 'text', text: 'Hello' }],
        },
      };

      manager.handleChatEvent(payload);

      expect(updates).toHaveLength(1);
      expect(updates[0].sessionId).toBe(session.sessionId);
      expect(updates[0].update).toEqual({
        sessionUpdate: 'agent_message_chunk',
        content: { type: 'text', text: 'Hello' },
      });
    });

    it('should only emit new content (delta) not full accumulated text', () => {
      const session = manager.createSession('/tmp/test');
      session.emittedLengths.set('run-1', { text: 0, thinking: 0 });
      
      const updates: unknown[] = [];
      manager.onSessionUpdate = (_, update) => updates.push(update);

      // First chunk
      manager.handleChatEvent({
        sessionKey: session.sessionKey,
        runId: 'run-1',
        state: 'delta',
        message: { role: 'assistant', content: [{ type: 'text', text: 'Hello' }] },
      });

      // Second chunk - gateway sends accumulated text "Hello world"
      manager.handleChatEvent({
        sessionKey: session.sessionKey,
        runId: 'run-1',
        state: 'delta',
        message: { role: 'assistant', content: [{ type: 'text', text: 'Hello world' }] },
      });

      expect(updates).toHaveLength(2);
      expect(updates[0]).toEqual({
        sessionUpdate: 'agent_message_chunk',
        content: { type: 'text', text: 'Hello' },
      });
      expect(updates[1]).toEqual({
        sessionUpdate: 'agent_message_chunk',
        content: { type: 'text', text: ' world' }, // Only the new part
      });
    });

    it('should not emit for final state (avoids duplicates)', () => {
      const session = manager.createSession('/tmp/test');
      session.emittedLengths.set('run-1', { text: 5, thinking: 0 });
      
      const updates: unknown[] = [];
      manager.onSessionUpdate = (_, update) => updates.push(update);

      const payload: ChatEventPayload = {
        sessionKey: session.sessionKey,
        runId: 'run-1',
        state: 'final',
        message: {
          role: 'assistant',
          content: [{ type: 'text', text: 'Hello' }],
        },
      };

      manager.handleChatEvent(payload);

      expect(updates).toHaveLength(0);
    });

    it('should emit agent_thought_chunk for thinking content', () => {
      const session = manager.createSession('/tmp/test');
      session.emittedLengths.set('run-1', { text: 0, thinking: 0 });
      
      const updates: unknown[] = [];
      manager.onSessionUpdate = (_, update) => updates.push(update);

      const payload: ChatEventPayload = {
        sessionKey: session.sessionKey,
        runId: 'run-1',
        state: 'delta',
        message: {
          role: 'assistant',
          content: [{ type: 'thinking', thinking: 'Let me think...' }],
        },
      };

      manager.handleChatEvent(payload);

      expect(updates).toHaveLength(1);
      expect(updates[0]).toEqual({
        sessionUpdate: 'agent_thought_chunk',
        content: { type: 'text', text: 'Let me think...' },
      });
    });

    it('should ignore events for unknown sessions', () => {
      const updates: unknown[] = [];
      manager.onSessionUpdate = (_, update) => updates.push(update);

      const payload: ChatEventPayload = {
        sessionKey: 'agent:main:unknown',
        runId: 'run-1',
        state: 'delta',
        message: {
          role: 'assistant',
          content: [{ type: 'text', text: 'Hello' }],
        },
      };

      manager.handleChatEvent(payload);

      expect(updates).toHaveLength(0);
    });

    it('should clean up tracking on final state', () => {
      const session = manager.createSession('/tmp/test');
      session.emittedLengths.set('run-1', { text: 10, thinking: 0 });

      manager.handleChatEvent({
        sessionKey: session.sessionKey,
        runId: 'run-1',
        state: 'final',
        message: { role: 'assistant', content: [{ type: 'text', text: 'Hello world' }] },
      });

      expect(session.emittedLengths.has('run-1')).toBe(false);
    });

    it('should fetch from history when final arrives with no streamed content', async () => {
      const session = manager.createSession('/tmp/test');
      session.emittedLengths.set('run-1', { text: 0, thinking: 0 }); // No content emitted
      
      // Mock history response with assistant message
      vi.mocked(mockGateway.getChatHistory).mockResolvedValue({
        sessionKey: session.sessionKey,
        sessionId: 'internal-id',
        messages: [
          { role: 'user', content: [{ type: 'text', text: 'Hello' }] },
          { role: 'assistant', content: [
            { type: 'thinking', thinking: 'Let me respond' },
            { type: 'text', text: 'Hi there!' },
          ]},
        ],
      });

      const updates: unknown[] = [];
      manager.onSessionUpdate = (_, update) => updates.push(update);

      // Trigger final with no prior content
      manager.handleChatEvent({
        sessionKey: session.sessionKey,
        runId: 'run-1',
        state: 'final',
        message: { role: 'assistant', content: [] },
      });

      // Wait for async fallback to complete
      await new Promise(r => setTimeout(r, 50));

      // Should have fetched from history
      expect(mockGateway.getChatHistory).toHaveBeenCalledWith(session.sessionKey, 5);
      
      // Should have emitted both thinking and text from history
      expect(updates).toHaveLength(2);
      expect(updates[0]).toEqual({
        sessionUpdate: 'agent_thought_chunk',
        content: { type: 'text', text: 'Let me respond' },
      });
      expect(updates[1]).toEqual({
        sessionUpdate: 'agent_message_chunk',
        content: { type: 'text', text: 'Hi there!' },
      });
    });

    it('should NOT fetch from history when content was streamed', async () => {
      const session = manager.createSession('/tmp/test');
      session.emittedLengths.set('run-1', { text: 10, thinking: 0 }); // Content was emitted
      
      const updates: unknown[] = [];
      manager.onSessionUpdate = (_, update) => updates.push(update);

      manager.handleChatEvent({
        sessionKey: session.sessionKey,
        runId: 'run-1',
        state: 'final',
        message: { role: 'assistant', content: [{ type: 'text', text: 'Hello' }] },
      });

      // Wait a bit to ensure no async operations happen
      await new Promise(r => setTimeout(r, 50));

      // Should NOT have fetched from history
      expect(mockGateway.getChatHistory).not.toHaveBeenCalled();
      
      // Should not emit anything (final doesn't emit content directly)
      expect(updates).toHaveLength(0);
    });

    it('should handle history fetch errors gracefully', async () => {
      const session = manager.createSession('/tmp/test');
      session.emittedLengths.set('run-1', { text: 0, thinking: 0 });
      session.completionResolvers.set('run-1', { 
        resolve: vi.fn(), 
        reject: vi.fn() 
      });
      
      // Mock history to throw an error
      vi.mocked(mockGateway.getChatHistory).mockRejectedValue(new Error('Network error'));

      const updates: unknown[] = [];
      manager.onSessionUpdate = (_, update) => updates.push(update);

      manager.handleChatEvent({
        sessionKey: session.sessionKey,
        runId: 'run-1',
        state: 'final',
        message: { role: 'assistant', content: [] },
      });

      // Wait for async fallback to complete
      await new Promise(r => setTimeout(r, 50));

      // Should still clean up properly despite error
      expect(session.emittedLengths.has('run-1')).toBe(false);
      
      // Completion resolver should have been called (resolved, not rejected)
      const resolver = session.completionResolvers.get('run-1');
      expect(resolver).toBeUndefined(); // Should be deleted after resolution
    });

    it('should handle empty history gracefully', async () => {
      const session = manager.createSession('/tmp/test');
      session.emittedLengths.set('run-1', { text: 0, thinking: 0 });
      
      // Mock empty history
      vi.mocked(mockGateway.getChatHistory).mockResolvedValue({
        sessionKey: session.sessionKey,
        sessionId: 'internal-id',
        messages: [],
      });

      const updates: unknown[] = [];
      manager.onSessionUpdate = (_, update) => updates.push(update);

      manager.handleChatEvent({
        sessionKey: session.sessionKey,
        runId: 'run-1',
        state: 'final',
        message: { role: 'assistant', content: [] },
      });

      await new Promise(r => setTimeout(r, 50));

      // Should not emit anything since no assistant message found
      expect(updates).toHaveLength(0);
    });
  });

  describe('handleAgentEvent', () => {
    it('should emit tool_call for tool stream start', () => {
      const session = manager.createSession('/tmp/test');
      const updates: unknown[] = [];
      manager.onSessionUpdate = (_, update) => updates.push(update);

      const payload: AgentEventPayload = {
        runId: 'run-1',
        sessionKey: session.sessionKey,
        stream: 'tool',
        data: {
          phase: 'start',
          name: 'exec',
          toolCallId: 'call_123',
          args: { command: 'ls -la' },
        },
      };

      manager.handleAgentEvent(payload);

      expect(updates).toHaveLength(1);
      expect(updates[0]).toMatchObject({
        sessionUpdate: 'tool_call',
        toolCallId: 'call_123',
        title: 'exec: ls -la',
        kind: 'execute',
        status: 'in_progress',
        rawInput: { command: 'ls -la' },
      });
    });

    it('should NOT emit for lifecycle events (response lifecycle, not tool)', () => {
      const session = manager.createSession('/tmp/test');
      const updates: unknown[] = [];
      manager.onSessionUpdate = (_, update) => updates.push(update);

      // This is a response lifecycle event, not a tool call
      const payload: AgentEventPayload = {
        runId: 'response-run-1',
        sessionKey: session.sessionKey,
        stream: 'lifecycle',
        data: {
          phase: 'start',
        },
      };

      manager.handleAgentEvent(payload);

      expect(updates).toHaveLength(0);
    });

    it('should emit tool_call_update for tool update phase', () => {
      const session = manager.createSession('/tmp/test');
      const updates: unknown[] = [];
      manager.onSessionUpdate = (_, update) => updates.push(update);

      const payload: AgentEventPayload = {
        runId: 'run-1',
        sessionKey: session.sessionKey,
        stream: 'tool',
        data: {
          phase: 'update',
          toolCallId: 'call_123',
        },
      };

      manager.handleAgentEvent(payload);

      expect(updates).toHaveLength(1);
      expect(updates[0]).toMatchObject({
        sessionUpdate: 'tool_call_update',
        toolCallId: 'call_123',
        status: 'in_progress',
      });
    });

    it('should emit tool_call_update for tool result phase', async () => {
      const session = manager.createSession('/tmp/test');
      const updates: unknown[] = [];
      manager.onSessionUpdate = (_, update) => updates.push(update);

      // Mock getChatHistory to return the tool result
      vi.mocked(mockGateway.getChatHistory).mockResolvedValue({
        sessionKey: session.sessionKey,
        sessionId: session.sessionId,
        messages: [{
          role: 'toolResult',
          toolCallId: 'call_123',
          toolName: 'exec',
          content: [{ type: 'text', text: 'file1.txt\nfile2.txt' }],
          isError: false,
        }],
      });

      const payload: AgentEventPayload = {
        runId: 'run-1',
        sessionKey: session.sessionKey,
        stream: 'tool',
        data: {
          phase: 'result',
          name: 'exec',
          toolCallId: 'call_123',
          meta: 'list files\n\n`ls -la`',
          isError: false,
        },
      };

      manager.handleAgentEvent(payload);

      // Wait for async fetch to complete
      await vi.waitFor(() => expect(updates).toHaveLength(1));

      expect(updates[0]).toMatchObject({
        sessionUpdate: 'tool_call_update',
        toolCallId: 'call_123',
        status: 'completed',
        rawOutput: 'file1.txt\nfile2.txt',
      });
    });

    it('should mark tool as failed on isError', async () => {
      const session = manager.createSession('/tmp/test');
      const updates: unknown[] = [];
      manager.onSessionUpdate = (_, update) => updates.push(update);

      // Mock getChatHistory to return the failed tool result
      vi.mocked(mockGateway.getChatHistory).mockResolvedValue({
        sessionKey: session.sessionKey,
        sessionId: session.sessionId,
        messages: [{
          role: 'toolResult',
          toolCallId: 'call_123',
          content: [{ type: 'text', text: 'Command failed: error' }],
          isError: true,
        }],
      });

      const payload: AgentEventPayload = {
        runId: 'run-1',
        sessionKey: session.sessionKey,
        stream: 'tool',
        data: {
          phase: 'result',
          toolCallId: 'call_123',
          isError: true,
          meta: 'Command failed',
        },
      };

      manager.handleAgentEvent(payload);

      // Wait for async fetch to complete
      await vi.waitFor(() => expect(updates).toHaveLength(1));

      expect(updates[0]).toMatchObject({
        sessionUpdate: 'tool_call_update',
        toolCallId: 'call_123',
        status: 'failed',
      });
    });

    it('should format read tool title with path', () => {
      const session = manager.createSession('/tmp/test');
      const updates: unknown[] = [];
      manager.onSessionUpdate = (_, update) => updates.push(update);

      manager.handleAgentEvent({
        runId: 'run-1',
        sessionKey: session.sessionKey,
        stream: 'tool',
        data: { 
          phase: 'start', 
          name: 'read',
          toolCallId: 'call_123',
          args: { path: '/etc/hosts' },
        },
      });

      expect(updates[0]).toMatchObject({
        sessionUpdate: 'tool_call',
        title: 'read: /etc/hosts',
        kind: 'read',
      });
    });

    it('should emit agent_message_chunk for assistant stream (post-tool response)', () => {
      const session = manager.createSession('/tmp/test');
      const updates: unknown[] = [];
      manager.onSessionUpdate = (_, update) => updates.push(update);

      // Simulate assistant stream after tool call
      manager.handleAgentEvent({
        runId: 'run-1',
        sessionKey: session.sessionKey,
        stream: 'assistant',
        data: {
          text: 'Here are the files in your directory:',
        },
      } as AgentEventPayload);

      expect(updates).toHaveLength(1);
      expect(updates[0]).toMatchObject({
        sessionUpdate: 'agent_message_chunk',
        content: {
          type: 'text',
          text: 'Here are the files in your directory:',
        },
      });
    });

    it('should compute delta for assistant stream (accumulated text)', () => {
      const session = manager.createSession('/tmp/test');
      const updates: unknown[] = [];
      manager.onSessionUpdate = (_, update) => updates.push(update);

      // First chunk
      manager.handleAgentEvent({
        runId: 'run-1',
        sessionKey: session.sessionKey,
        stream: 'assistant',
        data: { text: 'Hello' },
      } as AgentEventPayload);

      // Second chunk (accumulated)
      manager.handleAgentEvent({
        runId: 'run-1',
        sessionKey: session.sessionKey,
        stream: 'assistant',
        data: { text: 'Hello world' },
      } as AgentEventPayload);

      expect(updates).toHaveLength(2);
      expect(updates[0]).toMatchObject({
        sessionUpdate: 'agent_message_chunk',
        content: { text: 'Hello' },
      });
      expect(updates[1]).toMatchObject({
        sessionUpdate: 'agent_message_chunk',
        content: { text: ' world' },
      });
    });
  });

  describe('mapToolKind', () => {
    it('should map known tools correctly', () => {
      expect(manager.mapToolKind('read')).toBe('read');
      expect(manager.mapToolKind('write')).toBe('edit');
      expect(manager.mapToolKind('edit')).toBe('edit');
      expect(manager.mapToolKind('exec')).toBe('execute');
      expect(manager.mapToolKind('search')).toBe('search');
      expect(manager.mapToolKind('delete')).toBe('delete');
    });

    it('should return other for unknown tools', () => {
      expect(manager.mapToolKind('custom_tool')).toBe('other');
      expect(manager.mapToolKind('unknown')).toBe('other');
    });
  });

  describe('historyToAcpUpdates', () => {
    it('should convert user messages', () => {
      const history: ChatMessage[] = [
        { role: 'user', content: [{ type: 'text', text: 'Hello' }] },
      ];

      const updates = manager.historyToAcpUpdates(history);

      expect(updates).toEqual([
        { sessionUpdate: 'user_message_chunk', content: { type: 'text', text: 'Hello' } },
      ]);
    });

    it('should convert assistant messages', () => {
      const history: ChatMessage[] = [
        { role: 'assistant', content: [{ type: 'text', text: 'Hi there!' }] },
      ];

      const updates = manager.historyToAcpUpdates(history);

      expect(updates).toEqual([
        { sessionUpdate: 'agent_message_chunk', content: { type: 'text', text: 'Hi there!' } },
      ]);
    });

    it('should convert thinking content', () => {
      const history: ChatMessage[] = [
        { role: 'assistant', content: [{ type: 'thinking', thinking: 'Let me think...' }] },
      ];

      const updates = manager.historyToAcpUpdates(history);

      expect(updates).toEqual([
        { sessionUpdate: 'agent_thought_chunk', content: { type: 'text', text: 'Let me think...' } },
      ]);
    });

    it('should convert tool use', () => {
      const history: ChatMessage[] = [
        { role: 'assistant', content: [{ type: 'tool_use', id: 'tool-1', name: 'read' }] },
      ];

      const updates = manager.historyToAcpUpdates(history);

      expect(updates).toEqual([
        {
          sessionUpdate: 'tool_call',
          toolCallId: 'tool-1',
          title: 'read',
          kind: 'read',
          status: 'completed',
        },
      ]);
    });

    it('should handle mixed content', () => {
      const history: ChatMessage[] = [
        { role: 'user', content: [{ type: 'text', text: 'Read file.txt' }] },
        {
          role: 'assistant',
          content: [
            { type: 'thinking', thinking: 'I will read the file' },
            { type: 'tool_use', id: 'tool-1', name: 'read' },
            { type: 'text', text: 'Here are the contents...' },
          ],
        },
      ];

      const updates = manager.historyToAcpUpdates(history);

      expect(updates).toHaveLength(4);
      expect(updates[0].sessionUpdate).toBe('user_message_chunk');
      expect(updates[1].sessionUpdate).toBe('agent_thought_chunk');
      expect(updates[2].sessionUpdate).toBe('tool_call');
      expect(updates[3].sessionUpdate).toBe('agent_message_chunk');
    });
  });
});
