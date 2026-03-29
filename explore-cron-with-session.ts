/**
 * Test: Create a cron job with explicit sessionKey to see if it routes back.
 */

import WebSocket from 'ws';
import { readFileSync } from 'fs';
import { homedir } from 'os';
import { join } from 'path';
import { randomUUID } from 'crypto';

const GATEWAY_URL = 'ws://127.0.0.1:18789';

function loadToken(): string {
  const configPath = join(homedir(), '.openclaw', 'openclaw.json');
  const config = JSON.parse(readFileSync(configPath, 'utf-8'));
  return config?.gateway?.auth?.token ?? '';
}

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
  const ws = new WebSocket(GATEWAY_URL);
  const pending = new Map<string, { resolve: (v: unknown) => void; reject: (e: Error) => void }>();
  
  // Create a unique session key for this test
  const testSessionId = randomUUID();
  const testSessionKey = `agent:main:${testSessionId}`;

  function request(method: string, params: Record<string, unknown>): Promise<unknown> {
    return new Promise((resolve, reject) => {
      const id = randomUUID();
      pending.set(id, { resolve, reject });
      ws.send(JSON.stringify({ type: 'req', id, method, params }));
      setTimeout(() => {
        if (pending.has(id)) {
          pending.delete(id);
          reject(new Error(`Timeout: ${method}`));
        }
      }, 30000);
    });
  }

  ws.on('message', async (data) => {
    const msg = JSON.parse(data.toString());
    
    if (msg.type === 'event') {
      if (msg.event === 'connect.challenge') {
        try {
          await request('connect', {
            minProtocol: 3,
            maxProtocol: 3,
            client: {
              id: 'gateway-client',
              displayName: 'Session Cron Test',
              version: '0.0.1',
              platform: process.platform,
              mode: 'backend',
            },
            auth: { token },
            caps: ['tool-events'],
            role: 'operator',
            scopes: ['operator.admin'],
          });
          
          log('Connected!');
          log(`Test session key: ${testSessionKey}`);
          log('');
          
          // Create a cron job with explicit sessionKey
          const triggerTime = new Date(Date.now() + 30 * 1000); // 30 seconds from now
          const cronJob = {
            name: 'session-test-timer',
            sessionKey: testSessionKey,  // <-- Explicitly set the session!
            sessionTarget: 'isolated',  // Use isolated but with sessionKey
            schedule: {
              kind: 'at',
              at: triggerTime.toISOString(),
            },
            payload: {
              kind: 'agentTurn',
              message: 'SESSION TEST: This should route to the original session!',
            },
            delivery: {
              mode: 'none',  // Don't try to deliver externally
            },
            deleteAfterRun: true,
            enabled: true,
          };
          
          log('Creating cron job with sessionKey:', cronJob);
          
          const result = await request('cron.add', { job: cronJob });
          log('Cron created', result);
          
          log('');
          log('='.repeat(60));
          log('Waiting for cron to fire (30 seconds)...');
          log(`Watching for events on sessionKey: ${testSessionKey}`);
          log('='.repeat(60));
          
          // Wait for events
          setTimeout(() => {
            log('');
            log('Test complete. Exiting.');
            process.exit(0);
          }, 60 * 1000);
          
        } catch (err) {
          log('Error', err);
          process.exit(1);
        }
      } else if (msg.event === 'chat' || msg.event === 'agent') {
        const payload = msg.payload;
        const sessionKey = payload?.sessionKey;
        
        // Highlight if this matches our test session
        const isOurs = sessionKey === testSessionKey || sessionKey?.startsWith(testSessionKey);
        const marker = isOurs ? '★★★ OUR SESSION ★★★' : '';
        
        log(`EVENT: ${msg.event} ${marker}`, {
          sessionKey,
          runId: payload?.runId,
          stream: payload?.stream,
          data: payload?.data,
          state: payload?.state,
          message: payload?.message,
        });
      } else if (msg.event === 'cron') {
        log('EVENT: cron', msg.payload);
      }
    } else if (msg.type === 'res') {
      const req = pending.get(msg.id);
      if (req) {
        pending.delete(msg.id);
        if (msg.ok) req.resolve(msg.payload);
        else {
          log('Request failed', msg.error);
          req.reject(new Error(msg.error?.message));
        }
      }
    }
  });

  ws.on('error', (err) => {
    log('WebSocket error', err.message);
    process.exit(1);
  });
}

main();
