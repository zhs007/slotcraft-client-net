/**
 * @fileoverview Core type definitions for the network library.
 */

/**
 * Defines the possible states of the network client's connection.
 */
export enum ConnectionState {
  /** The client is idle and not connected. */
  IDLE = 'IDLE',
  /** The client is in the process of connecting. */
  CONNECTING = 'CONNECTING',
  /** The client has an active WebSocket connection. */
  CONNECTED = 'CONNECTED',
  /** The client is logging in. */
  LOGGING_IN = 'LOGGING_IN',
  /** The client is logged in successfully. */
  LOGGED_IN = 'LOGGED_IN',
  /** The client is entering a game. */
  ENTERING_GAME = 'ENTERING_GAME',
  /** The client is in a game and ready to send/receive game messages. */
  IN_GAME = 'IN_GAME',
  /** The client is disconnected and will attempt to reconnect. */
  RECONNECTING = 'RECONNECTING',
  /** The client is permanently disconnected and will not reconnect. */
  DISCONNECTED = 'DISCONNECTED',
}

/**
 * Configuration options for initializing the NetworkClient.
 */
export interface NetworkClientOptions {
  /** The WebSocket URL of the game server. */
  url: string;
  /** The user's authentication token. */
  token: string;
  /** The specific game code to enter. */
  gamecode: string;
  /** Optional: Maximum number of reconnection attempts. Defaults to 10. */
  maxReconnectAttempts?: number;
  /** Optional: Initial reconnection delay in ms. Defaults to 1000. */
  reconnectDelay?: number;
}

/**
 * Represents the user's core information managed by the network client.
 */
export interface UserInfo {
  /** The authentication token. */
  token: string;
  /** The control ID for requests, managed by the client. */
  ctrlid: number;
  /** The user's balance. */
  balance: number;
  /** The current game code. */
  gamecode: string;
}

/**
 * Represents a generic message sent from the server.
 */
export interface BaseServerMessage {
  /** The command or type of the message. */
  cmd: string;
  /** Optional: The control ID this message is a response to. */
  ctrlid?: number;
  /** Optional: Error number. 0 or absent for success. */
  errno?: number;
  /** Optional: Error message. */
  error?: string;
  /** The main data payload. */
  data: any;
}

/**
 * Represents a generic message sent from the client.
 */
export interface BaseClientMessage {
  /** The command to be executed. */
  cmd: string;
  /** The control ID for this request. */
  ctrlid: number;
  /** The main data payload. */
  data: any;
}

/**
 * Defines the structure for event listeners.
 */
export type EventCallback = (...args: any[]) => void;

/**
 * Defines the payload for the 'disconnect' event.
 */
export interface DisconnectEventPayload {
  /** The WebSocket close event code. */
  code: number;
  /** A description of why the connection was closed. */
  reason: string;
  /** Indicates if the disconnection was clean or unexpected. */
  wasClean: boolean;
}
