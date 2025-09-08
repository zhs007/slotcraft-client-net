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
    // Clear any pending timers to prevent them from leaking between tests
    vi.clearAllTimers();
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

      // The connect promise resolves when the operation is complete.
      await client.connect(TEST_TOKEN);

      // Due to the async nature of the queue, we wait for the state to settle.
      await vi.waitFor(() => expect(client.getState()).toBe(ConnectionState.LOGGED_IN));

      expect(loginHandler).toHaveBeenCalledOnce();
    });
  });

  describe('State and Input Validation', () => {
    it('should reject calling methods from wrong state', async () => {
      client = getClient();
      // Cannot enter game before connect
      await expect(client.enterGame('foo')).rejects.toThrow('Cannot enter game in state: IDLE');

      // Set up a server that never responds to login
      server.on('flblogin', () => {});
      // connect() will time out, reject, and disconnect.
      await expect(client.connect(TEST_TOKEN)).rejects.toThrow(
        'Request timed out for cmdid: flblogin'
      );
      expect(client.getState()).toBe(ConnectionState.DISCONNECTED);

      // Cannot spin when disconnected
      await expect(client.spin({})).rejects.toThrow('Cannot spin in state: DISCONNECTED');
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

    it('should queue auto-collect and manual collect in correct order', async () => {
      const receivedMessages: any[] = [];
      const collectHandler = vi.fn((msg, ws) => {
        receivedMessages.push(msg); // Record the received message
        server.send(ws, { msgid: 'cmdret', cmdid: 'collect', isok: true });
      });
      server.on('collect', collectHandler);

      // Spin results in a win with 2 results, which will trigger auto-collect for index 0
      server.on('gamectrl3', (msg, ws) => {
        server.send(ws, {
          msgid: 'gamemoduleinfo',
          totalwin: 10,
          gmi: { replyPlay: { results: [{}, {}] } }, // 2 results
        });
        server.send(ws, { msgid: 'cmdret', cmdid: 'gamectrl3', isok: true });
      });

      // The spin() promise resolves when its cmdret is received. The cmdret handler
      // for spin is what enqueues the auto-collect operation.
      const spinPromise = client.spin({ bet: 1, lines: 25 });

      // We must wait for the spin to fully complete.
      await spinPromise;

      // After a winning spin that needs collecting, the state should be SPINEND.
      // At this point, the auto-collect operation has been added to the queue.
      expect(client.getState()).toBe(ConnectionState.SPINEND);

      // Now, we issue the manual collect. This will be queued *after* the auto-collect.
      const manualCollectPromise = client.collect();

      // Wait for the manual collect to finish. By this time, both collects
      // should have been sent to the server in order.
      await manualCollectPromise;

      // Now, check the results.
      // The server should have received two 'collect' commands.
      await vi.waitFor(() => expect(collectHandler).toHaveBeenCalledTimes(2));

      // The FIRST one should be the auto-collect for playIndex 0.
      expect(receivedMessages[0].playIndex).toBe(0); // results.length - 2

      // The SECOND one should be the manual collect, which defaults to the last index.
      expect(receivedMessages[1].playIndex).toBe(1); // results.length - 1

      // After all operations are done, the state should be IN_GAME.
      expect(client.getState()).toBe(ConnectionState.IN_GAME);
    });

    it('should use lastPlayIndex + 1 as a fallback when collecting', async () => {
      // Manually set the state to be valid for collect
      (client as any).setState(ConnectionState.SPINEND);
      // Set lastPlayIndex, but ensure lastResultsCount is undefined to force the fallback
      (client as any).userInfo.lastPlayIndex = 0;
      (client as any).userInfo.lastResultsCount = undefined;

      const collectHandler = vi.fn((msg, ws) => {
        server.send(ws, { msgid: 'cmdret', cmdid: 'collect', isok: true });
      });
      server.on('collect', collectHandler);

      await client.collect();

      // Verify the collect was called with the incremented index
      expect(collectHandler).toHaveBeenCalledTimes(1);
      expect(collectHandler.mock.calls[0][0].playIndex).toBe(1);
    });
  });

  describe('Resume Flow', () => {
    it('should resume into SPINEND state if there is a pending win', async () => {
      client = getClient();
      server.on('flblogin', (msg, ws) => {
        server.send(ws, { msgid: 'cmdret', cmdid: 'flblogin', isok: true });
      });
      // This is the key part: the server's response to comeingame includes
      // a payload that looks like the result of a previous, unfinished spin.
      server.on('comeingame3', (msg, ws) => {
        server.send(ws, {
          msgid: 'gamemoduleinfo',
          gameid: 123,
          totalwin: 50,
          gmi: {
            replyPlay: {
              results: [{ coinWin: 50 }], // A pending result
              finished: true,
            },
          },
        });
        server.send(ws, { msgid: 'gameuserinfo', ctrlid: 456 });
        server.send(ws, { msgid: 'cmdret', cmdid: 'comeingame3', isok: true });
      });

      const stateSpy = vi.fn();
      client.on('state', stateSpy);

      await client.connect(TEST_TOKEN);
      await client.enterGame(TEST_GAME_CODE);

      // The client should detect the pending win and move to SPINEND, not IN_GAME.
      expect(client.getState()).toBe(ConnectionState.SPINEND);
      const userInfo = client.getUserInfo();
      expect(userInfo.lastTotalWin).toBe(50);

      // Check the state transitions
      const transitions = stateSpy.mock.calls.map((call) => call[0].current);
      expect(transitions).toContain(ConnectionState.RESUMING);
      expect(transitions[transitions.length - 1]).toBe(ConnectionState.SPINEND);
    });

    it('should resume into WAITTING_PLAYER state if there is a pending choice', async () => {
      client = getClient();
      server.on('flblogin', (msg, ws) => {
        server.send(ws, { msgid: 'cmdret', cmdid: 'flblogin', isok: true });
      });
      server.on('comeingame3', (msg, ws) => {
        server.send(ws, {
          msgid: 'gamemoduleinfo',
          gameid: 123,
          gmi: {
            replyPlay: {
              results: [],
              nextCommands: ['bg-selectfg'],
              nextCommandParams: ['lefty-bugsy-lefty'],
              finished: false, // The key indicator for a player choice
            },
          },
        });
        server.send(ws, { msgid: 'cmdret', cmdid: 'comeingame3', isok: true });
      });

      await client.connect(TEST_TOKEN);
      await client.enterGame(TEST_GAME_CODE);

      // The client should detect the pending choice and move to WAITTING_PLAYER.
      expect(client.getState()).toBe(ConnectionState.WAITTING_PLAYER);
      const userInfo = client.getUserInfo();
      expect(userInfo.optionals).toBeDefined();
      expect(userInfo.optionals?.length).toBe(1);
      expect(userInfo.optionals?.[0].command).toBe('bg-selectfg');
    });

    it('should trigger auto-collect when resuming with multiple results', async () => {
      client = getClient();
      const collectHandler = vi.fn((msg, ws) => {
        server.send(ws, { msgid: 'cmdret', cmdid: 'collect', isok: true });
      });
      server.on('collect', collectHandler);
      server.on('flblogin', (msg, ws) => {
        server.send(ws, { msgid: 'cmdret', cmdid: 'flblogin', isok: true });
      });
      server.on('comeingame3', (msg, ws) => {
        server.send(ws, {
          msgid: 'gamemoduleinfo',
          gameid: 123,
          totalwin: 100,
          gmi: {
            replyPlay: {
              results: [{}, {}, {}], // 3 results
              finished: true,
            },
          },
        });
        server.send(ws, { msgid: 'cmdret', cmdid: 'comeingame3', isok: true });
      });

      await client.connect(TEST_TOKEN);
      await client.enterGame(TEST_GAME_CODE);

      // The final state should be SPINEND, as there's still one result to collect manually.
      expect(client.getState()).toBe(ConnectionState.SPINEND);

      // An auto-collect should have been triggered for the second-to-last result (index 1).
      await vi.waitFor(() => expect(collectHandler).toHaveBeenCalledOnce());
      expect(collectHandler.mock.calls[0][0].playIndex).toBe(1); // 3 - 2 = 1
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

  describe('Reconnection and Advanced Error Handling', () => {
    it('should reconnect and re-login after an unclean disconnection', async () => {
      vi.useFakeTimers();
      await connectAndEnterGame();
      const stateHandler = vi.fn();
      client.on('state', stateHandler);
      const reconnectingHandler = vi.fn();
      client.on('reconnecting', reconnectingHandler);

      // Simulate a sudden network failure
      server.terminateAll();

      // Should transition to RECONNECTING
      await vi.waitFor(() => expect(client.getState()).toBe(ConnectionState.RECONNECTING));
      expect(stateHandler).toHaveBeenCalledWith(
        expect.objectContaining({ current: ConnectionState.RECONNECTING })
      );
      expect(reconnectingHandler).toHaveBeenCalledWith({ attempt: 1 });

      // Server is down, so we need to restart it to simulate recovery on the same port
      const originalPort = port;
      await server.stop();
      server = new MockServer();
      port = await server.start(originalPort);
      // Re-register handlers for the new server instance
      server.on('flblogin', (msg, ws) => {
        server.send(ws, { msgid: 'cmdret', cmdid: 'flblogin', isok: true });
      });

      // Advance time to trigger reconnect attempt
      await vi.advanceTimersByTimeAsync(100); // Default reconnectDelay is 10ms

      // Should eventually go through CONNECTED -> LOGGING_IN -> LOGGED_IN
      await vi.waitFor(
        () => {
          expect(client.getState()).toBe(ConnectionState.LOGGED_IN);
        },
        { timeout: 500 }
      );

      vi.useRealTimers();
    });

    it('should give up after max reconnect attempts (direct call)', () => {
      const logger = { log: vi.fn(), warn: vi.fn(), error: vi.fn() };
      client = getClient({ maxReconnectAttempts: 2, reconnectDelay: 50, logger });
      const clientAny = client as any;

      // Manually set state to something that allows reconnecting
      clientAny.state = ConnectionState.RECONNECTING;

      // Call tryReconnect manually
      clientAny.tryReconnect(); // attempt 1
      expect(clientAny.reconnectAttempts).toBe(1);

      clientAny.tryReconnect(); // attempt 2
      expect(clientAny.reconnectAttempts).toBe(2);

      // This one should trigger the "give up" logic
      clientAny.tryReconnect();
      expect(logger.error).toHaveBeenCalledWith('Max reconnection attempts reached. Giving up.');
      expect(client.getState()).toBe(ConnectionState.DISCONNECTED);
    });

    it('should handle a failed heartbeat by logging a warning (direct call)', () => {
      vi.useFakeTimers();
      const logger = { log: vi.fn(), warn: vi.fn(), error: vi.fn() };
      client = getClient({ logger });
      const clientAny = client as any;

      // Mock the send method to reject for 'keepalive'
      const originalSend = client.send.bind(client);
      vi.spyOn(client, 'send').mockImplementation(async (cmdid, params) => {
        if (cmdid === 'keepalive') {
          return Promise.reject(new Error('Fake heartbeat failure'));
        }
        return originalSend(cmdid, params);
      });

      // Manually call startHeartbeat
      clientAny.startHeartbeat();

      // Manually trigger the interval
      const intervalId = clientAny.heartbeatInterval;
      expect(intervalId).toBeDefined();
      vi.advanceTimersByTimeAsync(30000);

      // The catch block is async, so wait for logger to be called
      return vi.waitFor(() => {
        expect(logger.warn).toHaveBeenCalledWith(
          'Heartbeat failed:',
          expect.objectContaining({ message: 'Fake heartbeat failure' })
        );
      });
    });

    it('should reject send() from disallowed states', async () => {
      client = getClient();
      expect(client.getState()).toBe(ConnectionState.IDLE);
      await expect(client.send('anything')).rejects.toThrow(
        'Cannot send message in state: IDLE'
      );
      client.disconnect();
      expect(client.getState()).toBe(ConnectionState.DISCONNECTED);
      await expect(client.send('anything')).rejects.toThrow(
        'Cannot send message in state: DISCONNECTED'
      );
    });

    it('should reject connect() without a token', async () => {
      client = getClient();
      await expect(client.connect()).rejects.toThrow('Token must be provided');
    });

    it('should reject collect() when index cannot be derived', async () => {
      await connectAndEnterGame();
      // Ensure no values are available to derive the index from
      (client as any).userInfo.lastResultsCount = undefined;
      (client as any).userInfo.lastPlayIndex = undefined;
      // Manually set state to allow the call
      (client as any).setState(ConnectionState.SPINEND);
      await expect(client.collect()).rejects.toThrow('playIndex is not available');
    });

    it('should handle collect() failure and revert to SPINEND', async () => {
      await connectAndEnterGame();
      (client as any).setState(ConnectionState.SPINEND); // Set state manually
      server.on('collect', (msg, ws) => {
        server.send(ws, { msgid: 'cmdret', cmdid: 'collect', isok: false });
      });

      await expect(client.collect(0)).rejects.toThrow("Command 'collect' failed.");
      // Should revert to SPINEND to allow a retry
      expect(client.getState()).toBe(ConnectionState.SPINEND);
    });
  });

  describe('Cache Update Logic', () => {
    beforeEach(async () => {
      await connectAndEnterGame();
    });

    it('should derive linesOptions from gamecfg data if bets array is missing', async () => {
      server.broadcast({
        msgid: 'gamecfg',
        data: JSON.stringify({ '25': {}, '50': {} }),
      });
      await vi.waitFor(() => expect(client.getUserInfo().linesOptions).toBeDefined());
      expect(client.getUserInfo().linesOptions).toEqual([25, 50]);
    });

    it('should handle unparseable gamecfg data without crashing', async () => {
      const errorHandler = vi.fn();
      client.on('error', errorHandler);
      server.broadcast({
        msgid: 'gamecfg',
        data: 'this-is-not-json',
      });
      // Should just set gamecfgData to undefined and not throw
      await vi.waitFor(() => expect(client.getUserInfo().gamecfgData).toBeUndefined());
      expect(errorHandler).not.toHaveBeenCalled(); // This is not a protocol error
    });

    it('should correctly cache top-level playwin from gamemoduleinfo', async () => {
      server.broadcast({
        msgid: 'gamemoduleinfo',
        playwin: 500,
        gmi: { totalwin: 1000 },
      });
      await vi.waitFor(() => expect(client.getUserInfo().lastPlayWin).toBe(500));
      // gmi.totalwin should still be cached as lastTotalWin
      expect(client.getUserInfo().lastTotalWin).toBe(1000);
    });
  });
});
