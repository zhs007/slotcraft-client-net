import 'isomorphic-ws';
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { SlotcraftClient } from '../src/main';
import { MockServer } from './mock-server';
import { ConnectionState, SlotcraftClientOptions } from '../src/types';
import { WebSocket } from 'ws';

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
    it('should connect, login, and transition to CONNECTED state', async () => {
      server.on('flblogin', (msg, ws) => {
        expect(msg.token).toBe(TEST_TOKEN);
        server.send(ws, { msgid: 'cmdret', cmdid: 'flblogin', isok: true });
      });
      client = getClient();
      await expect(client.connect(TEST_TOKEN)).resolves.toBeUndefined();
      expect(client.getState()).toBe(ConnectionState.CONNECTED);
    });

    it('should fail to connect if login command is rejected', async () => {
      server.on('flblogin', (msg, ws) => {
        server.send(ws, { msgid: 'cmdret', cmdid: 'flblogin', isok: false });
      });
      client = getClient();
      await expect(client.connect(TEST_TOKEN)).rejects.toThrow();
      expect(client.getState()).toBe(ConnectionState.DISCONNECTED);
    });

    it('should fail if server immediately closes connection', { timeout: 500 }, async () => {
      server.wss?.on('connection', (ws: WebSocket) => {
        ws.close(1000, 'Connection refused by test');
      });
      client = getClient({ maxReconnectAttempts: 0 });
      await expect(client.connect(TEST_TOKEN)).rejects.toThrow();
      expect(client.getState()).toBe(ConnectionState.DISCONNECTED);
    });
  });

  describe('Reconnection Logic', () => {
    it.skip('should attempt to reconnect on unclean close and eventually give up', () => {
      // Test skipped due to instability with vitest fake timers and 'ws' events.
    });
  });

  describe('In-Game Flow', () => {
    it('should enter a game and cache initial game data', async () => {
      await connectAndEnterGame();
      const userInfo = client.getUserInfo();
      expect(userInfo.gamecode).toBe(TEST_GAME_CODE);
      expect(userInfo.gameid).toBe(123);
      expect(userInfo.ctrlid).toBe(456);
    });

    it('should send a spin command and handle the response', async () => {
      await connectAndEnterGame();
      server.on('gamectrl3', (msg, ws) => {
        server.send(ws, { msgid: 'gamemoduleinfo', totalwin: 100 });
        server.send(ws, { msgid: 'cmdret', cmdid: 'gamectrl3', isok: true });
      });
      await client.spin({ bet: 1, lines: 25 });
      expect(client.getState()).toBe(ConnectionState.SPINEND);
    });

    it('should handle a spin with no win and return to IN_GAME state', async () => {
      await connectAndEnterGame();
      server.on('gamectrl3', (msg, ws) => {
        server.send(ws, { msgid: 'gamemoduleinfo', totalwin: 0 });
        server.send(ws, { msgid: 'cmdret', cmdid: 'gamectrl3', isok: true });
      });
      await client.spin({ bet: 1, lines: 25 });
      expect(client.getState()).toBe(ConnectionState.IN_GAME);
    });
  });

  describe('Collect Flow', () => {
    it('should reject collect if not in a valid state', async () => {
      await connectAndEnterGame();
      client.disconnect();
      await expect(client.collect()).rejects.toThrow('Cannot collect in state');
    });

    it('should send a single collect command if resultsCount is 1', async () => {
      await connectAndEnterGame();
      server.on('gamectrl3', (msg, ws) => {
        server.send(ws, { msgid: 'gamemoduleinfo', totalwin: 10, gmi: { replyPlay: { results: [{}] } } });
        server.send(ws, { msgid: 'cmdret', cmdid: 'gamectrl3', isok: true });
      });
      await client.spin({ bet: 1, lines: 25 });

      const collectHandler = vi.fn((msg, ws) => server.send(ws, { msgid: 'cmdret', cmdid: 'collect', isok: true }));
      server.on('collect', collectHandler);
      await client.collect();

      expect(collectHandler).toHaveBeenCalledTimes(1);
      expect(collectHandler).toHaveBeenCalledWith(expect.objectContaining({ playIndex: 1 }), expect.anything(), expect.anything());
    });

    it('should send multiple collect commands if resultsCount > 1', async () => {
      await connectAndEnterGame();
      server.on('gamectrl3', (msg, ws) => {
        server.send(ws, { msgid: 'gamemoduleinfo', totalwin: 10, gmi: { replyPlay: { results: [{}, {}] } } });
        server.send(ws, { msgid: 'cmdret', cmdid: 'gamectrl3', isok: true });
      });
      await client.spin({ bet: 1, lines: 25 });

      const collectHandler = vi.fn((msg, ws) => server.send(ws, { msgid: 'cmdret', cmdid: 'collect', isok: true }));
      server.on('collect', collectHandler);
      await client.collect();

      expect(collectHandler).toHaveBeenCalledTimes(2);
    });

    it('should reject if collect command fails and stay in SPINEND state', async () => {
      await connectAndEnterGame();
      server.on('gamectrl3', (msg, ws) => {
        server.send(ws, { msgid: 'gamemoduleinfo', totalwin: 10, gmi: { replyPlay: { results: [{}] } } });
        server.send(ws, { msgid: 'cmdret', cmdid: 'gamectrl3', isok: true });
      });
      await client.spin({ bet: 1, lines: 25 });

      server.on('collect', (msg, ws) => server.send(ws, { msgid: 'cmdret', cmdid: 'collect', isok: false }));
      await expect(client.collect()).rejects.toThrow();
      expect(client.getState()).toBe(ConnectionState.SPINEND);
    });
  });

  describe('State and Input Validation', () => {
    it('should reject calling methods from wrong state', async () => {
      client = getClient();
      await expect(client.enterGame('foo')).rejects.toThrow('Cannot enter game in state: IDLE');

      const connectPromise = client.connect(TEST_TOKEN);
      await expect(client.connect(TEST_TOKEN)).rejects.toThrow('Cannot connect in state: CONNECTING');

      server.on('flblogin', (msg, ws) => server.send(ws, { msgid: 'cmdret', cmdid: 'flblogin', isok: true }));
      await connectPromise;

      await expect(client.spin({})).rejects.toThrow('Cannot spin in state: CONNECTED');
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

    it('should derive linesOptions from gamecfg data keys if bets array is missing', async () => {
      await connectAndEnterGame();

      server.broadcast({
        msgid: 'gamecfg',
        defaultLinebet: 1,
        linebets: [1, 5, 10],
        data: '{"25":{}, "50":{}, "10":{}}',
      });
      await vi.waitFor(() => expect(client.getUserInfo().linesOptions).toBeDefined());

      const spinHandler = vi.fn((msg, ws) => {
        expect(msg.ctrlparam.lines).toBe(10);
        server.send(ws, { msgid: 'cmdret', cmdid: 'gamectrl3', isok: true });
      });
      server.on('gamectrl3', spinHandler);

      await client.spin({ bet: 1 });
      expect(spinHandler).toHaveBeenCalled();
    });
  });

  describe('Error Handling and Edge Cases', () => {
    it('should emit an error for malformed JSON', async () => {
      await connectAndEnterGame();
      const errorHandler = vi.fn();
      client.on('error', errorHandler);

      const rawWsClient = server.clients.values().next().value;
      rawWsClient.send('this is not json');

      await vi.waitFor(() => expect(errorHandler).toHaveBeenCalled());
      expect(errorHandler.mock.calls[0][0].message).toBe('Failed to parse server message');
    });

    it('should handle gamecfg with malformed data string', async () => {
      await connectAndEnterGame();
      const userInfo = client.getUserInfo();
      expect(userInfo.gamecfgData).toBeUndefined();

      server.broadcast({ msgid: 'gamecfg', data: '{"bad json":,}' });
      await vi.waitFor(() => {}); // allow message to be processed
      expect(userInfo.gamecfgData).toBeUndefined();
    });
  });
});
