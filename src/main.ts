import { Connection } from './connection';
import { EventEmitter } from './event-emitter';
import {
  ConnectionState,
  SlotcraftClientOptions,
  DisconnectEventPayload,
  RawMessagePayload,
  UserInfo,
  SpinParams,
  Logger,
} from './types';

type PendingRequest = {
  resolve: (value: any) => void;
  reject: (reason?: any) => void;
  timer: ReturnType<typeof setTimeout>;
};

export class SlotcraftClient {
  private options: SlotcraftClientOptions;
  private connection: Connection;
  private state: ConnectionState = ConnectionState.IDLE;
  private heartbeatInterval: ReturnType<typeof setInterval> | null = null;
  private emitter = new EventEmitter();
  private pendingRequests = new Map<string, PendingRequest>();
  private logger: Logger;

  private reconnectAttempts = 0;
  private reconnectTimeout: ReturnType<typeof setTimeout> | null = null;
  private userInfo: UserInfo = {};
  private loginPromise: { resolve: () => void; reject: (reason?: any) => void } | null = null;

  constructor(options: SlotcraftClientOptions) {
    this.options = {
      maxReconnectAttempts: 10,
      reconnectDelay: 1000,
      requestTimeout: 10000,
      ...options,
    };

    // Cache token and gamecode from constructor options
    this.userInfo.token = options.token;
    this.userInfo.gamecode = options.gamecode;

    if (options.logger === null) {
      // If logger is explicitly null, use a no-op logger
      this.logger = { log: () => {}, warn: () => {}, error: () => {} };
    } else {
      // Otherwise, use the provided logger or default to the console
      this.logger = options.logger || console;
    }

    this.connection = new Connection(this.options.url);
    this.setupConnectionHandlers();
  }

  // --- Public API ---

  public getState(): ConnectionState {
    return this.state;
  }

  private setState(next: ConnectionState, data?: any): void {
    if (this.state === next) {
      // Allow emitting a state event with data even if state doesn't change
      if (data !== undefined) {
        const prev = this.state;
        this.emitter.emit('state', { previous: prev, current: next, data });
      }
      return;
    }
    const prev = this.state;
    this.state = next;
    this.emitter.emit('state', { previous: prev, current: next, data });
  }

  public getUserInfo(): Readonly<UserInfo> {
    return this.userInfo;
  }

  public connect(token?: string): Promise<void> {
    if (
      this.state !== ConnectionState.IDLE &&
      this.state !== ConnectionState.DISCONNECTED
    ) {
      return Promise.reject(new Error(`Cannot connect in state: ${this.state}`));
    }

    // Use token from argument if provided, otherwise fall back to the one from constructor options.
    const tokenToUse = token || this.userInfo.token;
    if (!tokenToUse) {
      return Promise.reject(new Error('Token must be provided either in the constructor or to connect()'));
    }
    // Cache token for auto-reconnects and the subsequent login call.
    this.userInfo.token = tokenToUse;

    this.setState(ConnectionState.CONNECTING);

    // This promise will be resolved or rejected by the private _login method.
    return new Promise<void>((resolve, reject) => {
      this.loginPromise = { resolve, reject };

      // If a disconnection happens before the login promise is settled, reject it.
      const onDisconnect = (payload: DisconnectEventPayload) => {
        if (this.loginPromise) {
          this.loginPromise.reject(new Error(payload.reason));
          this.loginPromise = null;
        }
      };
      // We only care about this for the initial connection flow.
      this.emitter.once('disconnect', onDisconnect);

      this.connection.connect();
    });
  }

  public enterGame(gamecode?: string): Promise<any> {
    if (this.state !== ConnectionState.LOGGED_IN) {
      return Promise.reject(new Error(`Cannot enter game in state: ${this.state}`));
    }

    // Use gamecode from argument if provided, otherwise fall back to the one from constructor options.
    const gamecodeToUse = gamecode || this.userInfo.gamecode;
    if (!gamecodeToUse) {
      return Promise.reject(new Error('Game code must be provided either in the constructor or to enterGame()'));
    }
    // Cache gamecode for context
    this.userInfo.gamecode = gamecodeToUse;

    this.setState(ConnectionState.ENTERING_GAME);
    return this.send('comeingame3', {
      gamecode: gamecodeToUse,
      tableid: '',
      isreconnect: false,
    }).then((response) => {
      this.setState(ConnectionState.IN_GAME);
      return response;
    });
  }

  /**
   * Send a spin (gamectrl3) using cached gameid/ctrlid.
   * Updates ctrlid will be received via gameuserinfo and cached automatically.
   */
  public spin(params: SpinParams): Promise<any> {
    if (this.state !== ConnectionState.IN_GAME) {
      return Promise.reject(new Error(`Cannot spin in state: ${this.state}`));
    }
    const { gameid, ctrlid } = this.userInfo;
    if (!gameid) {
      return Promise.reject(new Error('gameid not available'));
    }
    if (!ctrlid) {
      return Promise.reject(new Error('ctrlid not available'));
    }

    let { bet, lines, times = 1, autonums = -1, ctrlname = 'spin', ...rest } = params;
    // Default bet from cached game config if not provided
    if (bet == null) {
      if (typeof this.userInfo.defaultLinebet === 'number') {
        bet = this.userInfo.defaultLinebet;
      }
    }
    // Validate bet against allowed linebets when available
    if (typeof bet === 'number' && Array.isArray(this.userInfo.linebets)) {
      if (!this.userInfo.linebets.includes(bet)) {
        return Promise.reject(
          new Error(`Invalid bet ${bet}. Allowed: [${this.userInfo.linebets.join(',')}]`)
        );
      }
    }
    if (bet == null) {
      return Promise.reject(new Error('bet is required and no default is available'));
    }
    // Default lines to smallest allowed if not provided and we have options
    if (lines == null) {
      const opts = this.userInfo.linesOptions;
      if (Array.isArray(opts) && opts.length > 0) {
        lines = Math.min(...opts);
      }
    }
    const ctrlparam = { autonums, bet, lines, times, ...rest };
    this.setState(ConnectionState.SPINNING);
    return this.send('gamectrl3', { gameid, ctrlid, ctrlname, ctrlparam }).then(() => {
      // By protocol, gamemoduleinfo should have arrived before cmdret.
      // Return the latest cached GMI snapshot and simple aggregates.
      const gmi = this.userInfo.lastGMI;
      const totalwin = this.userInfo.lastTotalWin ?? 0;
      const results = this.userInfo.lastResultsCount ?? 0;
      return { gmi, totalwin, results };
    });
  }

  /**
   * Collect winnings for the last play.
   * If playIndex is omitted, uses cached userInfo.lastPlayIndex.
   */
  public collect(playIndex?: number): Promise<any> {
    // Collect should be called after a spin ends; allow in SPINEND, or IN_GAME when game explicitly does a collect
    if (this.state !== ConnectionState.SPINEND && this.state !== ConnectionState.IN_GAME) {
      return Promise.reject(new Error(`Cannot collect in state: ${this.state}`));
    }
    const { gameid } = this.userInfo;
    const resultsCount = this.userInfo.lastResultsCount;
    const idx = playIndex ?? this.userInfo.lastPlayIndex;
    if (!gameid) return Promise.reject(new Error('gameid not available'));
    // When caller does not provide playIndex, derive sequence from resultsCount if available
    const deriveSequence = (): number[] | undefined => {
      if (typeof playIndex === 'number') return [playIndex];
      // Per protocol, when a spin results in multiple stages (resultsCount > 1),
      // they must be collected sequentially. This logic handles collecting the
      // final two stages for multi-stage wins, or the single stage for simple wins.
      // The protocol requires this specific sequence for collection.
      if (typeof resultsCount === 'number') {
        if (resultsCount > 1) return [resultsCount - 1, resultsCount];
        if (resultsCount === 1) return [1];
      }
      if (typeof idx === 'number') return [idx];
      return undefined;
    };
    const seq = deriveSequence();
    if (!seq || seq.length === 0) return Promise.reject(new Error('playIndex not available'));

    this.setState(ConnectionState.COLLECTING);
    // Chain collects sequentially
    let p: Promise<any> = Promise.resolve();
    for (const i of seq) {
      p = p.then(() => this.send('collect', { gameid, playIndex: i }));
    }
    return p
      .then((res) => {
        // Only on success transition back to IN_GAME
        this.setState(ConnectionState.IN_GAME);
        return res;
      })
      .catch((err) => {
        // Stay around SPINEND for retry on failure
        this.setState(ConnectionState.SPINEND);
        throw err;
      });
  }

  // (spinUntilSpinEnd removed per request)

  public disconnect(): void {
    this.stopHeartbeat();
    this.clearReconnectTimer();
    // Check if connection exists and is not already closing or closed
    if (this.connection) {
      this.connection.disconnect();
    }
    // Update state immediately for responsiveness
    if (this.state !== ConnectionState.DISCONNECTED) {
      this.setState(ConnectionState.DISCONNECTED);
    }
    this.rejectAllPendingRequests('Client disconnected.');
  }

  public send(cmdid: string, params: any = {}): Promise<any> {
    // P1: Restrict commands during LOGGING_IN state.
    if (this.state === ConnectionState.LOGGING_IN && cmdid !== 'flblogin') {
      return Promise.reject(
        new Error(`Only 'flblogin' is allowed during LOGGING_IN state.`)
      );
    }

    const allowedStates = [
      ConnectionState.LOGGING_IN,
      ConnectionState.LOGGED_IN,
      ConnectionState.ENTERING_GAME,
      ConnectionState.IN_GAME,
      ConnectionState.SPINNING,
      ConnectionState.SPINEND,
      ConnectionState.COLLECTING,
    ];

    if (!allowedStates.includes(this.state)) {
      return Promise.reject(new Error(`Cannot send message in state: ${this.state}`));
    }

    // P0: Prevent concurrent requests for the same cmdid.
    if (this.pendingRequests.has(cmdid)) {
      return Promise.reject(
        new Error(`A request with cmdid '${cmdid}' is already pending.`)
      );
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
    this.emitter.emit('connect'); // Emit for legacy or internal listeners.
    this.setState(ConnectionState.CONNECTED);

    // After connecting, proceed to login.
    // This handles both initial login and re-login after a reconnect.
    this._login();
  }

  private _login(): void {
    if (!this.userInfo.token) {
      const err = new Error('Login failed: token is missing.');
      this.loginPromise?.reject(err);
      this.loginPromise = null;
      this.disconnect(); // Can't login, so disconnect.
      return;
    }

    this.setState(ConnectionState.LOGGING_IN);

    this.send('flblogin', {
      token: this.userInfo.token,
      language: 'en_US',
    })
      .then(() => {
        this.setState(ConnectionState.LOGGED_IN);
        this.startHeartbeat();
        // Resolve the promise created by the public connect() method.
        this.loginPromise?.resolve();
        this.loginPromise = null; // Promise is settled, clear it.
      })
      .catch((error) => {
        const reason = error instanceof Error ? error.message : 'Login failed';
        // Reject the promise from connect() and disconnect.
        this.loginPromise?.reject(new Error(reason));
        this.loginPromise = null;
        this.disconnect();
      });
  }

  private handleMessage(event: MessageEvent): void {
    this.emitRawMessage('RECV', event.data);
    try {
      // P2: Parse JSON only once.
      const parsedData = JSON.parse(event.data);
      const messages = Array.isArray(parsedData) ? parsedData : [parsedData];

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
          // Drive state transitions on cmdret where applicable
          switch (msg.cmdid) {
            case 'gamectrl3': {
              // Spin ended: decide new state based on cached totals
              if (this.state === ConnectionState.SPINNING) {
                const totalwin = this.userInfo.lastTotalWin ?? 0;
                const gmi = this.userInfo.lastGMI;
                if (totalwin > 0) {
                  this.setState(ConnectionState.SPINEND, gmi ? { gmi } : undefined);
                } else {
                  this.setState(ConnectionState.IN_GAME);
                }
              }
              break;
            }
            case 'comeingame3': {
              // enterGame() promise chain already moves to IN_GAME on success
              break;
            }
            case 'collect': {
              // collect() promise chain already handles state; no action here
              break;
            }
            default:
              break;
          }
        } else {
          // Passive messages: update caches where relevant only (no state transitions)
          this.updateCaches(msg);
          this.emitter.emit('message', msg);
        }
      }
    } catch (error) {
      this.logger.error('Failed to parse server message:', event.data);
      this.emitter.emit('error', new Error('Failed to parse server message'));
    }
  }

  /**
   * Update cached user/game info from passive messages.
   */
  private updateCaches(msg: any): void {
    switch (msg.msgid) {
      case 'userbaseinfo': {
        const ub = msg.userbaseinfo || {};
        this.userInfo.pid = ub.pid ?? this.userInfo.pid;
        this.userInfo.uid = ub.uid ?? this.userInfo.uid;
        this.userInfo.nickname = ub.nickname ?? this.userInfo.nickname;
        // gold as balance
        if (typeof ub.gold === 'number') this.userInfo.balance = ub.gold;
        this.userInfo.token = ub.token ?? this.userInfo.token;
        this.userInfo.currency = ub.currency ?? this.userInfo.currency;
        this.userInfo.jurisdiction = ub.jurisdiction ?? this.userInfo.jurisdiction;
        break;
      }
      case 'gamemoduleinfo': {
        if (typeof msg.gameid === 'number') this.userInfo.gameid = msg.gameid;
        // Cache last play index & win if present (support both top-level and nested in gmi)
        const g = msg.gmi || {};
        // Cache full gmi snapshot
        this.userInfo.lastGMI = g;
        const playIndex =
          typeof msg.playIndex === 'number'
            ? msg.playIndex
            : typeof g.playIndex === 'number'
              ? g.playIndex
              : undefined;
        if (typeof playIndex === 'number') this.userInfo.lastPlayIndex = playIndex;
        const playwin =
          typeof msg.playwin === 'number'
            ? msg.playwin
            : typeof g.playwin === 'number'
              ? g.playwin
              : undefined;
        const totalwin =
          typeof msg.totalwin === 'number'
            ? msg.totalwin
            : typeof g.totalwin === 'number'
              ? g.totalwin
              : undefined;
        if (typeof playwin === 'number') this.userInfo.lastPlayWin = playwin;
        if (typeof totalwin === 'number') this.userInfo.lastTotalWin = totalwin;
        // results length
        const resultsArr = Array.isArray(g.replyPlay?.results)
          ? g.replyPlay.results
          : Array.isArray(msg.results)
            ? msg.results
            : undefined;
        if (resultsArr) this.userInfo.lastResultsCount = resultsArr.length;
        // Do not change state on passive messages; decisions occur on cmdret
        break;
      }
      case 'gamecfg': {
        if (typeof msg.defaultLinebet === 'number')
          this.userInfo.defaultLinebet = msg.defaultLinebet;
        if (Array.isArray(msg.linebets)) this.userInfo.linebets = msg.linebets;
        if (typeof msg.ver === 'string') this.userInfo.gamecfgVer = msg.ver;
        if (typeof msg.coreVer === 'string') this.userInfo.gamecfgCoreVer = msg.coreVer;
        if (typeof msg.data === 'string') {
          try {
            this.userInfo.gamecfgData = JSON.parse(msg.data);
            // If no explicit bets array for lines, derive from gamecfgData keys
            if (!Array.isArray((msg as any).bets) && this.userInfo.gamecfgData) {
              const keys = Object.keys(this.userInfo.gamecfgData)
                .map((k) => Number(k))
                .filter((n) => Number.isFinite(n));
              if (keys.length) this.userInfo.linesOptions = keys.sort((a, b) => a - b);
            }
          } catch {
            // keep as undefined if parse fails
            this.userInfo.gamecfgData = undefined;
          }
        }
        // If server provides bets array, prefer it as lines options
        if (Array.isArray((msg as any).bets)) {
          const betsArr = (msg as any).bets.filter((n: any) => typeof n === 'number');
          if (betsArr.length) this.userInfo.linesOptions = [...betsArr].sort((a, b) => a - b);
        }
        break;
      }
      case 'gameuserinfo': {
        if (typeof msg.ctrlid === 'number') this.userInfo.ctrlid = msg.ctrlid;
        if (typeof msg.lastctrlid === 'number') this.userInfo.lastctrlid = msg.lastctrlid;
        // Cache the latest playerState object as-is
        if (msg.playerState !== undefined) this.userInfo.playerState = msg.playerState;
        break;
      }
      default:
        break;
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
      this.setState(ConnectionState.DISCONNECTED);
    }
  }

  private handleError(event: Event): void {
    this.logger.error('WebSocket error observed:', event);
    this.emitter.emit('error', event);
  }

  private tryReconnect(): void {
    if (this.reconnectAttempts >= this.options.maxReconnectAttempts!) {
      this.logger.error('Max reconnection attempts reached. Giving up.');
      this.setState(ConnectionState.DISCONNECTED);
      this.rejectAllPendingRequests('Reconnection failed.');
      return;
    }

    this.setState(ConnectionState.RECONNECTING);
    this.emitter.emit('reconnecting', { attempt: this.reconnectAttempts + 1 });

    const delay = this.options.reconnectDelay! * Math.pow(2, this.reconnectAttempts);
    this.reconnectAttempts++;

    this.reconnectTimeout = setTimeout(
      () => {
        this.logger.log(`Attempting to reconnect... (attempt ${this.reconnectAttempts})`);
        this.connection.connect();
      },
      Math.min(delay, 30000)
    );
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
      this.send('keepalive').catch((err) => {
        this.logger.warn('Heartbeat failed:', err);
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
