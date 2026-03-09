/**
 * ACP server - handles ACP protocol over stdio.
 */

import {
  AgentSideConnection,
  ndJsonStream,
  type Agent,
  type InitializeRequest,
  type InitializeResponse,
  type NewSessionRequest,
  type NewSessionResponse,
  type LoadSessionRequest,
  type LoadSessionResponse,
  type PromptRequest,
  type PromptResponse,
  type CancelNotification,
  type AuthenticateRequest,
  type SessionUpdate,
} from '@agentclientprotocol/sdk';
import { GatewayClient } from '../gateway/client.js';
import { SessionManager } from './session.js';

/**
 * OpenClaw ACP Agent implementation.
 */
class OpenClawAgent implements Agent {
  private conn: AgentSideConnection;
  private gateway: GatewayClient;
  private sessionManager: SessionManager;
  private initialized = false;

  constructor(conn: AgentSideConnection) {
    this.conn = conn;

    // Create gateway client with event handlers
    this.gateway = new GatewayClient({
      onChat: (payload) => this.sessionManager.handleChatEvent(payload),
      onAgent: (payload) => this.sessionManager.handleAgentEvent(payload),
      onDisconnect: () => this.handleGatewayDisconnect(),
    });

    this.sessionManager = new SessionManager(this.gateway);

    // Wire session updates to ACP notifications
    this.sessionManager.onSessionUpdate = (sessionId, update) => {
      this.sendSessionUpdate(sessionId, update);
    };
  }

  async initialize(_params: InitializeRequest): Promise<InitializeResponse> {
    // Connect to gateway on initialize
    if (!this.initialized) {
      try {
        await this.gateway.connect();
        this.initialized = true;
      } catch (err) {
        throw new Error(`Failed to connect to OpenClaw gateway`, { cause: err });
      }
    }

    return {
      protocolVersion: 1,
      agentInfo: {
        name: 'openclaw-acp',
        title: 'OpenClaw ACP Adapter',
        version: '0.0.1',
      },
      agentCapabilities: {
        loadSession: true,
      },
    };
  }

  async newSession(params: NewSessionRequest): Promise<NewSessionResponse> {
    const cwd = params.cwd ?? process.cwd();
    const state = this.sessionManager.createSession(cwd);
    return { sessionId: state.sessionId };
  }

  async loadSession(params: LoadSessionRequest): Promise<LoadSessionResponse> {
    const { sessionId, cwd } = params;
    if (!sessionId) {
      throw new Error('sessionId required');
    }

    const { history } = await this.sessionManager.loadSession(
      sessionId,
      cwd ?? process.cwd()
    );

    // Replay history as session updates
    const updates = this.sessionManager.historyToAcpUpdates(history);
    for (const update of updates) {
      this.sendSessionUpdate(sessionId, update);
    }

    return {};
  }

  async prompt(params: PromptRequest): Promise<PromptResponse> {
    const { sessionId, prompt } = params;
    if (!sessionId) {
      throw new Error('sessionId required');
    }

    // Extract text from prompt content
    const text = this.extractPromptText(prompt);
    if (!text) {
      throw new Error('Empty prompt');
    }

    // Send to gateway (streaming handled via events)
    await this.sessionManager.sendPrompt(sessionId, text);

    // Return when complete - streaming happens via session/update
    return { stopReason: 'end_turn' };
  }

  async cancel(params: CancelNotification): Promise<void> {
    const { sessionId } = params;
    if (sessionId) {
      await this.sessionManager.cancelPrompt(sessionId);
    }
  }

  async authenticate(_params: AuthenticateRequest): Promise<void> {
    // No-op - gateway handles auth via token
  }

  // --- Private ---

  private handleGatewayDisconnect(): void {
    process.stderr.write('[openclaw-acp] Gateway disconnected\n');
  }

  private sendSessionUpdate(sessionId: string, update: SessionUpdate): void {
    void this.conn.sessionUpdate({ sessionId, update });
  }

  private extractPromptText(prompt: unknown): string | null {
    if (!Array.isArray(prompt)) return null;

    const texts: string[] = [];
    for (const item of prompt) {
      if (typeof item === 'object' && item !== null) {
        const content = item as Record<string, unknown>;
        if (content.type === 'text' && typeof content.text === 'string') {
          texts.push(content.text);
        }
      }
    }

    return texts.join('\n') || null;
  }
}

/**
 * Start the ACP server.
 */
export function startServer(): void {
  // Create stdio streams
  const output = new WritableStream<Uint8Array>({
    write(chunk) {
      process.stdout.write(chunk);
    },
  });

  const input = new ReadableStream<Uint8Array>({
    start(controller) {
      process.stdin.on('data', (chunk) => controller.enqueue(new Uint8Array(chunk)));
      process.stdin.on('end', () => controller.close());
      process.stdin.on('error', (err) => controller.error(err));
    },
  });

  // Create stream and connection
  const stream = ndJsonStream(output, input);
  new AgentSideConnection((conn) => new OpenClawAgent(conn), stream);

  // Keep stdin open
  process.stdin.resume();

  // Handle signals
  process.on('SIGINT', () => process.exit(0));
  process.on('SIGTERM', () => process.exit(0));
}
