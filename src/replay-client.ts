import { EventEmitter } from './event-emitter';
import {
  ConnectionState,
  ISlotcraftClientImpl,
  SlotcraftClientOptions,
  SpinParams,
  UserInfo,
  StateChangePayload,
  RawMessagePayload,
  Logger,
} from './types';
import { transformSceneData } from './utils';

export class SlotcraftClientReplay implements ISlotcraftClientImpl {
  private options: SlotcraftClientOptions;
  private state: ConnectionState = ConnectionState.IDLE;
  private emitter = new EventEmitter();
  private logger: Logger;
  private userInfo: UserInfo = {};
  private replayData: any = null;

  constructor(options: SlotcraftClientOptions) {
    this.options = { ...options };

    this.userInfo.token = options.token;
    this.userInfo.gamecode = options.gamecode;
    this.userInfo.businessid = options.businessid ?? '';
    this.userInfo.clienttype = options.clienttype ?? 'web';
    this.userInfo.jurisdiction = options.jurisdiction ?? 'MT';
    this.userInfo.language = options.language ?? 'en';

    if (options.logger === null) {
      this.logger = { log: () => {}, warn: () => {}, error: () => {} };
    } else {
      this.logger = options.logger || console;
    }
  }

  // --- Public API ---

  public getState(): ConnectionState {
    return this.state;
  }

  private setState(next: ConnectionState, data?: any): void {
    if (this.state === next) {
      if (data !== undefined) {
        this.emitter.emit('state', { previous: this.state, current: next, data });
      }
      return;
    }
    const prev = this.state;
    this.state = next;
    const payload: StateChangePayload = { previous: prev, current: next, data };
    this.emitter.emit('state', payload);
  }

  public getUserInfo(): Readonly<UserInfo> {
    return this.userInfo;
  }

  public async connect(token?: string): Promise<void> {
    if (this.state !== ConnectionState.IDLE && this.state !== ConnectionState.DISCONNECTED) {
      throw new Error(`Cannot connect in state: ${this.state}`);
    }

    const tokenToUse = token || this.userInfo.token;
    if (!tokenToUse) {
      throw new Error('Token must be provided either in the constructor or to connect()');
    }
    this.userInfo.token = tokenToUse;

    const fetchImpl = this.options.fetch ?? (typeof window !== 'undefined' ? window.fetch : undefined);
    if (!fetchImpl) {
      throw new Error(
        'A fetch implementation must be provided in options.fetch in non-browser environments.'
      );
    }

    this.setState(ConnectionState.CONNECTING);

    try {
      const response = await fetchImpl(this.options.url);
      if (!response.ok) {
        throw new Error(`Failed to fetch replay file: ${(response as any).statusText}`);
      }
      this.replayData = await response.json();
      this.emitRawMessage('RECV', JSON.stringify(this.replayData));

      this.setState(ConnectionState.CONNECTED);
      this.emitter.emit('connect');

      // Simulate login
      this.setState(ConnectionState.LOGGING_IN);
      this.userInfo.balance = this.replayData.playCtrlParam?.balance ?? 0;
      this.setState(ConnectionState.LOGGED_IN);
    } catch (error) {
      this.setState(ConnectionState.DISCONNECTED);
      this.emitter.emit('error', error);
      throw error;
    }
  }

  public async enterGame(gamecode?: string): Promise<any> {
    if (this.state !== ConnectionState.LOGGED_IN) {
      throw new Error(`Cannot enter game in state: ${this.state}`);
    }
    if (!this.replayData) {
      throw new Error('Replay data not loaded. Call connect() first.');
    }

    const gamecodeToUse = gamecode || this.userInfo.gamecode;
    if (!gamecodeToUse) {
      throw new Error('Game code must be provided either in the constructor or to enterGame()');
    }
    this.userInfo.gamecode = gamecodeToUse;

    this.setState(ConnectionState.ENTERING_GAME);

    // Process the loaded replay data.
    // It can be a single gamemoduleinfo object (old format)
    // or a wrapper { gamemoduleinfo, gamecfg } (new format).
    if (this.replayData.msgid === 'gamemoduleinfo') {
      // Handle old format
      this.updateCaches(this.replayData);
      this.emitter.emit('message', this.replayData);
    } else {
      // Handle new format
      if (this.replayData.gamemoduleinfo) {
        this.updateCaches(this.replayData.gamemoduleinfo);
        this.emitter.emit('message', this.replayData.gamemoduleinfo);
      }
      if (this.replayData.gamecfg) {
        this._processGameCfg(this.replayData.gamecfg);
        this.emitter.emit('message', this.replayData.gamecfg);
      }
    }

    const gmi = this.userInfo.lastGMI;
    const totalwin = this.userInfo.lastTotalWin ?? 0;
    const resultsCount = this.userInfo.lastResultsCount ?? 0;
    const needsCollect = (totalwin > 0 && resultsCount >= 1) || (totalwin === 0 && resultsCount > 1);

    if (needsCollect) {
      this.setState(ConnectionState.SPINEND, { gmi });
    } else {
      this.setState(ConnectionState.IN_GAME);
    }

    return Promise.resolve({ isok: true, cmdid: 'comeingame3' });
  }

  public async spin(params: SpinParams): Promise<any> {
    if (this.state !== ConnectionState.IN_GAME) {
      this.logger.warn(`Spin called in non-standard state: ${this.state}. Returning cached data.`);
    }
    // In replay mode, the spin has effectively already happened.
    // We just return the final result from the loaded data.
    const gmi = this.userInfo.lastGMI;
    const totalwin = this.userInfo.lastTotalWin ?? 0;
    const results = this.userInfo.lastResultsCount ?? 0;
    return Promise.resolve({ gmi, totalwin, results });
  }

  public async collect(playIndex?: number): Promise<any> {
    if (this.state !== ConnectionState.SPINEND) {
      throw new Error(`Cannot collect in state: ${this.state}`);
    }
    this.setState(ConnectionState.COLLECTING);
    // Simulate successful collection
    this.setState(ConnectionState.IN_GAME);
    return Promise.resolve({ isok: true, cmdid: 'collect' });
  }

  public async selectOptional(index: number): Promise<any> {
    // The provided example does not have an optional choice scenario.
    // This method can be expanded if needed for more complex replays.
    if (this.state !== ConnectionState.WAITTING_PLAYER) {
      throw new Error(`Cannot selectOptional in state: ${this.state}`);
    }
    // In a real implementation, we would use the index to select from `userInfo.optionals`
    // and then potentially process another stage of the replay data.
    this.logger.log(`Selected option ${index}. In replay, this concludes the action.`);
    this.setState(ConnectionState.IN_GAME);
    return Promise.resolve({ isok: true, cmdid: 'gamectrl3' });
  }

  public disconnect(): void {
    if (this.state !== ConnectionState.DISCONNECTED) {
      this.setState(ConnectionState.DISCONNECTED);
      this.emitter.emit('disconnect', { code: 1000, reason: 'Client disconnected', wasClean: true });
    }
  }

  public async send(cmdid: string, params: any = {}): Promise<any> {
    // In replay mode, we don't send anything over the network.
    // We can log the attempt for debugging purposes.
    this.logger.log(`[REPLAY] send called for ${cmdid} with params:`, params);
    this.emitRawMessage('SEND', JSON.stringify({ cmdid, ...params }));
    return Promise.resolve({ isok: true, cmdid });
  }

  public on(event: string, callback: (...args: any[]) => void): void {
    this.emitter.on(event, callback);
  }

  public off(event: string, callback: (...args: any[]) => void): void {
    this.emitter.off(event, callback);
  }

  public once(event: string, callback: (...args: any[]) => void): void {
    this.emitter.once(event, callback);
  }

  private emitRawMessage(direction: 'SEND' | 'RECV', message: string): void {
    const payload: RawMessagePayload = { direction, message };
    this.emitter.emit('raw_message', payload);
  }

  private updateCaches(msg: any): void {
    if (msg.msgid !== 'gamemoduleinfo') return;

    if (typeof msg.gameid === 'number') this.userInfo.gameid = msg.gameid;
    const g = msg.gmi || {};
    this.userInfo.lastGMI = g;

    const playIndex =
      typeof msg.playIndex === 'number'
        ? msg.playIndex
        : typeof g.playIndex === 'number'
        ? g.playIndex
        : undefined;
    if (typeof playIndex === 'number') this.userInfo.lastPlayIndex = playIndex;

    const totalwin =
      typeof msg.totalwin === 'number'
        ? msg.totalwin
        : typeof g.totalwin === 'number'
        ? g.totalwin
        : undefined;
    if (typeof totalwin === 'number') this.userInfo.lastTotalWin = totalwin;

    const resultsArr = Array.isArray(g.replyPlay?.results)
      ? g.replyPlay.results
      : Array.isArray(msg.results)
      ? msg.results
      : undefined;
    if (resultsArr) this.userInfo.lastResultsCount = resultsArr.length;

    if (g.defaultScene) {
      this.userInfo.defaultScene = transformSceneData(g.defaultScene);
    }
  }

  private _processGameCfg(msg: any): void {
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
  }
}
