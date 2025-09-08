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
        server.send(ws, {
          msgid: 'gamemoduleinfo',
          totalwin: 100,
          // A win requires at least one result to trigger the collect flow.
          gmi: { replyPlay: { results: [{}] } },
        });
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
    });

    it('should auto-collect after a multi-stage win, then allow manual collect', async () => {
      const collectHandler = vi.fn((msg, ws) =>
        server.send(ws, { msgid: 'cmdret', cmdid: 'collect', isok: true })
      );
      server.on('collect', collectHandler);

      // Spin results in a win with 2 results, triggering auto-collect for index 0
      server.on('gamectrl3', (msg, ws) => {
        server.send(ws, {
          msgid: 'gamemoduleinfo',
          totalwin: 10,
          gmi: { replyPlay: { results: [{}, {}] } }, // 2 results
        });
        server.send(ws, { msgid: 'cmdret', cmdid: 'gamectrl3', isok: true });
      });

      await client.spin({ bet: 1, lines: 25 });

      // Wait for auto-collect (index 0) to happen
      await vi.waitFor(() => expect(collectHandler).toHaveBeenCalledTimes(1));
      expect(collectHandler.mock.calls[0][0].playIndex).toBe(0); // 2 - 2 = 0

      // State should be back in-game after auto-collect
      await vi.waitFor(() => expect(client.getState()).toBe(ConnectionState.IN_GAME));

      // Now manually collect the last result (index 1)
      await client.collect();
      expect(collectHandler).toHaveBeenCalledTimes(2);
      expect(collectHandler.mock.calls[1][0].playIndex).toBe(1); // 2 - 1 = 1
    });

    it('should reject if manual collect fails and revert to SPINEND state', async () => {
      // This time, spin results in a win with only 1 result, so auto-collect is NOT triggered.
      server.on('gamectrl3', (msg, ws) => {
        server.send(ws, {
          msgid: 'gamemoduleinfo',
          totalwin: 10,
          gmi: { replyPlay: { results: [{}] } }, // 1 result
        });
        server.send(ws, { msgid: 'cmdret', cmdid: 'gamectrl3', isok: true });
      });

      await client.spin({ bet: 1, lines: 25 });
      // With no auto-collect, state should be SPINEND.
      expect(client.getState()).toBe(ConnectionState.SPINEND);

      // Set up the server to fail the collect command
      server.on('collect', (msg, ws) =>
        server.send(ws, { msgid: 'cmdret', cmdid: 'collect', isok: false })
      );

      // The manual collect should be rejected
      await expect(client.collect()).rejects.toThrow();
      // On failure, the state should revert to SPINEND to allow a retry.
      expect(client.getState()).toBe(ConnectionState.SPINEND);
    });
  });

  describe('Player Choice Flow', () => {
    it('should correctly follow the full player choice flow', async () => {
      // 1. Setup mock server handlers for the entire sequence
      server.on('gamectrl3', (msg, ws) => {
        // The initial spin action
        if (msg.ctrlname === 'spin') {
          // Server sends gmi with choice options first
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
          // Then, server confirms the command is ok
          server.send(ws, { msgid: 'cmdret', cmdid: 'gamectrl3', isok: true });
        }
        // The follow-up selection action
        else if (msg.ctrlname === 'selectfree') {
          expect(msg.ctrlparam.command).toBe('bg-selectfg');
          expect(msg.ctrlparam.commandParam).toBe('lefty-bugsy-bugsy');
          // Server sends final gmi with win info
          server.send(ws, {
            msgid: 'gamemoduleinfo',
            totalwin: 50,
            // A win requires at least one result to trigger the collect flow.
            gmi: { replyPlay: { results: [{}] } },
          });
          // Then, server confirms the command is ok
          server.send(ws, { msgid: 'cmdret', cmdid: 'gamectrl3', isok: true });
        }
      });

      await connectAndEnterGame();
      const stateChangeHandler = vi.fn();
      client.on('state', stateChangeHandler);

      // 2. Initial spin, should resolve and lead to WAITTING_PLAYER
      await client.spin({ bet: 1, lines: 10 });
      expect(client.getState()).toBe(ConnectionState.WAITTING_PLAYER);

      // 3. Verify user info is correctly cached
      const userInfo = client.getUserInfo();
      expect(userInfo.optionals).toBeDefined();
      expect(userInfo.optionals?.length).toBe(2);
      expect(userInfo.optionals?.[1].param).toBe('lefty-bugsy-bugsy');
      expect(userInfo.curSpinParams).toEqual({ bet: 1, lines: 10, times: 1 });

      // 4. Make selection and await the result
      const result = await client.selectOptional(1);
      expect(result.totalwin).toBe(50);
      expect(client.getState()).toBe(ConnectionState.SPINEND);

      // 5. Verify the full state transition sequence
      const calls = stateChangeHandler.mock.calls;
      expect(calls[0][0]).toMatchObject({
        current: ConnectionState.SPINNING,
        previous: ConnectionState.IN_GAME,
      });
      expect(calls[1][0]).toMatchObject({
        current: ConnectionState.WAITTING_PLAYER,
        previous: ConnectionState.SPINNING,
      });
      expect(calls[2][0]).toMatchObject({
        current: ConnectionState.PLAYER_CHOICING,
        previous: ConnectionState.WAITTING_PLAYER,
      });
      expect(calls[3][0]).toMatchObject({
        current: ConnectionState.SPINEND,
        previous: ConnectionState.PLAYER_CHOICING,
      });
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
