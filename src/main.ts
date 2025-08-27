import { Connection } from './connection';
import { EventEmitter } from './event-emitter';
import {
  ConnectionState,
  NetworkClientOptions,
  UserInfo,
  BaseServerMessage,
  DisconnectEventPayload,
} from './types';

type PendingRequest = {
  resolve: (value: any) => void;
  reject: (reason?: any) => void;
};

type QueuedRequest = {
  cmd: string;
  data: any;
  resolve: (value: any) => void;
  reject: (reason?: any) => void;
};

export class NetworkClient {
  private options: NetworkClientOptions;
  private connection: Connection;
  private state: ConnectionState = ConnectionState.IDLE;
  private userInfo: Partial<UserInfo> = { ctrlid: 0 };
  private heartbeatInterval: NodeJS.Timeout | null = null;
  private emitter = new EventEmitter();
  private pendingRequests = new Map<number, PendingRequest>();
  private requestQueue: QueuedRequest[] = [];

  private reconnectAttempts = 0;
  private reconnectTimeout: NodeJS.Timeout | null = null;

  private connectPromise: {
    resolve: () => void;
    reject: (reason?: any) => void;
  } | null = null;

  constructor(options: NetworkClientOptions) {
    this.options = {
      maxReconnectAttempts: 10,
      reconnectDelay: 1000,
      ...options,
    };
    this.connection = new Connection(this.options.url);
    this.setupConnectionHandlers();
  }

  // --- Public API ---

  public getState(): ConnectionState {
    return this.state;
  }

  public connect(): Promise<void> {
    if (this.state === ConnectionState.CONNECTING || this.state === ConnectionState.IN_GAME) {
      return Promise.reject(new Error('Client is already connected or connecting.'));
    }
    this.state = ConnectionState.CONNECTING;
    this.connection.connect();

    return new Promise<void>((resolve, reject) => {
      this.connectPromise = { resolve, reject };
    });
  }

  public disconnect(): void {
    this.stopHeartbeat();
    this.clearReconnectTimer();
    this.state = ConnectionState.DISCONNECTED;
    this.connection.disconnect();
    this.rejectAllPendingRequests('Client disconnected.');
  }

  public send(cmd: string, data: any = {}): Promise<any> {
    if (this.state === ConnectionState.RECONNECTING) {
      console.log(`Queueing request: ${cmd}`);
      return new Promise((resolve, reject) => {
        this.requestQueue.push({ cmd, data, resolve, reject });
      });
    }

    if (this.state !== ConnectionState.IN_GAME) {
      return Promise.reject(new Error(`Cannot send message in state: ${this.state}`));
    }

    const ctrlid = ++this.userInfo.ctrlid!;
    const message = JSON.stringify({ cmd, ctrlid, data });
    this.connection.send(message);

    return new Promise((resolve, reject) => {
      this.pendingRequests.set(ctrlid, { resolve, reject });
    });
  }

  public on(event: string, callback: (...args: any[]) => void) { this.emitter.on(event, callback); }
  public off(event: string, callback: (...args: any[]) => void) { this.emitter.off(event, callback); }
  public once(event: string, callback: (...args: any[]) => void) { this.emitter.once(event, callback); }

  // --- Private Handlers ---

  private setupConnectionHandlers(): void {
    this.connection.onOpen = this.handleOpen.bind(this);
    this.connection.onMessage = this.handleMessage.bind(this);
    this.connection.onClose = this.handleClose.bind(this);
    this.connection.onError = this.handleError.bind(this);
  }

  private _send(cmd: string, data: any = {}): void {
    const ctrlid = this.userInfo.ctrlid ? ++this.userInfo.ctrlid : 1;
    this.userInfo.ctrlid = ctrlid;
    const message = JSON.stringify({ cmd, ctrlid, data });
    this.connection.send(message);
  }

  private handleOpen(): void {
    this.emitter.emit('connect');
    this.state = ConnectionState.CONNECTED;
    this.reconnectAttempts = 0; // Reset on successful connection
    this.clearReconnectTimer();
    this.state = ConnectionState.LOGGING_IN;
    this._send('login', { token: this.options.token });
  }

  private handleMessage(event: MessageEvent): void {
    try {
      const message: BaseServerMessage = JSON.parse(event.data);

      if (message.ctrlid && this.pendingRequests.has(message.ctrlid)) {
        const promise = this.pendingRequests.get(message.ctrlid)!;
        if (message.errno) { promise.reject(message); } else { promise.resolve(message.data); }
        this.pendingRequests.delete(message.ctrlid);
        return;
      }

      if (message.errno) {
        console.error(`Received server error: ${message.error} (errno: ${message.errno})`);
        this.emitter.emit('error', message);
        this.disconnect();
        return;
      }

      switch (message.cmd) {
        case 'login':
          this.userInfo = { ...message.data, ctrlid: this.userInfo.ctrlid };
          this.state = ConnectionState.LOGGED_IN;
          this.state = ConnectionState.ENTERING_GAME;
          this._send('enter_game', { gamecode: this.options.gamecode });
          break;

        case 'enter_game':
          this.userInfo.gamecode = this.options.gamecode;
          this.state = ConnectionState.IN_GAME;
          this.startHeartbeat();
          this.processRequestQueue();
          this.connectPromise?.resolve();
          this.connectPromise = null;
          this.emitter.emit('ready');
          break;

        case 'keepalive':
          break;

        default:
          this.emitter.emit('data', message);
          break;
      }
    } catch (error) {
      console.error('Failed to parse server message:', event.data);
      this.emitter.emit('error', new Error('Failed to parse server message'));
    }
  }

  private handleClose(event?: CloseEvent): void {
    this.stopHeartbeat();
    const payload: DisconnectEventPayload = {
      code: event?.code || 0,
      reason: event?.reason || 'Unknown',
      wasClean: event?.wasClean || false,
    };
    this.emitter.emit('disconnect', payload);

    if (!payload.wasClean) {
      this.tryReconnect();
    } else {
      this.connectPromise?.reject(new Error(`Disconnected: ${payload.reason}`));
      this.connectPromise = null;
      this.rejectAllPendingRequests('Connection closed.');
      this.state = ConnectionState.DISCONNECTED;
    }
  }

  private handleError(event: Event): void {
    console.error('WebSocket error observed:', event);
    this.emitter.emit('error', event);
    // Don't change state here, let the onClose event handle it
  }

  private tryReconnect(): void {
    if (this.reconnectAttempts >= this.options.maxReconnectAttempts!) {
      console.error('Max reconnection attempts reached. Giving up.');
      this.state = ConnectionState.DISCONNECTED;
      this.rejectAllPendingRequests('Reconnection failed.');
      this.connectPromise?.reject(new Error('Reconnection failed.'));
      this.connectPromise = null;
      return;
    }

    this.state = ConnectionState.RECONNECTING;
    this.emitter.emit('reconnecting', { attempt: this.reconnectAttempts + 1 });

    const delay = this.options.reconnectDelay! * Math.pow(2, this.reconnectAttempts);
    this.reconnectAttempts++;

    this.reconnectTimeout = setTimeout(() => {
      console.log(`Attempting to reconnect... (attempt ${this.reconnectAttempts})`);
      // We call the connection's connect method directly to avoid creating a new public promise
      this.connection.connect();
    }, Math.min(delay, 30000)); // Cap delay at 30s
  }

  private clearReconnectTimer(): void {
    if (this.reconnectTimeout) {
      clearTimeout(this.reconnectTimeout);
      this.reconnectTimeout = null;
    }
  }

  private startHeartbeat(): void {
    this.stopHeartbeat();
    this.heartbeatInterval = setInterval(() => { this._send('keepalive'); }, 30000);
  }

  private stopHeartbeat(): void {
    if (this.heartbeatInterval) {
      clearInterval(this.heartbeatInterval);
      this.heartbeatInterval = null;
    }
  }

  private rejectAllPendingRequests(reason: string): void {
    for (const request of this.pendingRequests.values()) {
      request.reject(new Error(reason));
    }
    this.pendingRequests.clear();
    for (const queued of this.requestQueue) {
      queued.reject(new Error(reason));
    }
    this.requestQueue = [];
  }

  private processRequestQueue(): void {
    const queue = [...this.requestQueue];
    this.requestQueue = [];
    console.log(`Processing ${queue.length} queued requests...`);
    for (const req of queue) {
      this.send(req.cmd, req.data)
        .then(req.resolve)
        .catch(req.reject);
    }
  }
}
