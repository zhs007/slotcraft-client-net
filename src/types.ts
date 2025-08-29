/**
 * @fileoverview Core type definitions for the network library.
 */

/**
 * Defines the possible states of the network client's connection.
 */
export enum ConnectionState {
  /** The client is idle and not connected. */
  IDLE = 'IDLE',
  /** The client is in the process of connecting and logging in. */
  CONNECTING = 'CONNECTING',
  /** The client has logged in and is ready to enter a game. */
  CONNECTED = 'CONNECTED',
  /** The client is in the process of entering a game. */
  ENTERING_GAME = 'ENTERING_GAME',
  /** The client is in a game and ready to send/receive game messages. */
  IN_GAME = 'IN_GAME',
  /** The client finished a spin and waits for collect decision. */
  SPINEND = 'SPINEND',
  /** A spin (gamectrl3) is in flight. */
  SPINNING = 'SPINNING',
  /** A collect command is in flight after a win. */
  COLLECTING = 'COLLECTING',
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
  /** Optional: Maximum number of reconnection attempts. Defaults to 10. */
  maxReconnectAttempts?: number;
  /** Optional: Initial reconnection delay in ms. Defaults to 1000. */
  reconnectDelay?: number;
  /** Optional: Timeout for a single request in ms. Defaults to 10000. */
  requestTimeout?: number;
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

/**
 * Defines the payload for the 'raw_message' event.
 */
export interface RawMessagePayload {
  /** The direction of the message. */
  direction: 'SEND' | 'RECV';
  /** The raw message content as a string. */
  message: string;
}

/**
 * Payload for state change notifications.
 */
export interface StateChangePayload {
  previous: ConnectionState;
  current: ConnectionState;
  // Optional contextual data for this transition (e.g., { gmi })
  data?: any;
}

/**
 * Cached user and game-related information.
 */
export interface UserInfo {
  // Session/login
  token?: string;
  // Identity
  pid?: string;
  uid?: number;
  nickname?: string;
  // Wallet & jurisdiction
  balance?: number; // from userbaseinfo.gold
  currency?: string;
  jurisdiction?: string;
  // Game context
  gamecode?: string;
  gameid?: number;
  ctrlid?: number;
  lastctrlid?: number;
  // Latest player state payload from 'gameuserinfo'
  playerState?: any;
  // Game config
  defaultLinebet?: number;
  linebets?: number[];
  // Game config versions
  gamecfgVer?: string;
  gamecfgCoreVer?: string;
  // Parsed gamecfg.data (JSON string parsed to object)
  gamecfgData?: any;
  // Allowed lines options (from gamecfg.bets or parsed gamecfgData keys)
  linesOptions?: number[];
  // Last play metadata from gamemoduleinfo
  lastPlayIndex?: number;
  lastPlayWin?: number; // playwin only
  lastTotalWin?: number; // totalwin used to judge win
  lastResultsCount?: number; // replyPlay.results.length
  // Last full gamemoduleinfo payload
  lastGMI?: any;
}

/**
 * Options for a spin action.
 */
export interface SpinParams {
  bet?: number; // if omitted, use defaultLinebet when available
  lines?: number; // if omitted, use min of linesOptions when available
  times?: number;
  autonums?: number;
  ctrlname?: string; // default: 'spin'
  // Allow extra ctrlparam fields if needed
  [key: string]: any;
}
