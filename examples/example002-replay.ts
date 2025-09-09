/**
 * @fileoverview Example 002: Demonstrate the Replay Mode of SlotcraftClient.
 *
 * This script demonstrates the following:
 * 1.  Instantiating the client in "replay mode" using a local JSON file.
 * 2.  Running the same core application logic as `example001.ts`.
 * 3.  Verifying that the client can complete a game flow (connect, enter, spin, collect)
 *     without any actual network connection.
 *
 * To Run:
 * 1.  Ensure `examples/replay-data.json` exists.
 * 2.  Execute with ts-node: `npx ts-node examples/example002-replay.ts`
 */

import * as fs from 'fs';
import { SlotcraftClient } from '../src/main';
import { ConnectionState, RawMessagePayload } from '../src/types';

// In replay mode, WebSocket is not needed, so we don't polyfill it.

// --- 1. Configuration and Setup ---

const LOG_FILE = 'msg002-replay.txt';
const REPLAY_URL = './examples/replay-data.json'; // Path to the local replay file

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
  console.log(`Running in Replay Mode with data from: ${REPLAY_URL}`);
  console.log(`Logging communication to ${LOG_FILE}`);

  // Clear the log file at the start.
  fs.writeFileSync(LOG_FILE, '--- Replay Mode Communication Log ---\n\n');

  const client = new SlotcraftClient({
    // Instead of a `url`, we provide a `replayUrl`.
    replayUrl: REPLAY_URL,
    // Token and gamecode are still useful for context, though not for connection.
    token: 'replay-token',
    gamecode: 'hoodlums',
    businessid: 'replay-business',
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

  client.on('message', (msg) => {
    console.log('Received async message:', msg);
  });

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
   * A simple demonstration function that performs one spin and collects.
   * This is simplified from example001 to be more direct for testing replay.
   */
  const testSpinAndCollect = async () => {
    console.log('--- Starting Spin ---');
    // We don't need to specify lines/bet as the result is predetermined.
    await client.spin({});

    // After a spin, the game might require a choice or a collect.
    if (client.getState() === ConnectionState.SPINEND) {
      const { lastTotalWin } = client.getUserInfo();
      console.log(`Action resulted in a win. totalwin=${lastTotalWin}. Collecting...`);
      await client.collect();
      console.log('Collect finished.');
    } else if (client.getState() === ConnectionState.WAITTING_PLAYER) {
      console.log('Action resulted in a player choice. This is not expected in this replay data.');
    }

    console.log('Finished test spin.');
  };

  try {
    // 1. Connect (simulated)
    await client.connect();
    console.log('Client connected and logged in successfully (simulated).');

    // 2. Enter the game (simulated)
    await client.enterGame();
    console.log(`Entered game. Initial state: ${client.getState()}`);

    // 3. Handle Resume Logic
    // This logic is important to test that replay mode correctly initializes the state.
    if (client.getState() === ConnectionState.SPINEND) {
      console.log('Game needs collection on resume. Collecting...');
      await client.collect();
      console.log('Resume collect finished.');
    }

    // 4. Start Main Spin Logic
    console.log('Client is IN_GAME. Starting main test sequence.');
    await testSpinAndCollect();

    console.log('Example replay script finished. Disconnecting.');
    client.disconnect();
  } catch (error) {
    console.error('An error occurred during the client lifecycle:', error);
    if (client.getState() !== ConnectionState.DISCONNECTED) {
      client.disconnect();
    }
    process.exit(1);
  }
};

main().catch((err) => {
  console.error('An unexpected error occurred in main:', err);
  process.exit(1);
});
