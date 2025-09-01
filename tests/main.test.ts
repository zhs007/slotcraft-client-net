import { describe, it, expect, beforeEach, vi } from 'vitest';
import { SlotcraftClient } from '../src/main';
import { Connection } from '../src/connection';
import { ConnectionState, SlotcraftClientOptions } from '../src/types';

// Mock the Connection class
vi.mock('../src/connection');

// Helper to introduce a small delay for async operations to complete
const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

describe('SlotcraftClient (Real Timers)', () => {
  let client: SlotcraftClient;
  let mockConnection: any;
  const options: SlotcraftClientOptions = {
    url: 'ws://test.com',
    reconnectDelay: 10, // Use short delays for testing
    requestTimeout: 50,
  };
  const TEST_TOKEN = 'test-token';
  const TEST_GAME_CODE = 'test-game';

  beforeEach(() => {
    vi.clearAllMocks();
    client = new SlotcraftClient(options);
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

  describe('Connection and Login Flow', () => {
    it('should transition through all states correctly on successful connection and login', async () => {
      const stateChanges: ConnectionState[] = [];
      client.on('state', (e: any) => stateChanges.push(e.current));

      const connectPromise = client.connect(TEST_TOKEN);

      expect(client.getState()).toBe(ConnectionState.CONNECTING);

      // Simulate the connection opening
      await sleep(1);
      mockConnection.onOpen?.();

      expect(client.getState()).toBe(ConnectionState.LOGGING_IN);

      await simulateCmdRet('flblogin');

      await expect(connectPromise).resolves.toBeUndefined();
      expect(client.getState()).toBe(ConnectionState.LOGGED_IN);

      // Check the sequence of states
      expect(stateChanges).toEqual([
        ConnectionState.CONNECTING,
        ConnectionState.CONNECTED,
        ConnectionState.LOGGING_IN,
        ConnectionState.LOGGED_IN,
      ]);
    });

    it('should reject if login command fails', async () => {
      const connectPromise = client.connect(TEST_TOKEN);
      await sleep(1);
      mockConnection.onOpen?.();
      await simulateCmdRet('flblogin', false); // Simulate failure

      await expect(connectPromise).rejects.toThrow("Command 'flblogin' failed.");
      expect(client.getState()).toBe(ConnectionState.DISCONNECTED);
    });

    it('should reject if disconnected before login completes', async () => {
      const connectPromise = client.connect(TEST_TOKEN);
      await sleep(1);
      mockConnection.onClose?.({ wasClean: false, reason: 'Network error' }); // Disconnect before open

      await expect(connectPromise).rejects.toThrow('Network error');
      expect(client.getState()).toBe(ConnectionState.RECONNECTING);
    });
  });

  describe('Actions in incorrect states', () => {
    it('should not allow send() when not authenticated', async () => {
      expect(client.getState()).toBe(ConnectionState.IDLE);
      await expect(client.send('any_cmd')).rejects.toThrow(
        'Cannot send message in state: IDLE'
      );

      const connectPromise = client.connect(TEST_TOKEN);
      expect(client.getState()).toBe(ConnectionState.CONNECTING);
      await expect(client.send('any_cmd')).rejects.toThrow(
        'Cannot send message in state: CONNECTING'
      );

      await sleep(1);
      mockConnection.onOpen?.();
      expect(client.getState()).toBe(ConnectionState.LOGGING_IN);
      // This is allowed for the login command itself
      // await expect(client.send('any_cmd')).rejects.toThrow();

      // Clean up
      await simulateCmdRet('flblogin', false);
      try {
        await connectPromise;
      } catch (e) {
        // ignore
      }
    });

    it('should not allow enterGame() when not logged in', async () => {
      const connectPromise = client.connect(TEST_TOKEN);
      await sleep(1);
      mockConnection.onOpen?.(); // State is now LOGGING_IN
      expect(client.getState()).toBe(ConnectionState.LOGGING_IN);
      await expect(client.enterGame(TEST_GAME_CODE)).rejects.toThrow(
        'Cannot enter game in state: LOGGING_IN'
      );

      // Clean up
      await simulateCmdRet('flblogin', false);
      try {
        await connectPromise;
      } catch (e) {
        // ignore
      }
    });
  });

  describe('with established connection (logged in)', () => {
    beforeEach(async () => {
      const connectPromise = client.connect(TEST_TOKEN);
      await sleep(1);
      mockConnection.onOpen?.();
      await simulateCmdRet('flblogin');
      await connectPromise;
      expect(client.getState()).toBe(ConnectionState.LOGGED_IN);
    });

    it('enterGame() should work', async () => {
      const enterGamePromise = client.enterGame(TEST_GAME_CODE);
      expect(client.getState()).toBe(ConnectionState.ENTERING_GAME);
      await simulateCmdRet('comeingame3');
      await expect(enterGamePromise).resolves.toBeDefined();
      expect(client.getState()).toBe(ConnectionState.IN_GAME);
    });

    it('should attempt to reconnect and re-login on unclean close', async () => {
      const reconnectListener = vi.fn();
      const stateChanges: ConnectionState[] = [];
      client.on('reconnecting', reconnectListener);
      client.on('state', (e: any) => stateChanges.push(e.current));

      mockConnection.onClose?.({ wasClean: false });

      expect(client.getState()).toBe(ConnectionState.RECONNECTING);

      // Wait for reconnect timer
      await sleep(options.reconnectDelay! + 5);
      expect(reconnectListener).toHaveBeenCalled();
      expect(mockConnection.connect).toHaveBeenCalledTimes(2); // Initial + 1 reconnect

      // Simulate successful re-connection and re-login
      mockConnection.onOpen?.();
      await sleep(1);
      await simulateCmdRet('flblogin');
      await sleep(1);

      expect(client.getState()).toBe(ConnectionState.LOGGED_IN);
      expect(stateChanges).toContain(ConnectionState.RECONNECTING);
      expect(stateChanges).toContain(ConnectionState.CONNECTED);
      expect(stateChanges).toContain(ConnectionState.LOGGING_IN);
    });

    // --- Other tests for spin, collect, etc. can be copied from the old file as they assume a working, logged-in state ---
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
  });

  describe('Error Handling and Edge Cases', () => {
    it('should reject connect() if token is provided nowhere', async () => {
      const clientWithoutToken = new SlotcraftClient({ url: 'ws://test.com' });
      await expect(clientWithoutToken.connect()).rejects.toThrow(
        'Token must be provided either in the constructor or to connect()'
      );
    });

    it('should reject _login() if token is missing internally', async () => {
      const clientWithEmptyToken = new SlotcraftClient(options);
      const mockConn = (Connection as any).mock.instances[1];

      const connectPromise = clientWithEmptyToken.connect('valid-token');

      // Manually set token to undefined *after* the connect call but *before* the login logic runs
      (clientWithEmptyToken as any).userInfo.token = undefined;

      await sleep(1);
      mockConn.onOpen?.(); // Trigger the login flow

      await expect(connectPromise).rejects.toThrow('Login failed: token is missing.');
      expect(clientWithEmptyToken.getState()).toBe(ConnectionState.DISCONNECTED);
    });

    it('should reject spin if gameid or ctrlid are missing', async () => {
      // Get to IN_GAME state
      const connectPromise = client.connect(TEST_TOKEN);
      mockConnection.onOpen?.();
      await simulateCmdRet('flblogin');
      await connectPromise;
      const enterPromise = client.enterGame(TEST_GAME_CODE);
      await simulateCmdRet('comeingame3');
      await enterPromise;
      expect(client.getState()).toBe(ConnectionState.IN_GAME);

      // Test without gameid
      (client as any).userInfo.gameid = undefined;
      await expect(client.spin({})).rejects.toThrow('gameid not available');

      // Test without ctrlid
      (client as any).userInfo.gameid = 123; // Restore gameid
      (client as any).userInfo.ctrlid = undefined;
      await expect(client.spin({})).rejects.toThrow('ctrlid not available');
    });

    it('should reject spin if bet is missing and no default is available', async () => {
      const connectPromise = client.connect(TEST_TOKEN);
      mockConnection.onOpen?.();
      await simulateCmdRet('flblogin');
      await connectPromise;
      const enterPromise = client.enterGame(TEST_GAME_CODE);
      await simulateCmdRet('comeingame3');
      await enterPromise;
      await pushMsg({ msgid: 'gamemoduleinfo', gameid: 1, gmi: {} });
      await pushMsg({ msgid: 'gameuserinfo', ctrlid: 1 });

      // No defaultLinebet in userInfo
      (client as any).userInfo.defaultLinebet = undefined;
      await expect(client.spin({})).rejects.toThrow('bet is required');
    });

    it('should reject collect if playIndex cannot be derived', async () => {
      const connectPromise = client.connect(TEST_TOKEN);
      mockConnection.onOpen?.();
      await simulateCmdRet('flblogin');
      await connectPromise;
      const enterPromise = client.enterGame(TEST_GAME_CODE);
      await simulateCmdRet('comeingame3');
      await enterPromise;
      await pushMsg({ msgid: 'gamemoduleinfo', gameid: 1, gmi: {} });

      // Ensure all sources for playIndex are undefined
      (client as any).userInfo.lastPlayIndex = undefined;
      (client as any).userInfo.lastResultsCount = undefined;

      await expect(client.collect()).rejects.toThrow('playIndex not available');
    });

    it('should correctly parse gamecfg and derive linesOptions', async () => {
      const connectPromise = client.connect(TEST_TOKEN);
      mockConnection.onOpen?.();
      await simulateCmdRet('flblogin');
      await connectPromise;

      // Test malformed data
      await pushMsg({ msgid: 'gamecfg', data: '{"bad"' });
      expect((client as any).userInfo.gamecfgData).toBeUndefined();

      // Test deriving linesOptions from data keys
      await pushMsg({ msgid: 'gamecfg', data: '{"50":{}, "10":{}, "25":{}}' });
      expect((client as any).userInfo.linesOptions).toEqual([10, 25, 50]);

      // Test that 'bets' array overrides derived options
      await pushMsg({ msgid: 'gamecfg', data: '{"1":{}, "2":{}}', bets: [5, 3] });
      expect((client as any).userInfo.linesOptions).toEqual([3, 5]);
    });
  });
});
