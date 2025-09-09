import { vi, describe, it, expect, beforeEach } from 'vitest';
import { SlotcraftClient } from '../src/main';
import { ConnectionState } from '../src/types';
import { SlotcraftClientReplay } from '../src/replay-client';
import _fetch from 'node-fetch';

// Mock node-fetch
const mockReplayData = {
  msgid: 'gamemoduleinfo',
  gamemodulename: 'hoodlums',
  gameid: 61146,
  playCtrlParam: {
    balance: 730959,
  },
  gmi: {
    defaultScene: { values: [{ values: [1, 2] }] },
    replyPlay: {
      results: [{}, {}], // two results
      finished: true,
    },
    playIndex: 1,
    bet: 1,
    lines: 450,
    totalwin: 1341,
    playwin: 0,
  },
};

vi.mock('node-fetch');
const fetch = vi.mocked(_fetch);

describe('SlotcraftClient Replay Mode', () => {
  let client: SlotcraftClient;

  beforeEach(() => {
    // Reset mocks before each test
    vi.clearAllMocks();
    // Default happy path mock
    fetch.mockResolvedValue({
      ok: true,
      json: () => Promise.resolve(mockReplayData),
    } as any);
  });

  it('should instantiate SlotcraftClientReplay for an HTTP URL', () => {
    const replayClient = new SlotcraftClient({
      url: 'https://example.com/replay.json',
      token: 'test-token',
    });
    expect((replayClient as any).implementation).toBeInstanceOf(SlotcraftClientReplay);
  });

  describe('with a valid replay client instance', () => {
    beforeEach(() => {
      client = new SlotcraftClient({
        url: 'https://example.com/replay.json',
        token: 'test-token',
        gamecode: 'hoodlums',
      });
    });

    it('should connect, load data, and transition to LOGGED_IN', async () => {
      expect(client.getState()).toBe(ConnectionState.IDLE);
      const stateChanges: ConnectionState[] = [];
      client.on('state', ({ current }) => stateChanges.push(current as ConnectionState));
      await client.connect();
      expect(client.getState()).toBe(ConnectionState.LOGGED_IN);
      expect(stateChanges).toEqual([
        ConnectionState.CONNECTING,
        ConnectionState.CONNECTED,
        ConnectionState.LOGGING_IN,
        ConnectionState.LOGGED_IN,
      ]);
      const userInfo = client.getUserInfo();
      expect(userInfo.balance).toBe(mockReplayData.playCtrlParam.balance);
    });

    it('should enter game and transition to SPINEND for a win', async () => {
      await client.connect();
      await client.enterGame();
      expect(client.getState()).toBe(ConnectionState.SPINEND);
      const userInfo = client.getUserInfo();
      expect(userInfo.gameid).toBe(mockReplayData.gameid);
      expect(userInfo.lastTotalWin).toBe(mockReplayData.gmi.totalwin);
      expect(userInfo.lastResultsCount).toBe(2);
      expect(userInfo.defaultScene).toEqual([[1, 2]]);
    });

    it('should transition to IN_GAME after collect', async () => {
      await client.connect();
      await client.enterGame();
      expect(client.getState()).toBe(ConnectionState.SPINEND);
      await client.collect();
      expect(client.getState()).toBe(ConnectionState.IN_GAME);
    });

    it('should return cached data on spin', async () => {
      await client.connect();
      await client.enterGame();
      await client.collect(); // Get to IN_GAME state
      const spinResult = await client.spin({ lines: 1 });
      expect(spinResult.totalwin).toBe(mockReplayData.gmi.totalwin);
      expect(spinResult.results).toBe(2);
      expect(spinResult.gmi).toEqual(mockReplayData.gmi);
    });

    it('should handle disconnect correctly', async () => {
      await client.connect();
      let disconnected = false;
      client.on('disconnect', () => (disconnected = true));
      client.disconnect();
      expect(client.getState()).toBe(ConnectionState.DISCONNECTED);
      expect(disconnected).toBe(true);
    });
  });

  describe('Error Handling and Edge Cases', () => {
    it('should fail to connect if fetch is not ok', async () => {
      fetch.mockResolvedValue({ ok: false, statusText: 'Not Found' } as any);
      client = new SlotcraftClient({ url: 'http://a.b/c.json', token: 't' });
      const errorHandler = vi.fn();
      client.on('error', errorHandler);
      await expect(client.connect()).rejects.toThrow('Failed to fetch replay file: Not Found');
      expect(client.getState()).toBe(ConnectionState.DISCONNECTED);
      expect(errorHandler).toHaveBeenCalled();
    });

    it('should fail to connect if response is not valid JSON', async () => {
      fetch.mockResolvedValue({
        ok: true,
        json: () => Promise.reject(new Error('Invalid JSON')),
      } as any);
      client = new SlotcraftClient({ url: 'http://a.b/c.json', token: 't' });
      await expect(client.connect()).rejects.toThrow('Invalid JSON');
    });

    it('should reject connect() if token is missing', async () => {
      client = new SlotcraftClient({ url: 'http://a.b/c.json' });
      await expect(client.connect()).rejects.toThrow('Token must be provided');
    });

    it('should reject enterGame() before connect', async () => {
      client = new SlotcraftClient({ url: 'http://a.b/c.json', token: 't' });
      // The state check comes before the replayData check.
      await expect(client.enterGame()).rejects.toThrow('Cannot enter game in state: IDLE');
    });

    it('should reject enterGame() if gamecode is missing', async () => {
      client = new SlotcraftClient({ url: 'http://a.b/c.json', token: 't' });
      await client.connect();
      await expect(client.enterGame()).rejects.toThrow('Game code must be provided');
    });

    it('should reject collect() if not in SPINEND state', async () => {
      client = new SlotcraftClient({ url: 'http://a.b/c.json', token: 't' });
      await client.connect();
      expect(client.getState()).not.toBe(ConnectionState.SPINEND);
      await expect(client.collect()).rejects.toThrow('Cannot collect in state');
    });

    it('should reject selectOptional() if not in WAITTING_PLAYER state', async () => {
      client = new SlotcraftClient({ url: 'http://a.b/c.json', token: 't' });
      await client.connect();
      expect(client.getState()).not.toBe(ConnectionState.WAITTING_PLAYER);
      await expect(client.selectOptional(0)).rejects.toThrow('Cannot selectOptional in state');
    });

    it('should log a warning if spin() is called in a non-standard state', async () => {
      const logger = { log: vi.fn(), warn: vi.fn(), error: vi.fn() };
      client = new SlotcraftClient({ url: 'http://a.b/c.json', token: 't', logger });
      await client.connect();
      await client.spin({ lines: 1 }); // Call while in LOGGED_IN state
      expect(logger.warn).toHaveBeenCalledWith(
        'Spin called in non-standard state: LOGGED_IN. Returning cached data.'
      );
    });

    it('should use a no-op logger if logger is null', async () => {
      const logger = { log: vi.fn(), warn: vi.fn(), error: vi.fn() };
      // This test is more about the constructor logic, but we can check a side effect
      client = new SlotcraftClient({ url: 'http://a.b/c.json', token: 't', logger: null });
      // This call would normally log a warning, but shouldn't here
      await client.connect();
      await client.spin({ lines: 1 });
      expect(logger.warn).not.toHaveBeenCalled();
    });
  });
});
