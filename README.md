# openclaw-acp

[Agent Client Protocol (ACP)](https://agentclientprotocol.com) adapter for OpenClaw via Gateway.

OpenClaw includes a native `openclaw acp` command, but it's a minimal implementation with limited features. This adapter provides a fuller ACP implementation by bridging through OpenClaw's local gateway, offering streaming support, session persistence, and reliable reconnection.

## How It Works

```
┌──────────────┐      stdio      ┌───────────────┐     WebSocket     ┌─────────────────┐
│  ACP Client  │◄───────────────►│  openclaw-acp │◄──────────────────►│ OpenClaw Gateway│
│  (Zed, AFK)  │   ACP JSON-RPC  │               │  Gateway protocol  │  (localhost)    │
└──────────────┘                 └───────────────┘                    └─────────────────┘
```

## Features

- **Full ACP protocol support**: initialize, session/new, session/load, session/prompt, session/cancel
- **Streaming responses**: Real-time text and tool call updates
- **Session persistence**: Sessions are stored in the gateway and can be resumed
- **Automatic reconnection**: Reconnects to gateway with exponential backoff
- **History replay**: On session/load, replays full conversation history

## Prerequisites

- OpenClaw installed and gateway running (`openclaw` command available)
- Gateway token configured in `~/.openclaw/openclaw.json`

## Usage

### With Zed

Add to your Zed `settings.json`:

```json
{
  "agent_servers": {
    "openclaw": {
      "type": "custom",
      "command": "npx",
      "args": ["-y", "openclaw-acp"],
      "env": {}
    }
  }
}
```

### With [AFK](https://github.com/LiboShen/afk-host)

The AFK host can use this adapter by configuring it in `AcpAgents`:

```dart
static const openclawAcp = AcpAgentConfig(
  id: 'openclaw',
  name: 'OpenClaw',
  command: 'npx',
  args: ['-y', 'openclaw-acp'],
  detectCommand: 'openclaw',
);
```

## Development

```bash
npm install
npm run dev        # Run from source
npm run build      # Build for distribution
npm run typecheck  # Type check
npm test           # Run tests
npm run test:watch # Run tests in watch mode
```

## Testing

The project includes comprehensive unit tests for:

- **SessionManager** (`test/session.test.ts`): Session creation, loading, prompt handling, event translation
- **GatewayClient** (`test/gateway.test.ts`): Connection, authentication, reconnection, event handling

Run tests:
```bash
npm test
```

## Architecture

```
src/
├── index.ts              # Entry point
├── acp/
│   ├── server.ts         # ACP server using @agentclientprotocol/sdk
│   └── session.ts        # Session state management
└── gateway/
    ├── client.ts         # WebSocket client with reconnection
    └── types.ts          # Gateway protocol types
```

### Key Components

**GatewayClient** (`src/gateway/client.ts`)
- WebSocket connection to OpenClaw gateway
- Automatic reconnection with exponential backoff
- Request/response correlation
- Event dispatching (chat, agent events)

**SessionManager** (`src/acp/session.ts`)
- Maps ACP sessions to gateway sessions
- Translates gateway events to ACP SessionUpdate notifications
- Handles history replay for session/load

**AcpServer** (`src/acp/server.ts`)
- Implements ACP Agent interface
- Handles stdio communication via ndJsonStream
- Orchestrates gateway client and session manager

## Protocol Translation

| ACP Method | Gateway Action |
|------------|----------------|
| `initialize` | Connect to gateway (WebSocket auth) |
| `session/new` | Generate UUID, store in memory |
| `session/load` | Fetch history via `chat.history`, replay to client |
| `session/prompt` | `chat.send` (streaming via events) |
| `session/cancel` | `chat.abort` |

| Gateway Event | ACP Notification |
|---------------|------------------|
| `chat` (delta) | `session/update` → `agent_message_chunk` |
| `chat` (thinking) | `session/update` → `agent_thought_chunk` |
| `agent` (lifecycle start) | `session/update` → `tool_call` |
| `agent` (lifecycle end) | `session/update` → `tool_call_update` |

## License

MIT
