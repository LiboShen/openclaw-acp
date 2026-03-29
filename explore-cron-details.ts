/**
 * Explore cron job details to see if they store the origin session.
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
      }, 10000);
    });
  }

  ws.on('message', async (data) => {
    const msg = JSON.parse(data.toString());
    
    if (msg.type === 'event' && msg.event === 'connect.challenge') {
      try {
        await request('connect', {
          minProtocol: 3,
          maxProtocol: 3,
          client: {
            id: 'gateway-client',
            displayName: 'Cron Explorer',
            version: '0.0.1',
            platform: process.platform,
            mode: 'backend',
          },
          auth: { token },
          caps: ['tool-events'],
          role: 'operator',
          scopes: ['operator.admin'],
        });
        
        log('Connected! Fetching cron jobs...');
        
        // List all cron jobs
        const cronList = await request('cron.list', {});
        log('All cron jobs', cronList);
        
        // Also check the cron store file directly
        log('');
        log('Reading cron store file...');
        const cronStorePath = join(homedir(), '.openclaw', 'cron', 'cron-jobs.json');
        try {
          const cronStore = JSON.parse(readFileSync(cronStorePath, 'utf-8'));
          log('Cron store contents', cronStore);
        } catch (e) {
          log('Could not read cron store', (e as Error).message);
        }
        
        process.exit(0);
      } catch (err) {
        log('Error', err);
        process.exit(1);
      }
    } else if (msg.type === 'res') {
      const req = pending.get(msg.id);
      if (req) {
        pending.delete(msg.id);
        if (msg.ok) req.resolve(msg.payload);
        else req.reject(new Error(msg.error?.message));
      }
    }
  });

  ws.on('error', (err) => {
    log('WebSocket error', err.message);
    process.exit(1);
  });
}

main();
