import { Connection } from './connection';
import { EventEmitter } from './event-emitter';
import {
  ConnectionState,
  NetworkClientOptions,
  DisconnectEventPayload,
  RawMessagePayload,
} from './types';

type PendingRequest = {
  resolve: (value: any) => void;
  reject: (reason?: any) => void;
  timer: ReturnType<typeof setTimeout>;
};

export class NetworkClient {
  private options: NetworkClientOptions;
  private connection: Connection;
  private state: ConnectionState = ConnectionState.IDLE;
  private heartbeatInterval: ReturnType<typeof setInterval> | null = null;
  private emitter = new EventEmitter();
  private pendingRequests = new Map<string, PendingRequest>();

  private reconnectAttempts = 0;
  private reconnectTimeout: ReturnType<typeof setTimeout> | null = null;

  constructor(options: NetworkClientOptions) {
    this.options = {
      maxReconnectAttempts: 10,
      reconnectDelay: 1000,
      requestTimeout: 10000,
      ...options,
    };
    this.connection = new Connection(this.options.url);
    this.setupConnectionHandlers();
  }

  // --- Public API ---

  public getState(): ConnectionState {
    return this.state;
  }

  public connect(token: string): Promise<void> {
    if (this.state !== ConnectionState.IDLE && this.state !== ConnectionState.DISCONNECTED) {
      return Promise.reject(new Error(`Cannot connect in state: ${this.state}`));
    }
    this.state = ConnectionState.CONNECTING;
    this.connection.connect();

    return new Promise<void>((resolve, reject) => {
      // Chain promises to avoid async executor
      new Promise<void>((res, rej) => {
        this.emitter.once('connect', res);
        this.emitter.once('disconnect', payload => rej(new Error(payload.reason)));
      })
        .then(() => {
          // Perform login sequence
          return this.send('checkver', {
            nativever: 1710120,
            scriptver: 1712260,
            clienttype: 'web',
            businessid: 'demo',
          });
        })
        .then(() => {
          return this.send('flblogin', {
            token: token,
            language: 'en_US',
          });
        })
        .then(() => {
          this.state = ConnectionState.CONNECTED;
          this.startHeartbeat();
          resolve();
        })
        .catch(error => {
          const reason = error instanceof Error ? error.message : 'Login failed';
          this.disconnect();
          reject(new Error(reason));
        });
    });
  }

  public enterGame(gamecode: string): Promise<any> {
    if (this.state !== ConnectionState.CONNECTED) {
      return Promise.reject(new Error(`Cannot enter game in state: ${this.state}`));
    }
    this.state = ConnectionState.ENTERING_GAME;
    return this.send('comeingame3', {
      gamecode,
      tableid: 't1',
      isreconnect: false,
    }).then(response => {
      this.state = ConnectionState.IN_GAME;
      return response;
    });
  }

  public disconnect(): void {
    this.stopHeartbeat();
    this.clearReconnectTimer();
    // Check if connection exists and is not already closing or closed
    if (this.connection) {
        this.connection.disconnect();
    }
    // Update state immediately for responsiveness
    if (this.state !== ConnectionState.DISCONNECTED) {
        this.state = ConnectionState.DISCONNECTED;
    }
    this.rejectAllPendingRequests('Client disconnected.');
  }

  public send(cmdid: string, params: any = {}): Promise<any> {
    if (this.state === ConnectionState.DISCONNECTED || this.state === ConnectionState.IDLE) {
      return Promise.reject(new Error(`Cannot send message in state: ${this.state}`));
    }

    const message = JSON.stringify({ cmdid, ...params });
    this.emitRawMessage('SEND', message);
    this.connection.send(message);

    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        this.pendingRequests.delete(cmdid);
        reject(new Error(`Request timed out for cmdid: ${cmdid}`));
      }, this.options.requestTimeout);

      this.pendingRequests.set(cmdid, { resolve, reject, timer });
    });
  }

  public on(event: string, callback: (...args: any[]) => void) {
    this.emitter.on(event, callback);
  }
  public off(event: string, callback: (...args: any[]) => void) {
    this.emitter.off(event, callback);
  }
  public once(event: string, callback: (...args: any[]) => void) {
    this.emitter.once(event, callback);
  }

  // --- Private Handlers ---

  private emitRawMessage(direction: 'SEND' | 'RECV', message: string): void {
    const payload: RawMessagePayload = { direction, message };
    this.emitter.emit('raw_message', payload);
  }

  private setupConnectionHandlers(): void {
    this.connection.onOpen = this.handleOpen.bind(this);
    this.connection.onMessage = this.handleMessage.bind(this);
    this.connection.onClose = this.handleClose.bind(this);
    this.connection.onError = this.handleError.bind(this);
  }

  private handleOpen(): void {
    this.reconnectAttempts = 0;
    this.clearReconnectTimer();
    this.emitter.emit('connect');
  }

  private handleMessage(event: MessageEvent): void {
    this.emitRawMessage('RECV', event.data);
    try {
      const messages = Array.isArray(JSON.parse(event.data))
        ? JSON.parse(event.data)
        : [JSON.parse(event.data)];

      for (const msg of messages) {
        if (msg.msgid === 'cmdret') {
          const promise = this.pendingRequests.get(msg.cmdid);
          if (promise) {
            clearTimeout(promise.timer);
            if (msg.isok) {
              promise.resolve(msg);
            } else {
              promise.reject(new Error(`Command '${msg.cmdid}' failed.`));
            }
            this.pendingRequests.delete(msg.cmdid);
          }
        } else {
          this.emitter.emit('message', msg);
        }
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

    if (this.state !== ConnectionState.DISCONNECTED && !payload.wasClean) {
      this.tryReconnect();
    } else {
      this.state = ConnectionState.DISCONNECTED;
    }
  }

  private handleError(event: Event): void {
    console.error('WebSocket error observed:', event);
    this.emitter.emit('error', event);
  }

  private tryReconnect(): void {
    if (this.reconnectAttempts >= this.options.maxReconnectAttempts!) {
      console.error('Max reconnection attempts reached. Giving up.');
      this.state = ConnectionState.DISCONNECTED;
      this.rejectAllPendingRequests('Reconnection failed.');
      return;
    }

    this.state = ConnectionState.RECONNECTING;
    this.emitter.emit('reconnecting', { attempt: this.reconnectAttempts + 1 });

    const delay = this.options.reconnectDelay! * Math.pow(2, this.reconnectAttempts);
    this.reconnectAttempts++;

    this.reconnectTimeout = setTimeout(() => {
      console.log(`Attempting to reconnect... (attempt ${this.reconnectAttempts})`);
      this.connection.connect();
    }, Math.min(delay, 30000));
  }

  private clearReconnectTimer(): void {
    if (this.reconnectTimeout) {
      clearTimeout(this.reconnectTimeout);
      this.reconnectTimeout = null;
    }
  }

  private startHeartbeat(): void {
    this.stopHeartbeat();
    this.heartbeatInterval = setInterval(() => {
      this.send('keepalive').catch(err => {
        console.warn('Heartbeat failed:', err);
      });
    }, 30000);
  }

  private stopHeartbeat(): void {
    if (this.heartbeatInterval) {
      clearInterval(this.heartbeatInterval);
      this.heartbeatInterval = null;
    }
  }

  private rejectAllPendingRequests(reason: string): void {
    for (const request of this.pendingRequests.values()) {
      clearTimeout(request.timer);
      request.reject(new Error(reason));
    }
    this.pendingRequests.clear();
  }
}
