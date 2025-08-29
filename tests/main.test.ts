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

  describe('connect()', () => {
    it('should resolve on successful login', async () => {
      const connectPromise = client.connect(TEST_TOKEN);

      // Simulate the connection opening
      await sleep(1);
      mockConnection.onOpen?.();

      await simulateCmdRet('checkver');
      await simulateCmdRet('flblogin');

      await expect(connectPromise).resolves.toBeUndefined();
      expect(client.getState()).toBe(ConnectionState.CONNECTED);
    });

    it('should reject if a command fails', async () => {
      const connectPromise = client.connect(TEST_TOKEN);
      await sleep(1);
      mockConnection.onOpen?.();
      await simulateCmdRet('checkver', false); // Simulate failure

      await expect(connectPromise).rejects.toThrow("Command 'checkver' failed.");
      expect(client.getState()).toBe(ConnectionState.DISCONNECTED);
    });
  });

  describe('with established connection', () => {
    beforeEach(async () => {
      const connectPromise = client.connect(TEST_TOKEN);
      await sleep(1);
      mockConnection.onOpen?.();
      await simulateCmdRet('checkver');
      await simulateCmdRet('flblogin');
      await connectPromise;
    });

    it('enterGame() should work', async () => {
      const enterGamePromise = client.enterGame(TEST_GAME_CODE);
      await simulateCmdRet('comeingame3');
      await expect(enterGamePromise).resolves.toBeDefined();
      expect(client.getState()).toBe(ConnectionState.IN_GAME);
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
  });
});
