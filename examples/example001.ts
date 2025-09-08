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
  };
  client.on('state', onState as any);

  /**
   * This is the main game loop. It checks the client's state and decides the next action.
   * This logic is crucial for handling game resume scenarios correctly.
   */
  const gameLoop = async () => {
    try {
      // Loop indefinitely, breaking out only when all actions are complete.
      while (true) {
        const state = client.getState();
        const userInfo = client.getUserInfo();
        console.log(`Main loop entered. Current state: ${state}`);

        if (state === 'SPINEND') {
          console.log('State is SPINEND. Awaiting collection.');
          const { lastTotalWin, lastResultsCount } = userInfo;
          console.log(
            `Win detected. totalwin=${lastTotalWin}, results=${lastResultsCount}. Will collect to continue...`
          );
          await client.collect();
          console.log('Collect finished. Re-evaluating state...');
          continue; // Loop again to check the new state (should be IN_GAME)
        }

        if (state === 'WAITTING_PLAYER') {
          console.log('State is WAITTING_PLAYER. Awaiting player selection.');
          if (userInfo.optionals && userInfo.optionals.length > 0) {
            const randomIndex = Math.floor(Math.random() * userInfo.optionals.length);
            console.log(
              `Found ${userInfo.optionals.length} options. Randomly selecting index: ${randomIndex}`
            );
            await client.selectOptional(randomIndex);
            console.log('Selection sent. Re-evaluating state...');
            continue; // Loop again to see the outcome of the selection
          } else {
            console.error('In WAITTING_PLAYER state but no optionals found. Disconnecting.');
            client.disconnect();
            break;
          }
        }

        if (state === 'IN_GAME') {
          console.log('State is IN_GAME. Starting spin sequence.');
          // Once we are in the standard "IN_GAME" state, we can run the main spin logic.
          await spinAcrossLines();
          // After the spin sequence is complete, we are done.
          break;
        }

        // If the state is not one of the above, it's an unexpected state for the loop to handle.
        console.error(`Game loop in unhandled state: ${state}. Disconnecting.`);
        client.disconnect();
        break;
      }
    } catch (error) {
      console.error('An error occurred in the game loop:', error);
      client.disconnect();
    }
  };

  const spinAcrossLines = async () => {
    const opts = client.getUserInfo().linesOptions || [];
    if (!opts.length) {
      console.warn('No linesOptions available; cannot perform spins.');
      return; // Return instead of disconnecting, allows loop to terminate gracefully.
    }
    console.log('Starting sequential spins over lines options:', opts);

    for (const lines of opts) {
      console.log(`--- Lines=${lines} ---`);
      for (let i = 0; i < 100; i++) {
        console.log(`Spin #${i + 1}/100 with lines=${lines}...`);
        // We start in IN_GAME, so a spin is safe.
        await client.spin({ lines });

        // After spin, the state could be SPINEND, WAITTING_PLAYER, or back to IN_GAME.
        // The main gameLoop is designed to handle this, so we can just let it re-evaluate.
        // For simplicity in this example, we'll handle the immediate results here,
        // mirroring the logic from the main loop.

        let currentState = client.getState();
        if (currentState === 'WAITTING_PLAYER') {
          const userInfo = client.getUserInfo();
          if (userInfo.optionals && userInfo.optionals.length > 0) {
            const randomIndex = Math.floor(Math.random() * userInfo.optionals.length);
            console.log(`Spin resulted in a choice. Randomly selecting: ${randomIndex}`);
            await client.selectOptional(randomIndex);
          }
        }

        // After a spin or a selection, we might need to collect.
        currentState = client.getState();
        if (currentState === 'SPINEND') {
          const { lastTotalWin, lastResultsCount } = client.getUserInfo();
          console.log(
            `Action resulted in a win. totalwin=${lastTotalWin}, results=${lastResultsCount}. Collecting...`
          );
          await client.collect();
          console.log('Collect finished.');
        } else {
          console.log('No win on this action.');
        }
      }
    }
    console.log('Finished spinning across all lines.');
  };

  try {
    // 1. Connect and log in
    await client.connect();
    console.log('Client connected and logged in successfully.');

    // 2. Enter the game
    await client.enterGame();
    console.log(`Entered game ${GAME_CODE}. Current state: ${client.getState()}`);

    // 3. Start the main game loop to handle resume states and then normal play.
    await gameLoop();

    console.log('Game loop finished. Disconnecting.');
    client.disconnect();
  } catch (error) {
    console.error('Failed during client lifecycle:', error);
    if (client.getState() !== 'DISCONNECTED') {
      client.disconnect();
    }
    process.exit(1);
  }
};

main().catch((err) => {
  console.error('An unexpected error occurred in main:', err);
  process.exit(1);
});
