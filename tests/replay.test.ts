import { vi, describe, it, expect, beforeEach } from 'vitest';
import { SlotcraftClient } from '../src/main';
import { ConnectionState } from '../src/types';
import { SlotcraftClientReplay } from '../src/replay-client';

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

vi.mock('node-fetch', () => ({
  __esModule: true, // handle CJS/ESM interop
  default: vi.fn().mockResolvedValue({
    ok: true,
    json: () => Promise.resolve(mockReplayData),
  }),
}));

describe('SlotcraftClient Replay Mode', () => {
  let client: SlotcraftClient;

  beforeEach(() => {
    // Reset mocks before each test
    vi.clearAllMocks();
  });

  it('should instantiate SlotcraftClientReplay for an HTTP URL', () => {
    const replayClient = new SlotcraftClient({
      url: 'https://example.com/replay.json',
      token: 'test-token',
    });
    // A bit of a hack to check the private implementation type, but necessary for this test.
    // This confirms the factory logic in the main SlotcraftClient constructor.
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
      client.on('state', ({ current }) => {
        stateChanges.push(current as ConnectionState);
      });

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
      client.on('disconnect', () => {
        disconnected = true;
      });

      client.disconnect();

      expect(client.getState()).toBe(ConnectionState.DISCONNECTED);
      expect(disconnected).toBe(true);
    });
  });
});
