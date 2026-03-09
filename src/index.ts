#!/usr/bin/env node
/**
 * openclaw-acp - ACP adapter for OpenClaw via Gateway
 *
 * Bridges the ACP (Agent Client Protocol) to OpenClaw's local gateway,
 * providing a reliable ACP interface without using OpenClaw's buggy native ACP.
 */

import { startServer } from './acp/server.js';

startServer();
