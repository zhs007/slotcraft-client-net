/**
 * @fileoverview Example 001: Connect to the server, log communication, and perform a basic game flow.
 *
 * This script demonstrates the following:
 * 1.  Loading configuration from environment variables (`.env` file).
 * 2.  Connecting to the WebSocket server using the library's `Connection` class.
 * 3.  Logging all sent and received messages to a file (`msg001.txt`).
 * 4.  Executing a standard sequence: check version, login, enter game, and perform a game action.
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
import { Connection } from '../src/connection';

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

const logMessage = (direction: 'SEND' | 'RECV', data: any) => {
  const message = typeof data === 'string' ? data : JSON.stringify(data);
  const timestamp = new Date().toISOString();
  const logEntry = `[${direction}] ${timestamp}: ${message}\n\n`;
  try {
    fs.appendFileSync(LOG_FILE, logEntry);
  } catch (err) {
    console.error(`Failed to write to log file ${LOG_FILE}:`, err);
  }
};

// --- 2. Main Application Logic ---

console.log(`Connecting to ${WEBSOCKET_URL}...`);
console.log(`Logging communication to ${LOG_FILE}`);

// Clear the log file at the start.
fs.writeFileSync(LOG_FILE, '--- WebSocket Communication Log ---\n\n');

const connection = new Connection(WEBSOCKET_URL);

// State variable to hold the control ID from the server.
let ctrlid: number | null = null;

const sendJson = (data: object) => {
  const message = JSON.stringify(data);
  logMessage('SEND', message);
  connection.send(message);
};

connection.onOpen = () => {
  console.log('Connection opened. Sending version check...');
  sendJson({
    cmdid: 'checkver',
    nativever: 1710120,
    scriptver: 1712260,
    clienttype: 'web',
    businessid: 'demo',
  });
};

connection.onClose = event => {
  console.log(`Connection closed. Code: ${event.code}, Reason: ${event.reason}`);
  process.exit(0);
};

connection.onError = event => {
  console.error('WebSocket error:', event);
  process.exit(1);
};

connection.onMessage = event => {
  const data = JSON.parse(event.data);
  logMessage('RECV', data);

  // The server can send a single message or an array of messages
  const messages = Array.isArray(data) ? data : [data];

  for (const msg of messages) {
    switch (msg.msgid) {
      case 'cmdret':
        handleCmdRet(msg);
        break;
      case 'gameuserinfo':
        // Store the critical ctrlid for the next command
        if (msg.ctrlid) {
          console.log(`Received game user info with new ctrlid: ${msg.ctrlid}`);
          ctrlid = msg.ctrlid;
        }
        break;
      case 'gamecfg':
        // Received game config, now we can send a game control command.
        console.log('Received game config. Sending game action (spin)...');
        if (ctrlid !== null) {
          sendJson({
            cmdid: 'gamectrl3',
            gameid: 101, // Example gameid, adjust if needed
            ctrlid: ctrlid,
            ctrlname: 'spin',
            ctrlparam: { bet: 1, lines: 10, times: 1 },
          });
        } else {
          console.error('Error: Cannot send gamectrl3, ctrlid is not set.');
          connection.disconnect();
        }
        break;
      // Add other message handlers as needed, for now we just log them.
      default:
        console.log(`Received message: ${msg.msgid}`);
    }
  }
};

const handleCmdRet = (msg: { cmdid: string; isok: boolean }) => {
  console.log(`Received command result for '${msg.cmdid}': ${msg.isok ? 'OK' : 'FAIL'}`);

  if (!msg.isok) {
    console.error(`Command '${msg.cmdid}' failed. Closing connection.`);
    connection.disconnect();
    return;
  }

  // State machine for the connection flow
  switch (msg.cmdid) {
    case 'checkver':
      console.log('Version check successful. Logging in...');
      sendJson({
        cmdid: 'flblogin',
        token: TOKEN,
        language: 'en_US',
        gamecode: GAME_CODE,
      });
      break;
    case 'flblogin':
      console.log('Login successful. Entering game...');
      sendJson({
        cmdid: 'comeingame3',
        gamecode: GAME_CODE,
        tableid: 't1',
        isreconnect: false,
      });
      break;
    case 'comeingame3':
      console.log('Successfully entered game. Waiting for gamecfg to send spin...');
      // The logic now waits for the 'gamecfg' message to trigger the spin.
      break;
    case 'gamectrl3':
      console.log('Game action (spin) successful. Closing connection.');
      // This is the end of our example flow.
      setTimeout(() => connection.disconnect(), 1000); // Wait a second before disconnecting.
      break;
  }
};

// --- 3. Start the connection ---
connection.connect();
