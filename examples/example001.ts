/**
 * @fileoverview Example 001: Connect to the server using the refactored NetworkClient.
 *
 * This script demonstrates the following:
 * 1.  Loading configuration from environment variables (`.env` file).
 * 2.  Using the high-level `NetworkClient` to manage connection and state.
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
import WebSocket from 'isomorphic-ws';
import { NetworkClient } from '../src/main';
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

  const client = new NetworkClient({ url: WEBSOCKET_URL });

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

  // Listen to state changes and spin once when entering IN_GAME
  const onState = ({ current }: { current: string }) => {
    if (current === 'IN_GAME') {
      client.off('state', onState as any);
      spinAcrossLines();
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
        let seenWin = false;
        let seenLose = false;
        let attempts = 0;
        while (!(seenWin && seenLose) && attempts < 50) {
          attempts++;
          console.log(`Spin #${attempts} with lines=${lines}...`);
          const { totalwin, results } = (await client.spin({ lines })) as any;
          if (totalwin > 0) {
            seenWin = true;
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
            seenLose = true;
            console.log('No win on this spin.');
          }
          // spin already waited for cmdret and returned the summarized result
        }
        if (!(seenWin && seenLose)) {
          console.warn(
            `Stopping early on lines=${lines} after ${attempts} attempts (did not observe both win and no-win).`
          );
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
    // 1. Connect and log in
    await client.connect(TOKEN);
    console.log('Client connected and logged in successfully.');

    // 2. Enter the game
    await client.enterGame(GAME_CODE);
    console.log(`Entered game ${GAME_CODE}. Waiting until fully IN_GAME to send spin...`);

    // The 'message' event handler will now take over to send the game action
    // when it receives the first gameuserinfo message with a ctrlid.
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
