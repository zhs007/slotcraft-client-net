import { describe, it, expect, beforeEach, vi } from 'vitest';
import { NetworkClient } from '../src/main';
import { Connection } from '../src/connection';
import { ConnectionState, NetworkClientOptions } from '../src/types';

// Mock the Connection class
vi.mock('../src/connection');

// Helper to introduce a small delay for async operations to complete
const sleep = (ms: number) => new Promise(resolve => setTimeout(resolve, ms));

describe('NetworkClient (Real Timers)', () => {
  let client: NetworkClient;
  let mockConnection: any;
  const options: NetworkClientOptions = {
    url: 'ws://test.com',
    reconnectDelay: 10, // Use short delays for testing
    requestTimeout: 50,
  };
  const TEST_TOKEN = 'test-token';
  const TEST_GAME_CODE = 'test-game';

  beforeEach(() => {
    vi.clearAllMocks();
    client = new NetworkClient(options);
    mockConnection = (Connection as any).mock.instances[0];
  });

  // Helper to simulate a server response to a command
  const simulateCmdRet = async (cmdid: string, isok = true) => {
    // Simulate async network response
    await sleep(1);
    mockConnection.onMessage?.({
      data: JSON.stringify({ msgid: 'cmdret', cmdid, isok }),
    } as MessageEvent);
  };

  // Helper to push a passive message from server
  const pushMsg = async (msg: any) => {
    await sleep(1);
    mockConnection.onMessage?.({ data: JSON.stringify(msg) } as MessageEvent);
  };

  describe('connect()', () => {
    it('should resolve on successful login', async () => {
      const connectPromise = client.connect(TEST_TOKEN);

      // Simulate the connection opening
      await sleep(1);
      mockConnection.onOpen?.();

  await simulateCmdRet('flblogin');

      await expect(connectPromise).resolves.toBeUndefined();
      expect(client.getState()).toBe(ConnectionState.CONNECTED);
    });

    it('should reject if a command fails', async () => {
      const connectPromise = client.connect(TEST_TOKEN);
      await sleep(1);
      mockConnection.onOpen?.();
  await simulateCmdRet('flblogin', false); // Simulate failure

  await expect(connectPromise).rejects.toThrow("Command 'flblogin' failed.");
      expect(client.getState()).toBe(ConnectionState.DISCONNECTED);
    });
  });

  describe('with established connection', () => {
    beforeEach(async () => {
      const connectPromise = client.connect(TEST_TOKEN);
      await sleep(1);
      mockConnection.onOpen?.();
  await simulateCmdRet('flblogin');
      await connectPromise;
    });

    it('enterGame() should work', async () => {
      const enterGamePromise = client.enterGame(TEST_GAME_CODE);
      await simulateCmdRet('comeingame3');
      await expect(enterGamePromise).resolves.toBeDefined();
      expect(client.getState()).toBe(ConnectionState.IN_GAME);
    });

    it('should cache userbaseinfo, gamemoduleinfo, and gameuserinfo; spin() should send gamectrl3', async () => {
      // Enter game (don't await yet; simulate cmdret first)
      const egPromise = client.enterGame(TEST_GAME_CODE);
      await simulateCmdRet('comeingame3');
      await egPromise;
      expect(client.getState()).toBe(ConnectionState.IN_GAME);

      // Push userbaseinfo
      await pushMsg({
        msgid: 'userbaseinfo',
        userbaseinfo: {
          pid: 'guest',
          uid: 123,
          nickname: 'tester',
          gold: 1000,
          token: 'tk',
          currency: 'EUR',
          jurisdiction: 'MT',
        },
        ispush: false,
        ver: '7.1.0',
      });

      // Push gamemoduleinfo for gameid
      await pushMsg({ msgid: 'gamemoduleinfo', gamemodulename: 'g', gameid: 42, gmi: {} });
  // Push gamecfg for bets
  await pushMsg({ msgid: 'gamecfg', defaultLinebet: 5, linebets: [1, 2, 5, 10], ver: 'v0.1', coreVer: 'v0.1', data: '{"foo":123}', bets: [25, 50] });
      // Push gameuserinfo for ctrlid
      await pushMsg({ msgid: 'gameuserinfo', lastctrlid: 1, ctrlid: 2, playerState: {} });

      const info = client.getUserInfo();
      expect(info.balance).toBe(1000);
      expect(info.uid).toBe(123);
      expect(info.nickname).toBe('tester');
      expect(info.currency).toBe('EUR');
      expect(info.jurisdiction).toBe('MT');
      expect(info.gameid).toBe(42);
  expect(info.ctrlid).toBe(2);
  expect(info.defaultLinebet).toBe(5);
  expect(info.linebets).toEqual([1, 2, 5, 10]);
  expect(info.gamecfgVer).toBe('v0.1');
  expect(info.gamecfgCoreVer).toBe('v0.1');
  expect(info.gamecfgData).toEqual({ foo: 123 });
  expect(info.linesOptions).toEqual([25, 50]);

      // Call spin, expect a gamectrl3 cmd sent and then resolve on cmdret
      const spinPromise = client.spin({ bet: 5, lines: 10 });
      // Verify the last SEND payload contains gamectrl3 with cached ids
      // We don't have direct access to sent messages, but we can simulate the response
      await simulateCmdRet('gamectrl3');
      await expect(spinPromise).resolves.toBeDefined();
    });

    it('spin() defaults bet to defaultLinebet and validates against linebets', async () => {
      // Enter and complete
      const egPromise = client.enterGame(TEST_GAME_CODE);
      await simulateCmdRet('comeingame3');
      await egPromise;
      // Provide necessary cache
      await pushMsg({ msgid: 'gamemoduleinfo', gamemodulename: 'g', gameid: 7, gmi: {} });
      await pushMsg({ msgid: 'gamecfg', defaultLinebet: 2, linebets: [1, 2, 5] });
      await pushMsg({ msgid: 'gameuserinfo', lastctrlid: 1, ctrlid: 9, playerState: {} });

  // Provide lines options to allow defaulting lines
  await pushMsg({ msgid: 'gamecfg', defaultLinebet: 2, linebets: [1, 2, 5], data: '{"25":{}}', bets: [25, 50] });
  // Without bet -> defaults to 2; lines omitted -> defaults to min(bets)=25
  const spinDefault = client.spin({});
  await simulateCmdRet('gamectrl3');
  // Simulate spin-end with no win so we return to IN_GAME
  await pushMsg({ msgid: 'gamemoduleinfo', gameid: 7, gmi: { totalwin: 0, replyPlay: { results: [] } } });
  await expect(spinDefault).resolves.toBeDefined();

  // Invalid bet -> reject (now that we are back in IN_GAME)
  await expect(client.spin({ bet: 3, lines: 10 })).rejects.toThrow('Invalid bet 3');
    });

    it('should cache and update playerState from gameuserinfo', async () => {
      // Enter game and set basics
      const egPromise = client.enterGame(TEST_GAME_CODE);
      await simulateCmdRet('comeingame3');
      await egPromise;
      await pushMsg({ msgid: 'gamemoduleinfo', gameid: 1, gamemodulename: 'g', gmi: {} });
      await pushMsg({ msgid: 'gameuserinfo', lastctrlid: 10, ctrlid: 11, playerState: { a: 1 } });
      expect(client.getUserInfo().playerState).toEqual({ a: 1 });

      // Push a new playerState and ensure it overwrites
      await pushMsg({ msgid: 'gameuserinfo', lastctrlid: 11, ctrlid: 12, playerState: { b: 2 } });
      expect(client.getUserInfo().playerState).toEqual({ b: 2 });
    });


    it('send() should resolve on success', async () => {
      const sendPromise = client.send('any_cmd');
      await simulateCmdRet('any_cmd');
      await expect(sendPromise).resolves.toBeDefined();
    });

    it('send() should reject on failure', async () => {
      const sendPromise = client.send('any_cmd');
      await simulateCmdRet('any_cmd', false);
      await expect(sendPromise).rejects.toThrow("Command 'any_cmd' failed.");
    });

    it('send() should reject on timeout', async () => {
      const sendPromise = client.send('any_cmd_timeout');
      // No response simulated, wait for the real timeout
      await expect(sendPromise).rejects.toThrow('Request timed out for cmdid: any_cmd_timeout');
    }, 100); // Test-specific timeout

    it('should attempt to reconnect on unclean close', async () => {
      const reconnectListener = vi.fn();
      client.on('reconnecting', reconnectListener);

      mockConnection.onClose?.({ wasClean: false });

      expect(client.getState()).toBe(ConnectionState.RECONNECTING);

      await sleep(options.reconnectDelay! + 5); // Wait for reconnect timer

      expect(reconnectListener).toHaveBeenCalled();
      expect(mockConnection.connect).toHaveBeenCalledTimes(2); // Initial + 1 reconnect
    });

    it('collect() should send collect with cached playIndex and return to IN_GAME', async () => {
      // Setup IN_GAME
      const egPromise = client.enterGame(TEST_GAME_CODE);
      await simulateCmdRet('comeingame3');
      await egPromise;
      // Provide playIndex in gamemoduleinfo
      await pushMsg({ msgid: 'gamemoduleinfo', gameid: 7, gmi: { playIndex: 3, playwin: 10 } });
      // Now collect
      const p = client.collect();
      // Ensure a cmdret for collect
      await simulateCmdRet('collect');
      await expect(p).resolves.toBeDefined();
      expect(client.getState()).toBe(ConnectionState.IN_GAME);
    });

    it('should emit SPINEND state with gmi data and cache lastGMI', async () => {
      // Enter game
      const egPromise = client.enterGame(TEST_GAME_CODE);
      await simulateCmdRet('comeingame3');
      await egPromise;
      // Provide ctrlid and config to allow spin
      await pushMsg({ msgid: 'gamemoduleinfo', gamemodulename: 'g', gameid: 99, gmi: {} });
      await pushMsg({ msgid: 'gamecfg', defaultLinebet: 1, linebets: [1, 2], data: '{"25":{}}', bets: [25] });
      await pushMsg({ msgid: 'gameuserinfo', lastctrlid: 0, ctrlid: 1, playerState: {} });

      const stateEvents: any[] = [];
      client.on('state', (e: any) => stateEvents.push(e));

      // Spin -> cmdret transitions to SPINEND conservatively
      const sp = client.spin({});
      await simulateCmdRet('gamectrl3');
      await sp;

      // Push a gamemoduleinfo with a win to keep SPINEND and attach gmi
      const gmi = { playIndex: 10, totalwin: 5, replyPlay: { results: [{}, {}] } };
      await pushMsg({ msgid: 'gamemoduleinfo', gameid: 99, gmi });

      // Find an event where current is SPINEND and has data.gmi
      const spinendEvt = stateEvents.find(e => e.current === 'SPINEND' && e.data && e.data.gmi);
      expect(spinendEvt).toBeDefined();
      expect(spinendEvt.data.gmi).toEqual(gmi);
      expect(client.getUserInfo().lastGMI).toEqual(gmi);

      // Now simulate game calling collect to end
      await pushMsg({ msgid: 'gamemoduleinfo', gameid: 99, gmi: { totalwin: 0, replyPlay: { results: [] } } });
      expect(client.getState()).toBe(ConnectionState.IN_GAME);
    });

    it('should handle gamemoduleinfo arriving before cmdret (state -> SPINEND, promise resolves on cmdret)', async () => {
      // Enter game
      const egPromise = client.enterGame(TEST_GAME_CODE);
      await simulateCmdRet('comeingame3');
      await egPromise;
      // Provide basics
      await pushMsg({ msgid: 'gamemoduleinfo', gamemodulename: 'g', gameid: 5, gmi: {} });
      await pushMsg({ msgid: 'gamecfg', defaultLinebet: 1, linebets: [1, 2], data: '{"25":{}}', bets: [25] });
      await pushMsg({ msgid: 'gameuserinfo', lastctrlid: 0, ctrlid: 1, playerState: {} });

      const evtSpy = vi.fn();
      client.on('state', evtSpy);

      // Start spin, do not send cmdret yet
      const spinP = client.spin({});
      expect(client.getState()).toBe(ConnectionState.SPINNING);
      // Push GMI now with no win -> should transition back to IN_GAME
      await pushMsg({ msgid: 'gamemoduleinfo', gameid: 5, gmi: { totalwin: 0, replyPlay: { results: [] } } });
      expect(client.getState()).toBe(ConnectionState.IN_GAME);
      // Now deliver cmdret to resolve the promise
      await simulateCmdRet('gamectrl3');
      await expect(spinP).resolves.toBeDefined();
      // Validate we saw SPINNING -> SPINEND (with data) -> IN_GAME sequence
      const currents = evtSpy.mock.calls.map(c => c[0].current);
      expect(currents).toContain('SPINNING');
      expect(currents).toContain('SPINEND');
      expect(currents[currents.length - 1]).toBe('IN_GAME');
    });
  });
});
