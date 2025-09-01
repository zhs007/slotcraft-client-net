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
      const stateChanges: ConnectionState[] = [];
      client.on('state', (e: any) => stateChanges.push(e.current));

      await expect(client.connect(TEST_TOKEN)).resolves.toBeUndefined();
      expect(client.getState()).toBe(ConnectionState.LOGGED_IN);
      expect(loginHandler).toHaveBeenCalledOnce();
      expect(stateChanges).toEqual([
        ConnectionState.CONNECTING,
        ConnectionState.CONNECTED,
        ConnectionState.LOGGING_IN,
        ConnectionState.LOGGED_IN,
      ]);
    });

    it('should fail to connect if login command is rejected', async () => {
      server.on('flblogin', (msg, ws) => {
        server.send(ws, { msgid: 'cmdret', cmdid: 'flblogin', isok: false });
      });
      client = getClient();
      await expect(client.connect(TEST_TOKEN)).rejects.toThrow();
      expect(client.getState()).toBe(ConnectionState.DISCONNECTED);
    });
  });

  describe('State and Input Validation', () => {
    it('should reject calling methods from wrong state', async () => {
      client = getClient();
      // Cannot enter game when IDLE
      await expect(client.enterGame('foo')).rejects.toThrow('Cannot enter game in state: IDLE');

      // Set up a dummy login handler to prevent timeout, but don't reply.
      // This will keep the client in the LOGGING_IN state.
      server.on('flblogin', () => {});

      const connectPromise = client.connect(TEST_TOKEN);

      // Cannot connect while already CONNECTING
      await expect(client.connect(TEST_TOKEN)).rejects.toThrow(
        'Cannot connect in state: CONNECTING'
      );

      // Wait for the login process to start
      await vi.waitFor(() => {
        expect(client.getState()).toBe(ConnectionState.LOGGING_IN);
      });

      // Cannot enter game while LOGGING_IN
      await expect(client.enterGame('foo')).rejects.toThrow(
        'Cannot enter game in state: LOGGING_IN'
      );

      // Now, let's complete the login
      server.broadcast({ msgid: 'cmdret', cmdid: 'flblogin', isok: true });
      await connectPromise;

      // Cannot spin when LOGGED_IN (must be IN_GAME)
      expect(client.getState()).toBe(ConnectionState.LOGGED_IN);
      await expect(client.spin({})).rejects.toThrow('Cannot spin in state: LOGGED_IN');
    });
  });

  describe('In-Game and Other Flows', () => {
    beforeEach(async () => {
      // Setup a client that is connected and in a game for each test
      await connectAndEnterGame();
    });

    it('should enter a game and cache initial game data', () => {
      const userInfo = client.getUserInfo();
      expect(client.getState()).toBe(ConnectionState.IN_GAME);
      expect(userInfo.gamecode).toBe(TEST_GAME_CODE);
      expect(userInfo.gameid).toBe(123);
      expect(userInfo.ctrlid).toBe(456);
    });

    it('should send a spin command and handle the response', async () => {
      server.on('gamectrl3', (msg, ws) => {
        server.send(ws, { msgid: 'gamemoduleinfo', totalwin: 100 });
        server.send(ws, { msgid: 'cmdret', cmdid: 'gamectrl3', isok: true });
      });
      await client.spin({ bet: 1, lines: 25 });
      expect(client.getState()).toBe(ConnectionState.SPINEND);
    });
  });
});
