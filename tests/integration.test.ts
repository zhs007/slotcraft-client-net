import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { SlotcraftClient } from '../src/main';
import { MockServer } from './mock-server';
import { ConnectionState, SlotcraftClientOptions } from '../src/types';

describe('SlotcraftClient Integration Tests', () => {
  let server: MockServer;
  let client: SlotcraftClient;
  let port: number;
  const TEST_TOKEN = 'test-token';
  const TEST_GAME_CODE = 'test-game';

  const getClient = (overrides: Partial<SlotcraftClientOptions> = {}) => {
    const options: SlotcraftClientOptions = {
      url: `ws://localhost:${port}`,
      reconnectDelay: 10,
      requestTimeout: 100,
      logger: null, // Disable logs for cleaner test output
      ...overrides,
    };
    client = new SlotcraftClient(options);
    return client;
  };

  const connectAndEnterGame = async () => {
    client = getClient();
    server.on('flblogin', (msg, ws) => {
      server.send(ws, { msgid: 'cmdret', cmdid: 'flblogin', isok: true });
    });
    server.on('comeingame3', (msg, ws) => {
      server.send(ws, { msgid: 'gamemoduleinfo', gameid: 123 });
      server.send(ws, { msgid: 'gameuserinfo', ctrlid: 456 });
      server.send(ws, { msgid: 'cmdret', cmdid: 'comeingame3', isok: true });
    });
    await client.connect(TEST_TOKEN);
    await client.enterGame(TEST_GAME_CODE);
  };

  beforeEach(async () => {
    vi.useRealTimers();
    server = new MockServer();
    port = await server.start();
  });

  afterEach(() => {
    vi.useRealTimers();
    if (client) {
      client.disconnect();
    }
    if (server) {
      server.stop();
    }
  });

  describe('Connection and Login', () => {
    it('should connect, login, and transition to LOGGED_IN state', async () => {
      const loginHandler = vi.fn((msg, ws) => {
        expect(msg.token).toBe(TEST_TOKEN);
        server.send(ws, { msgid: 'cmdret', cmdid: 'flblogin', isok: true });
      });
      server.on('flblogin', loginHandler);
      client = getClient();
      await expect(client.connect(TEST_TOKEN)).resolves.toBeUndefined();
      expect(client.getState()).toBe(ConnectionState.LOGGED_IN);
      expect(loginHandler).toHaveBeenCalledOnce();
    });
  });

  describe('State and Input Validation', () => {
    it('should reject calling methods from wrong state', async () => {
      client = getClient();
      await expect(client.enterGame('foo')).rejects.toThrow();
      const connectPromise = client.connect(TEST_TOKEN);
      await expect(client.connect(TEST_TOKEN)).rejects.toThrow();
      server.on('flblogin', () => {});
      await vi.waitFor(() => expect(client.getState()).toBe(ConnectionState.LOGGING_IN));
      await expect(client.enterGame('foo')).rejects.toThrow();
      server.broadcast({ msgid: 'cmdret', cmdid: 'flblogin', isok: true });
      await connectPromise;
      await expect(client.spin({})).rejects.toThrow();
    });

    it('should reject spin with invalid parameters', async () => {
      await connectAndEnterGame();
      server.broadcast({ msgid: 'gamecfg', linebets: [1, 5, 10] });
      await vi.waitFor(() => expect(client.getUserInfo().linebets).toBeDefined());
      await expect(client.spin({ bet: 2, lines: 1 })).rejects.toThrow('Invalid bet 2');
      server.broadcast({ msgid: 'gamecfg', defaultLinebet: null, linebets: [] });
      await vi.waitFor(() => expect(client.getUserInfo().linebets).toEqual([]));
      await expect(client.spin({ lines: 1 })).rejects.toThrow('bet is required');
    });
  });

  describe('In-Game Logic and Caching', () => {
    beforeEach(async () => {
      await connectAndEnterGame();
    });

    it('should enter a game and cache initial game data', () => {
      const userInfo = client.getUserInfo();
      expect(client.getState()).toBe(ConnectionState.IN_GAME);
      expect(userInfo.gamecode).toBe(TEST_GAME_CODE);
      expect(userInfo.gameid).toBe(123);
      expect(userInfo.ctrlid).toBe(456);
    });

    it('should handle a spin with win and transition to SPINEND', async () => {
      server.on('gamectrl3', (msg, ws) => {
        server.send(ws, { msgid: 'gamemoduleinfo', totalwin: 100 });
        server.send(ws, { msgid: 'cmdret', cmdid: 'gamectrl3', isok: true });
      });
      await client.spin({ bet: 1, lines: 25 });
      expect(client.getState()).toBe(ConnectionState.SPINEND);
    });

    it('should handle a spin with no win and return to IN_GAME', async () => {
      server.on('gamectrl3', (msg, ws) => {
        server.send(ws, { msgid: 'gamemoduleinfo', totalwin: 0 });
        server.send(ws, { msgid: 'cmdret', cmdid: 'gamectrl3', isok: true });
      });
      await client.spin({ bet: 1, lines: 25 });
      expect(client.getState()).toBe(ConnectionState.IN_GAME);
    });

    it('should cache data from userbaseinfo, gamecfg, and gameuserinfo', async () => {
      server.broadcast({
        msgid: 'userbaseinfo',
        userbaseinfo: { gold: 500, nickname: 'player1' },
      });
      server.broadcast({ msgid: 'gamecfg', defaultLinebet: 5, linebets: [1, 5, 10] });
      await vi.waitFor(() => expect(client.getUserInfo().balance).toBe(500));
      const info = client.getUserInfo();
      expect(info.nickname).toBe('player1');
      expect(info.defaultLinebet).toBe(5);
      expect(info.linebets).toEqual([1, 5, 10]);
    });
  });

  describe('Collect Flow', () => {
    beforeEach(async () => {
      await connectAndEnterGame();
      // Set up a spin that results in a win
      server.on('gamectrl3', (msg, ws) => {
        server.send(ws, {
          msgid: 'gamemoduleinfo',
          totalwin: 10,
          gmi: { replyPlay: { results: [{}, {}] } }, // 2 results
        });
        server.send(ws, { msgid: 'cmdret', cmdid: 'gamectrl3', isok: true });
      });
      await client.spin({ bet: 1, lines: 25 });
      expect(client.getState()).toBe(ConnectionState.SPINEND);
    });

    it('should send multiple collect commands if resultsCount > 1', async () => {
      const collectHandler = vi.fn((msg, ws) =>
        server.send(ws, { msgid: 'cmdret', cmdid: 'collect', isok: true })
      );
      server.on('collect', collectHandler);
      await client.collect();
      expect(collectHandler).toHaveBeenCalledTimes(2);
      expect(client.getState()).toBe(ConnectionState.IN_GAME);
    });

    it('should reject if collect command fails and stay in SPINEND state', async () => {
      server.on('collect', (msg, ws) =>
        server.send(ws, { msgid: 'cmdret', cmdid: 'collect', isok: false })
      );
      await expect(client.collect()).rejects.toThrow();
      expect(client.getState()).toBe(ConnectionState.SPINEND);
    });
  });

  describe('Player Choice Flow', () => {
    beforeEach(async () => {
      await connectAndEnterGame();
      // Set up a spin that results in a player choice
      server.on('gamectrl3', (msg, ws) => {
        if (msg.ctrlname === 'spin') {
          server.send(ws, {
            msgid: 'gamemoduleinfo',
            gmi: {
              replyPlay: {
                nextCommands: ['bg-selectfg', 'bg-selectfg'],
                nextCommandParams: ['lefty-bugsy-lefty', 'lefty-bugsy-bugsy'],
                finished: false,
              },
            },
          });
          // Unlike a normal spin, there's no immediate cmdret.
          // The cmdret comes after the player makes a choice.
        } else if (msg.ctrlname === 'selectfree') {
          // This is the choice selection
          server.send(ws, { msgid: 'gamemoduleinfo', totalwin: 50 });
          server.send(ws, { msgid: 'cmdret', cmdid: 'gamectrl3', isok: true });
        }
      });
    });

    it('should transition to WAITTING_PLAYER and wait for selection', async () => {
      const stateChangeHandler = vi.fn();
      client.on('state', stateChangeHandler);

      // This spin should reject after the choice is made.
      const spinPromise = client.spin({ bet: 1, lines: 10 });

      await vi.waitFor(() => {
        expect(client.getState()).toBe(ConnectionState.WAITTING_PLAYER);
      });

      const userInfo = client.getUserInfo();
      expect(userInfo.optionals).toBeDefined();
      expect(userInfo.optionals?.length).toBe(2);
      expect(userInfo.optionals?.[0].command).toBe('bg-selectfg');
      expect(userInfo.curSpinParams).toEqual({ bet: 1, lines: 10, times: 1 });

      // Now, make a selection
      const selectPromise = client.selectOptional(1);

      // The original spin should now reject.
      await expect(spinPromise).rejects.toThrow('Spin superseded by player choice requirement.');

      // The selectOptional promise should resolve with the final win.
      const result = await selectPromise;
      expect(result.totalwin).toBe(50);

      // And the final state should be SPINEND.
      expect(client.getState()).toBe(ConnectionState.SPINEND);

      // Check the full state transition sequence
      expect(stateChangeHandler).toHaveBeenCalledWith(
        expect.objectContaining({ current: ConnectionState.SPINNING, previous: ConnectionState.IN_GAME })
      );
      expect(stateChangeHandler).toHaveBeenCalledWith(
        expect.objectContaining({ current: ConnectionState.WAITTING_PLAYER, previous: ConnectionState.SPINNING })
      );
      expect(stateChangeHandler).toHaveBeenCalledWith(
        expect.objectContaining({ current: ConnectionState.SPINNING, previous: ConnectionState.WAITTING_PLAYER })
      );
      expect(stateChangeHandler).toHaveBeenCalledWith(
        expect.objectContaining({ current: ConnectionState.SPINEND, previous: ConnectionState.SPINNING })
      );
    });
  });

  describe('Error Handling and Edge Cases', () => {
    it('should emit an error for malformed JSON from server', async () => {
      await connectAndEnterGame();
      const errorHandler = vi.fn();
      client.on('error', errorHandler);
      const rawWsClient = server.clients.values().next().value;
      rawWsClient.send('this is not json');
      await vi.waitFor(() => expect(errorHandler).toHaveBeenCalled());
      expect(errorHandler.mock.calls[0][0].message).toBe('Failed to parse server message');
    });
  });
});
