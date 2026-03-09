/**
 * OpenClaw Gateway protocol types.
 */

export interface GatewayRequest {
  type: 'req';
  id: string;
  method: string;
  params?: Record<string, unknown>;
}

export interface GatewayResponse {
  type: 'res';
  id: string;
  ok: boolean;
  payload?: Record<string, unknown>;
  error?: { code: string; message: string };
}

export interface GatewayEvent {
  type: 'event';
  event: string;
  payload?: Record<string, unknown>;
}

export type GatewayMessage = GatewayResponse | GatewayEvent;

// Chat events
export interface ChatEventPayload {
  sessionKey: string;
  runId: string;
  seq?: number;
  state?: 'delta' | 'final';
  message?: {
    role: 'assistant' | 'user';
    content: Array<{ type: 'text' | 'thinking'; text?: string; thinking?: string }>;
    timestamp?: number;
  };
  // Legacy format (may also be present)
  delta?: string;
  content?: string;
  status?: 'streaming' | 'complete' | 'error';
  error?: string;
}

// Agent events (tool calls)
export interface AgentEventPayload {
  runId: string;
  sessionKey?: string;
  stream: 'lifecycle' | 'tool' | 'assistant' | 'output';
  data: {
    phase?: 'start' | 'end' | 'update' | 'result';
    // Tool info
    name?: string;
    tool?: string;
    toolCallId?: string;
    args?: Record<string, unknown>;
    // Result info
    meta?: string;
    isError?: boolean;
    output?: unknown;
    error?: string;
    // Lifecycle info
    startedAt?: number;
    endedAt?: number;
  };
  seq?: number;
  ts?: number;
}

// Session info from sessions.list
export interface SessionInfo {
  key: string;
  kind: string;
  displayName?: string;
  sessionId: string;
  updatedAt: number;
  inputTokens?: number;
  outputTokens?: number;
  totalTokens?: number;
  modelProvider?: string;
  model?: string;
}

// Message from chat.history
export interface ChatMessage {
  role: 'user' | 'assistant' | 'system';
  content: ChatContent[];
  timestamp?: number;
  stopReason?: string;
  errorMessage?: string;
}

export interface ChatContent {
  type: 'text' | 'thinking' | 'tool_use' | 'tool_result';
  text?: string;
  thinking?: string;
  id?: string;
  name?: string;
  input?: Record<string, unknown>;
}

// Chat history response
export interface ChatHistoryResponse {
  sessionKey: string;
  sessionId: string;
  messages: ChatMessage[];
  thinkingLevel?: string;
}
