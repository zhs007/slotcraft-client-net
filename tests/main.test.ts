import { describe, it, expect, beforeEach, vi, afterEach } from 'vitest';
import { NetworkClient } from '../src/main';
import { Connection } from '../src/connection';
import { ConnectionState, NetworkClientOptions } from '../src/types';

vi.mock('../src/connection');
vi.useFakeTimers();

describe('NetworkClient', () => {
  let client: NetworkClient;
  let mockConnection: any;
  const options: NetworkClientOptions = {
    url: 'ws://test.com',
    token: 'test-token',
    gamecode: 'test-game',
    reconnectDelay: 100, // Use a short delay for tests
  };

  beforeEach(() => {
  vi.clearAllMocks();
  vi.clearAllTimers();
    client = new NetworkClient(options);
  mockConnection = (Connection as any).mock.instances[0];
  });

  // Helper to get client into IN_GAME state
  const bringToInGameState = async () => {
    const connectPromise = client.connect();
    mockConnection.onOpen?.();
    mockConnection.onMessage?.({
      data: JSON.stringify({ cmd: 'login', errno: 0, data: {} }),
    } as MessageEvent);
    mockConnection.onMessage?.({
      data: JSON.stringify({ cmd: 'enter_game', errno: 0, data: {} }),
    } as MessageEvent);
    await connectPromise;
  };

  it('should initialize with IDLE state', () => {
    expect(client.getState()).toBe(ConnectionState.IDLE);
  });

  describe('connect()', () => {
    it('should resolve on successful connection', async () => {
      await bringToInGameState();
      expect(client.getState()).toBe(ConnectionState.IN_GAME);
    });

    it('should reject if connection closes', async () => {
      const connectPromise = client.connect();
      mockConnection.onOpen?.();
      mockConnection.onClose?.({
        code: 1006,
        reason: 'Abnormal closure',
        wasClean: true,
      } as CloseEvent);
      await expect(connectPromise).rejects.toThrow('Disconnected: Abnormal closure');
    });
  });

  describe('send()', () => {
    beforeEach(async () => {
      await bringToInGameState();
    });

    it('should send a message and resolve with the response', async () => {
      const sendPromise = client.send('test_cmd');
      mockConnection.onMessage?.({
        data: JSON.stringify({ cmd: 'test_cmd', ctrlid: 3, data: { success: true } }),
      } as MessageEvent);
      await expect(sendPromise).resolves.toEqual({ success: true });
    });
  });

  describe('events', () => {
    it('should emit "disconnect" with payload', () => {
      const listener = vi.fn();
      client.on('disconnect', listener);
      client.connect().catch(() => {});
      const closeEvent = { code: 1000, reason: 'Normal', wasClean: true } as CloseEvent;
      mockConnection.onClose?.(closeEvent);
      expect(listener).toHaveBeenCalledWith({ code: 1000, reason: 'Normal', wasClean: true });
    });
  });

  describe('resilience: reconnection and caching', () => {
  let setTimeoutSpy: any;

    beforeEach(async () => {
      await bringToInGameState();
  vi.spyOn(console, 'log').mockImplementation(() => {}); // Suppress console.log
  setTimeoutSpy = vi.spyOn(global, 'setTimeout');
    });

    afterEach(() => {
      setTimeoutSpy.mockRestore();
    });

    it('should transition to RECONNECTING on unclean close', () => {
      mockConnection.onClose?.({ wasClean: false } as CloseEvent);
      expect(client.getState()).toBe(ConnectionState.RECONNECTING);
      expect(setTimeout).toHaveBeenCalledTimes(1);
    });

    it('should attempt to reconnect with exponential backoff', () => {
      // First unclean close
      mockConnection.onClose?.({ wasClean: false } as CloseEvent);
      expect(client.getState()).toBe(ConnectionState.RECONNECTING);
      expect(setTimeout).toHaveBeenCalledWith(expect.any(Function), 100); // 100 * 2^0

  // First reconnect attempt fails
  vi.advanceTimersByTime(100);
      expect(mockConnection.connect).toHaveBeenCalledTimes(2); // Initial connect + 1st reconnect
      mockConnection.onClose?.({ wasClean: false } as CloseEvent);
      expect(setTimeout).toHaveBeenCalledWith(expect.any(Function), 200); // 100 * 2^1
    });

    it('should queue send requests while reconnecting and process them on success', async () => {
      // 1. Trigger reconnection
      mockConnection.onClose?.({ wasClean: false } as CloseEvent);
      expect(client.getState()).toBe(ConnectionState.RECONNECTING);

      // 2. Queue a request
      const sendPromise = client.send('queued_cmd', { value: 1 });
      expect(mockConnection.send).not.toHaveBeenCalledWith(expect.stringContaining('queued_cmd'));

      // 3. Simulate successful reconnection
  vi.advanceTimersByTime(100); // Trigger reconnect attempt
      mockConnection.onOpen?.();
      mockConnection.onMessage?.({
        data: JSON.stringify({ cmd: 'login', errno: 0, data: {} }),
      } as MessageEvent);
      mockConnection.onMessage?.({
        data: JSON.stringify({ cmd: 'enter_game', errno: 0, data: {} }),
      } as MessageEvent);

      // 4. Verify queued message is now sent (ctrlid: 1,2 for initial, 3 for queued)
      expect(mockConnection.send).toHaveBeenCalledWith(
        expect.stringContaining('"cmd":"queued_cmd"')
      );

      // 5. Verify the original promise resolves
      const responseData = { status: 'ok' };
      // After initial connect (1,2) and reconnect (3,4), the queued command will have ctrlid 5.
      mockConnection.onMessage?.({
        data: JSON.stringify({ cmd: 'queued_cmd', ctrlid: 5, data: responseData }),
      } as MessageEvent);
      await expect(sendPromise).resolves.toEqual(responseData);
    });

    it('should reject queued requests if reconnection ultimately fails', async () => {
      const newOptions = { ...options, maxReconnectAttempts: 1 };
  client = new NetworkClient(newOptions);
  mockConnection = (Connection as any).mock.instances[1];
      await bringToInGameState();

      mockConnection.onClose?.({ wasClean: false } as CloseEvent);
      const sendPromise = client.send('will_fail');

      // Fail the only reconnect attempt
  vi.advanceTimersByTime(100);
      mockConnection.onClose?.({ wasClean: false } as CloseEvent);

      await expect(sendPromise).rejects.toThrow('Reconnection failed.');
      expect(client.getState()).toBe(ConnectionState.DISCONNECTED);
    });
  });

  describe('API Edge Cases and Error Handling', () => {
    it('should reject if connect is called while already connected', async () => {
      await bringToInGameState();
      await expect(client.connect()).rejects.toThrow('Client is already connected or connecting.');
    });

    it('should handle errors from the connection', () => {
  const errorListener = vi.fn();
      client.on('error', errorListener);
      client.connect().catch(() => {});

      const errorEvent = new Event('error');
      mockConnection.onError?.(errorEvent);
      // Per the spec, an error is followed by a close event.
      mockConnection.onClose?.({ wasClean: false } as CloseEvent);

      expect(errorListener).toHaveBeenCalledWith(errorEvent);
      // An error implies an unclean close, which should trigger reconnection.
      expect(client.getState()).toBe(ConnectionState.RECONNECTING);
    });

    it('should reject queued requests on manual disconnect', async () => {
      await bringToInGameState();
      mockConnection.onClose?.({ wasClean: false } as CloseEvent);
      expect(client.getState()).toBe(ConnectionState.RECONNECTING);

      const sendPromise = client.send('queued');
      client.disconnect();

      await expect(sendPromise).rejects.toThrow('Client disconnected.');
      expect(client.getState()).toBe(ConnectionState.DISCONNECTED);
    });
  });
});
