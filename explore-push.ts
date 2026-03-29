/**
 * Exploration script to test agent-initiated push messages.
 * 
 * 1. Connect to OpenClaw gateway
 * 2. Ask agent to set a reminder for 1 minute
 * 3. Wait and observe what events come through
 */

import WebSocket from 'ws';
import { readFileSync } from 'fs';
import { homedir } from 'os';
import { join } from 'path';
import { randomUUID } from 'crypto';

const GATEWAY_URL = 'ws://127.0.0.1:18789';

// Load gateway token
function loadToken(): string {
  const configPath = join(homedir(), '.openclaw', 'openclaw.json');
  const config = JSON.parse(readFileSync(configPath, 'utf-8'));
  return config?.gateway?.auth?.token ?? '';
}

// Pretty print with timestamp
function log(label: string, data?: unknown) {
  const ts = new Date().toISOString().slice(11, 23);
  if (data !== undefined) {
    console.log(`[${ts}] ${label}:`, JSON.stringify(data, null, 2));
  } else {
    console.log(`[${ts}] ${label}`);
  }
}

async function main() {
  const token = loadToken();
  if (!token) {
    console.error('No gateway token found. Run `openclaw configure` first.');
    process.exit(1);
  }

  log('Connecting to gateway...');
  
  const ws = new WebSocket(GATEWAY_URL);
  const pending = new Map<string, { resolve: (v: unknown) => void; reject: (e: Error) => void }>();
  
  let sessionKey: string | null = null;
  let connected = false;

  // Send request and wait for response
  function request(method: string, params: Record<string, unknown>): Promise<unknown> {
    return new Promise((resolve, reject) => {
      const id = randomUUID();
      pending.set(id, { resolve, reject });
      
      const req = { type: 'req', id, method, params };
      log(`>>> ${method}`, params);
      ws.send(JSON.stringify(req));
      
      // Timeout after 60s
      setTimeout(() => {
        if (pending.has(id)) {
          pending.delete(id);
          reject(new Error(`Request timeout: ${method}`));
        }
      }, 60000);
    });
  }

  ws.on('open', () => {
    log('WebSocket connected, waiting for challenge...');
  });

  ws.on('message', async (data) => {
    const msg = JSON.parse(data.toString());
    
    if (msg.type === 'event') {
      if (msg.event === 'connect.challenge') {
        log('Got challenge, authenticating...');
        
        try {
          await request('connect', {
            minProtocol: 3,
            maxProtocol: 3,
            client: {
              id: 'gateway-client',
              displayName: 'Push Explorer',
              version: '0.0.1',
              platform: process.platform,
              mode: 'backend',
            },
            auth: { token },
            caps: ['tool-events'],
            role: 'operator',
            scopes: ['operator.admin'],
          });
          
          connected = true;
          log('✓ Connected and authenticated!');
          
          // Get session defaults
          log('Fetching sessions...');
          const sessionsResult = await request('sessions.list', { limit: 5 }) as { sessions: Array<{ key: string; displayName?: string }> };
          log('Sessions', sessionsResult);
          
          // Use the main session or create one
          sessionKey = sessionsResult.sessions?.[0]?.key ?? 'agent:main:explore-push';
          log(`Using session: ${sessionKey}`);
          
          // Send a message asking to set a reminder
          log('');
          log('='.repeat(60));
          log('Sending reminder request to agent...');
          log('='.repeat(60));
          
          const chatResult = await request('chat.send', {
            sessionKey,
            message: 'Please set a reminder/timer for exactly 1 minute from now. When it triggers, send me a message saying "TIMER FIRED! This is the push notification test." Use the cron or reminder tool if available.',
            idempotencyKey: randomUUID(),
          });
          
          log('chat.send result', chatResult);
          log('');
          log('='.repeat(60));
          log('Now waiting for events... (will wait up to 3 minutes)');
          log('='.repeat(60));
          
          // Set a timeout to exit after 3 minutes
          setTimeout(() => {
            log('');
            log('='.repeat(60));
            log('Timeout reached (3 minutes). Exiting.');
            log('='.repeat(60));
            process.exit(0);
          }, 3 * 60 * 1000);
          
        } catch (err) {
          log('Auth error', err);
          process.exit(1);
        }
      } else {
        // Log ALL events
        const eventType = msg.event;
        const isInteresting = ['chat', 'agent'].includes(eventType);
        
        if (isInteresting) {
          log('');
          log(`★★★ EVENT: ${eventType} ★★★`, msg.payload);
        } else {
          // Still log other events but less prominently
          log(`EVENT: ${eventType}`, msg.payload);
        }
      }
    } else if (msg.type === 'res') {
      const req = pending.get(msg.id);
      if (req) {
        pending.delete(msg.id);
        if (msg.ok) {
          req.resolve(msg.payload);
        } else {
          log('<<< ERROR', msg.error);
          req.reject(new Error(msg.error?.message ?? 'Unknown error'));
        }
      }
    }
  });

  ws.on('error', (err) => {
    log('WebSocket error', err.message);
  });

  ws.on('close', () => {
    log('WebSocket closed');
    if (!connected) {
      process.exit(1);
    }
  });
}

main().catch((err) => {
  console.error('Fatal error:', err);
  process.exit(1);
});
