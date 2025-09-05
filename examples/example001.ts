/**
 * @fileoverview Example 001: Connect to the server using the refactored SlotcraftClient.
 *
 * This script demonstrates the following:
 * 1.  Loading configuration from environment variables (`.env` file).
 * 2.  Using the high-level `SlotcraftClient` to manage connection and state.
 * 3.  Logging all raw WebSocket traffic using the `raw_message` event.
 * 4.  Executing a standard sequence: connect -> enter game -> perform action.
 *
 * To Run:
 * 1.  Create a `.env` file in the root directory with the following content:
 *     WEBSOCKET_URL=ws://your-server-url
 *     TOKEN=your-login-token
 *     GAME_CODE=your-game-code
 * 2.  Execute with ts-node: `npx ts-node examples/example001.ts`
 */

import * as dotenv from 'dotenv';
import * as fs from 'fs';
import WebSocket from 'ws';
import { SlotcraftClient } from '../src/main';
import { RawMessagePayload } from '../src/types';

// Polyfill WebSocket for the Connection class, which expects it to be global.
(global as any).WebSocket = WebSocket;

// --- 1. Configuration and Setup ---

dotenv.config();

const { WEBSOCKET_URL, TOKEN, GAME_CODE } = process.env;
const LOG_FILE = 'msg001.txt';

if (!WEBSOCKET_URL || !TOKEN || !GAME_CODE) {
  console.error(
    'Error: Missing required environment variables. Please create a .env file with WEBSOCKET_URL, TOKEN, and GAME_CODE.'
  );
  process.exit(1);
}

const logRawMessage = (payload: RawMessagePayload) => {
  const { direction, message } = payload;
  const timestamp = new Date().toISOString();
  const logEntry = `[${direction}] ${timestamp}: ${message}\n\n`;
  try {
    fs.appendFileSync(LOG_FILE, logEntry);
  } catch (err) {
    console.error(`Failed to write to log file ${LOG_FILE}:`, err);
  }
};

// --- 2. Main Application Logic ---

const main = async () => {
  console.log(`Connecting to ${WEBSOCKET_URL}...`);
  console.log(`Logging communication to ${LOG_FILE}`);

  // Clear the log file at the start.
  fs.writeFileSync(LOG_FILE, '--- WebSocket Communication Log ---\n\n');

  const client = new SlotcraftClient({
    url: WEBSOCKET_URL,
    token: TOKEN,
    gamecode: GAME_CODE,
  });

  // Setup logging
  client.on('raw_message', logRawMessage);

  // Listen for other events
  client.on('disconnect', (payload) => {
    console.log(`Client disconnected. Reason: ${payload.reason}`);
    process.exit(0);
  });

  client.on('error', (error) => {
    console.error('An error occurred:', error);
  });

  // Persistently log messages only, and print parsed gamecfg data if available
  client.on('message', (msg) => {
    console.log('Received async message:', msg);
    if (msg?.msgid === 'gamecfg' && typeof msg.data === 'string') {
      try {
        const parsed = JSON.parse(msg.data);
        console.log('Parsed gamecfg.data:', parsed);
        // Also show derived lines options
        const info = client.getUserInfo();
        if (Array.isArray(info.linesOptions)) {
          console.log('Derived lines options:', info.linesOptions);
        }
      } catch {
        console.warn('Failed to parse gamecfg.data');
      }
    }
  });

  // Listen to state changes: log state transitions and append to LOG_FILE with a clear marker
  const onState = ({ current, data }: { current: string; data?: any }) => {
    console.log(`State change: ${current}`);
    const ts = new Date().toISOString();
    const entry = `[STATE] ${ts}: ${current}\n\n`;
    try {
      fs.appendFileSync(LOG_FILE, entry);
    } catch (err) {
      console.error(`Failed to write state to log file ${LOG_FILE}:`, err);
    }

    // Handle WAITTING_PLAYER state
    if (current === 'WAITTING_PLAYER') {
      console.log('Detected WAITTING_PLAYER state. Checking for optionals...');
      const userInfo = client.getUserInfo();
      if (userInfo.optionals && userInfo.optionals.length > 0) {
        const randomIndex = Math.floor(Math.random() * userInfo.optionals.length);
        console.log(`Randomly selecting optional index: ${randomIndex}`);
        client.selectOptional(randomIndex).catch((err) => {
          console.error('Failed to select optional:', err);
          client.disconnect();
        });
      } else {
        console.warn('WAITTING_PLAYER state but no optionals found. Disconnecting.');
        client.disconnect();
      }
    }
  };
  client.on('state', onState as any);

  const spinAcrossLines = async () => {
    try {
      // Already IN_GAME: read linesOptions directly
      const opts = client.getUserInfo().linesOptions || [];
      if (!opts.length) {
        console.warn('No linesOptions available after entering IN_GAME; skipping spins.');
        client.disconnect();
        return;
      }
      console.log('Starting sequential spins over lines options:', opts);
      // spin() now returns the latest GMI summary at cmdret

      for (const lines of opts) {
        console.log(`--- Lines=${lines} ---`);
        for (let i = 0; i < 100; i++) {
          console.log(`Spin #${i + 1}/100 with lines=${lines}...`);
          const { totalwin, results } = (await client.spin({ lines })) as any;
          if (totalwin > 0) {
            console.log(
              `Win detected. totalwin=${totalwin}, results=${results}. Will collect to continue...`
            );
            try {
              // Collect sequence: client.collect() derives playIndex plan (pre + final) if needed
              await client.collect();
              console.log('Collect finished.');
            } catch (err) {
              console.warn('Collect failed; retrying spins may be blocked until resolved:', err);
              break;
            }
          } else {
            console.log('No win on this spin.');
          }
        }
      }
      console.log('Finished spinning across all lines. Disconnecting.');
      client.disconnect();
    } catch (error) {
      console.error('Failed to send game action:', error);
      client.disconnect();
    }
  };

  try {
    // 1. Connect and log in (token is now read from constructor options)
    await client.connect();
    console.log('Client connected and logged in successfully.');

    // 2. Enter the game (gamecode is now read from constructor options)
    await client.enterGame();
    console.log(`Entered game ${GAME_CODE}. Using enterGame cmdret to start spins immediately.`);

    // Start spins immediately after enterGame returns (cmdret should indicate comeingame)
    spinAcrossLines();
  } catch (error) {
    console.error('Failed during connection or entering game:', error);
    client.disconnect();
    process.exit(1);
  }
};

main().catch((err) => {
  console.error('An unexpected error occurred in main:', err);
  process.exit(1);
});
