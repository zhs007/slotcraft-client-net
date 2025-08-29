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
  client.on('disconnect', payload => {
    console.log(`Client disconnected. Reason: ${payload.reason}`);
    process.exit(0);
  });

  client.on('error', error => {
    console.error('An error occurred:', error);
  });

  client.on('message', msg => {
    // We received an async message from the server that was not a direct response to a command
    console.log('Received async message:', msg);
    // In a real client, you would check msg.msgid and update game state accordingly.
    // For this example, we're particularly interested in 'gameuserinfo' to get the ctrlid.
    if (msg.msgid === 'gameuserinfo' && msg.ctrlid) {
      console.log(`Ready to send game actions. Received ctrlid: ${msg.ctrlid}`);
      // Now we can send the spin command
      sendGameAction(msg.ctrlid);
    }
  });

  const sendGameAction = async (ctrlid: number) => {
    try {
      console.log('Sending game action (spin)...');
      await client.send('gamectrl3', {
        gameid: 101, // Example gameid, adjust if needed
        ctrlid: ctrlid,
        ctrlname: 'spin',
        ctrlparam: { bet: 1, lines: 10, times: 1 },
      });
      console.log('Game action successful. Disconnecting.');
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
    console.log(`Entered game ${GAME_CODE}. Waiting for gameuserinfo to get ctrlid...`);

    // The 'message' event handler will now take over to send the game action
    // when it receives the first gameuserinfo message with a ctrlid.
  } catch (error) {
    console.error('Failed during connection or entering game:', error);
    client.disconnect();
    process.exit(1);
  }
};

main().catch(err => {
  console.error('An unexpected error occurred in main:', err);
  process.exit(1);
});
