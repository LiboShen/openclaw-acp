/**
 * ACP session state management.
 */

import { randomUUID } from 'crypto';
import type { SessionUpdate } from '@agentclientprotocol/sdk';
import type { GatewayClient } from '../gateway/client.js';
import type { ChatEventPayload, AgentEventPayload, ChatMessage } from '../gateway/types.js';

export interface SessionState {
  sessionId: string;
  sessionKey: string;
  cwd: string;
  agentId: string;
  currentRunId: string | null;
  /** Track emitted content length per run to compute deltas */
  emittedLengths: Map<string, { text: number; thinking: number }>;
  /** Promise resolvers for waiting on prompt completion */
  completionResolvers: Map<string, { resolve: () => void; reject: (err: Error) => void }>;
}

type ToolKind = 'read' | 'edit' | 'delete' | 'move' | 'search' | 'execute' | 'think' | 'fetch' | 'switch_mode' | 'other';

export class SessionManager {
  private sessions = new Map<string, SessionState>();
  private gateway: GatewayClient;
  private defaultAgentId = 'main';

  // Callbacks for ACP notifications
  onSessionUpdate?: (sessionId: string, update: SessionUpdate) => void;

  constructor(gateway: GatewayClient) {
    this.gateway = gateway;
  }

  /**
   * Create a new session.
   */
  createSession(cwd: string): SessionState {
    const sessionId = randomUUID();
    const sessionKey = this.buildSessionKey(sessionId);

    const state: SessionState = {
      sessionId,
      sessionKey,
      cwd,
      agentId: this.defaultAgentId,
      currentRunId: null,
      emittedLengths: new Map(),
      completionResolvers: new Map(),
    };

    this.sessions.set(sessionId, state);
    return state;
  }

  /**
   * Load an existing session.
   * Fetches history from gateway and returns it for replay to client.
   */
  async loadSession(sessionId: string, cwd: string): Promise<{ state: SessionState; history: ChatMessage[] }> {
    const sessionKey = this.buildSessionKey(sessionId);

    // Try to get history - if session doesn't exist, gateway returns empty messages
    let history: ChatMessage[] = [];
    try {
      const historyResult = await this.gateway.getChatHistory(sessionKey);
      history = historyResult.messages ?? [];
    } catch {
      // Session might not exist yet, that's okay - we'll create it on first prompt
    }
    
    const state: SessionState = {
      sessionId,
      sessionKey,
      cwd,
      agentId: this.defaultAgentId,
      currentRunId: null,
      emittedLengths: new Map(),
      completionResolvers: new Map(),
    };

    this.sessions.set(sessionId, state);
    return { state, history };
  }

  /**
   * Build gateway session key from ACP session ID.
   */
  buildSessionKey(sessionId: string): string {
    return `agent:${this.defaultAgentId}:${sessionId}`;
  }

  /**
   * Get session by ID.
   */
  getSession(sessionId: string): SessionState | undefined {
    return this.sessions.get(sessionId);
  }

  /**
   * Get session by gateway sessionKey.
   */
  getSessionByKey(sessionKey: string): SessionState | undefined {
    for (const session of this.sessions.values()) {
      if (session.sessionKey === sessionKey) {
        return session;
      }
    }
    return undefined;
  }

  /**
   * Get all active sessions.
   */
  getAllSessions(): SessionState[] {
    return Array.from(this.sessions.values());
  }

  /**
   * Remove a session from memory.
   */
  removeSession(sessionId: string): void {
    this.sessions.delete(sessionId);
  }

  /**
   * Send a prompt and wait for completion.
   * Returns when the response is fully streamed.
   */
  async sendPrompt(sessionId: string, text: string): Promise<void> {
    const session = this.sessions.get(sessionId);
    if (!session) {
      throw new Error(`Session not found: ${sessionId}`);
    }

    console.error('[openclaw-acp] Sending prompt to gateway:', session.sessionKey);
    const { runId } = await this.gateway.sendChat(session.sessionKey, text);
    console.error('[openclaw-acp] Got runId:', runId);
    
    session.currentRunId = runId;
    // Reset emitted lengths for new run
    session.emittedLengths.set(runId, { text: 0, thinking: 0 });

    // Wait for completion
    return new Promise((resolve, reject) => {
      session.completionResolvers.set(runId, { resolve, reject });
      
      // Safety timeout - if no response in 60s, reject
      const timeout = setTimeout(() => {
        if (session.completionResolvers.has(runId)) {
          session.completionResolvers.delete(runId);
          console.error('[openclaw-acp] Prompt timeout after 60s, runId:', runId);
          reject(new Error('Prompt timeout - no response from gateway'));
        }
      }, 60000);
      
      // Clear timeout when resolved/rejected
      const originalResolve = resolve;
      const originalReject = reject;
      session.completionResolvers.set(runId, {
        resolve: () => { clearTimeout(timeout); originalResolve(); },
        reject: (err) => { clearTimeout(timeout); originalReject(err); },
      });
    });
  }

  /**
   * Cancel the current prompt.
   */
  async cancelPrompt(sessionId: string): Promise<void> {
    const session = this.sessions.get(sessionId);
    if (!session) return;

    if (session.currentRunId) {
      const runId = session.currentRunId;
      await this.gateway.abortChat(session.sessionKey, runId);
      session.currentRunId = null;
      
      // Resolve the completion promise (cancelled is still a valid completion)
      const resolver = session.completionResolvers.get(runId);
      if (resolver) {
        session.completionResolvers.delete(runId);
        resolver.resolve(); // Resolve, not reject - cancellation is handled via stopReason
      }
    }
  }

  /**
   * Handle chat event from gateway.
   * 
   * The gateway sends accumulated content on each event, not deltas.
   * We track what we've emitted and only send the new portion.
   */
  handleChatEvent(payload: ChatEventPayload): void {
    const session = this.getSessionByKey(payload.sessionKey);
    if (!session) {
      if (process.env.DEBUG) {
        console.error('[openclaw-acp] Chat event for unknown session:', payload.sessionKey);
      }
      return;
    }

    // Log chat events in debug mode
    if (process.env.DEBUG) {
      console.error('[openclaw-acp] Chat event:', payload.state, 'seq:', payload.seq);
    }

    const runId = payload.runId;
    
    // Initialize tracking for this run if needed
    if (!session.emittedLengths.has(runId)) {
      session.emittedLengths.set(runId, { text: 0, thinking: 0 });
    }
    const emitted = session.emittedLengths.get(runId)!;

    // Only process delta state (not final, to avoid duplicates)
    if (payload.state !== 'delta') {
      // On final, clean up tracking and resolve completion promise
      if (payload.state === 'final') {
        const emittedContent = emitted.text + emitted.thinking;
        if (emittedContent === 0) {
          console.error('[openclaw-acp] WARNING: Received final with no content emitted. runId:', runId);
          console.error('[openclaw-acp] Payload:', JSON.stringify(payload));
        }
        
        session.emittedLengths.delete(runId);
        session.currentRunId = null;
        
        // Resolve the completion promise
        const resolver = session.completionResolvers.get(runId);
        if (resolver) {
          session.completionResolvers.delete(runId);
          resolver.resolve();
        }
      }
      return;
    }

    // Extract and emit new content
    if (payload.message?.content) {
      for (const item of payload.message.content) {
        if (item.type === 'text' && item.text) {
          const fullText = item.text;
          const newText = fullText.slice(emitted.text);
          
          if (newText.length > 0) {
            const update: SessionUpdate = {
              sessionUpdate: 'agent_message_chunk',
              content: {
                type: 'text',
                text: newText,
              },
            };
            this.onSessionUpdate?.(session.sessionId, update);
            emitted.text = fullText.length;
          }
        } else if (item.type === 'thinking' && item.thinking) {
          const fullThinking = item.thinking;
          const newThinking = fullThinking.slice(emitted.thinking);
          
          if (newThinking.length > 0) {
            const update: SessionUpdate = {
              sessionUpdate: 'agent_thought_chunk',
              content: {
                type: 'text',
                text: newThinking,
              },
            };
            this.onSessionUpdate?.(session.sessionId, update);
            emitted.thinking = fullThinking.length;
          }
        }
      }
    }

    // Legacy format: delta field contains actual delta
    if (payload.delta) {
      const update: SessionUpdate = {
        sessionUpdate: 'agent_message_chunk',
        content: {
          type: 'text',
          text: payload.delta,
        },
      };
      this.onSessionUpdate?.(session.sessionId, update);
    }

    // Handle error status
    if (payload.status === 'error') {
      session.currentRunId = null;
      session.emittedLengths.delete(runId);
      
      // Reject the completion promise
      const resolver = session.completionResolvers.get(runId);
      if (resolver) {
        session.completionResolvers.delete(runId);
        resolver.reject(new Error(payload.error ?? 'Unknown error'));
      }
    }
  }

  /**
   * Handle agent event from gateway (tool calls and assistant stream).
   * 
   * Gateway sends different stream types:
   * - "tool": tool call lifecycle (start, update, result)
   * - "assistant": assistant response after tool calls
   * - "lifecycle": response lifecycle (ignored, just for tracking)
   */
  handleAgentEvent(payload: AgentEventPayload): void {
    const session = payload.sessionKey ? this.getSessionByKey(payload.sessionKey) : null;
    if (!session) {
      // Log unmatched events for debugging
      if (process.env.DEBUG) {
        console.error('[openclaw-acp] Agent event for unknown session:', payload.sessionKey);
      }
      return;
    }

    // Log all agent events in debug mode
    if (process.env.DEBUG) {
      console.error('[openclaw-acp] Agent event:', payload.stream, payload.data?.phase ?? '');
    }

    // Handle assistant stream (response after tool calls)
    if (payload.stream === 'assistant') {
      this.handleAssistantStream(session, payload);
      return;
    }

    // Only handle tool stream events below
    if (payload.stream !== 'tool') return;

    const toolCallId = payload.data.toolCallId ?? payload.runId;
    const toolName = payload.data.name ?? payload.data.tool ?? 'tool';

    switch (payload.data.phase) {
      case 'start': {
        // Tool call started - include rawInput
        const update: SessionUpdate = {
          sessionUpdate: 'tool_call',
          toolCallId,
          title: this.formatToolTitle(toolName, payload.data.args),
          kind: this.mapToolKind(toolName),
          status: 'in_progress',
          rawInput: payload.data.args,
        };
        this.onSessionUpdate?.(session.sessionId, update);
        break;
      }

      case 'update': {
        // Tool execution update (still running)
        const update: SessionUpdate = {
          sessionUpdate: 'tool_call_update',
          toolCallId,
          status: 'in_progress',
        };
        this.onSessionUpdate?.(session.sessionId, update);
        break;
      }

      case 'result': {
        // Tool completed - include rawOutput and content
        const isError = payload.data.isError ?? false;
        const meta = payload.data.meta;
        
        const update: SessionUpdate = {
          sessionUpdate: 'tool_call_update',
          toolCallId,
          status: isError ? 'failed' : 'completed',
          rawOutput: payload.data.output ?? meta,
          content: meta ? [{
            type: 'content' as const,
            content: { type: 'text' as const, text: meta },
          }] : undefined,
        };
        this.onSessionUpdate?.(session.sessionId, update);
        break;
      }

      case 'end': {
        // Legacy end phase (fallback)
        const update: SessionUpdate = {
          sessionUpdate: 'tool_call_update',
          toolCallId,
          status: payload.data.error ? 'failed' : 'completed',
          rawOutput: payload.data.output,
          content: payload.data.output ? [{
            type: 'content' as const,
            content: { type: 'text' as const, text: String(payload.data.output) },
          }] : undefined,
        };
        this.onSessionUpdate?.(session.sessionId, update);
        break;
      }
    }
  }

  /**
   * Handle assistant stream events (response after tool calls).
   * 
   * The gateway sends assistant text via agent events with stream: "assistant"
   * after tool calls complete. This contains the assistant's response.
   */
  private handleAssistantStream(session: SessionState, payload: AgentEventPayload): void {
    const runId = payload.runId;
    const data = payload.data as { text?: string; delta?: string };
    
    // Initialize tracking for this run if needed
    if (!session.emittedLengths.has(runId)) {
      session.emittedLengths.set(runId, { text: 0, thinking: 0 });
    }
    const emitted = session.emittedLengths.get(runId)!;

    // The gateway may send full text or delta
    const fullText = data.text ?? '';
    const newText = fullText.slice(emitted.text);

    if (newText.length > 0) {
      emitted.text = fullText.length;

      const update: SessionUpdate = {
        sessionUpdate: 'agent_message_chunk',
        content: {
          type: 'text',
          text: newText,
        },
      };
      this.onSessionUpdate?.(session.sessionId, update);
    }
  }

  /**
   * Format a human-readable title for a tool call.
   */
  private formatToolTitle(toolName: string, args?: Record<string, unknown>): string {
    if (!args) return toolName;

    // Format based on common tools
    switch (toolName) {
      case 'exec':
        return args.command ? `exec: ${args.command}` : 'exec';
      case 'read':
        return args.path ? `read: ${args.path}` : 'read';
      case 'write':
        return args.path ? `write: ${args.path}` : 'write';
      case 'edit':
        return args.path ? `edit: ${args.path}` : 'edit';
      default:
        return toolName;
    }
  }

  /**
   * Map gateway tool names to ACP ToolKind.
   */
  mapToolKind(toolName: string): ToolKind {
    const mapping: Record<string, ToolKind> = {
      'read': 'read',
      'write': 'edit',
      'edit': 'edit',
      'apply_patch': 'edit',
      'exec': 'execute',
      'search': 'search',
      'delete': 'delete',
    };
    return mapping[toolName] ?? 'other';
  }

  /**
   * Convert gateway history to ACP format for replay.
   */
  historyToAcpUpdates(history: ChatMessage[]): SessionUpdate[] {
    const updates: SessionUpdate[] = [];

    for (const msg of history) {
      if (msg.role === 'user') {
        for (const content of msg.content) {
          if (content.type === 'text' && content.text) {
            updates.push({
              sessionUpdate: 'user_message_chunk',
              content: { type: 'text', text: content.text },
            });
          }
        }
      } else if (msg.role === 'assistant') {
        for (const content of msg.content) {
          if (content.type === 'text' && content.text) {
            updates.push({
              sessionUpdate: 'agent_message_chunk',
              content: { type: 'text', text: content.text },
            });
          } else if (content.type === 'thinking' && content.thinking) {
            updates.push({
              sessionUpdate: 'agent_thought_chunk',
              content: { type: 'text', text: content.thinking },
            });
          } else if (content.type === 'tool_use') {
            const toolName = content.name ?? 'tool';
            updates.push({
              sessionUpdate: 'tool_call',
              toolCallId: content.id ?? randomUUID(),
              title: toolName,
              kind: this.mapToolKind(toolName),
              status: 'completed',
            });
          }
        }
      }
    }

    return updates;
  }
}
