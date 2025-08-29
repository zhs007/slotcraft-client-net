/**
 * @fileoverview A simple, lightweight event emitter implementation.
 */

import { EventCallback } from './types';

export class EventEmitter {
  private listeners: { [event: string]: EventCallback[] } = {};
  private onceListeners: Map<EventCallback, EventCallback> = new Map();

  /**
   * Subscribes to an event.
   * @param event The name of the event.
   * @param callback The function to call when the event is emitted.
   */
  public on(event: string, callback: EventCallback): void {
    if (!this.listeners[event]) {
      this.listeners[event] = [];
    }
    this.listeners[event].push(callback);
  }

  /**
   * Unsubscribes from an event.
   * @param event The name of the event.
   * @param callback The callback function to remove.
   */
  public off(event: string, callback: EventCallback): void {
    if (!this.listeners[event]) {
      return;
    }

    // Check if this callback was a `once` listener
    const onceWrapper = this.onceListeners.get(callback);
    if (onceWrapper) {
      this.onceListeners.delete(callback);
      // Use the wrapper to find and remove the listener
      this.listeners[event] = this.listeners[event].filter((listener) => listener !== onceWrapper);
    } else {
      // Standard removal for `on` listeners
      this.listeners[event] = this.listeners[event].filter((listener) => listener !== callback);
    }
  }

  /**
   * Emits an event, calling all subscribed listeners with the provided arguments.
   * @param event The name of the event to emit.
   * @param args The arguments to pass to the listeners.
   */
  public emit(event: string, ...args: any[]): void {
    if (!this.listeners[event]) {
      return;
    }
    this.listeners[event].forEach((listener) => {
      listener(...args);
    });
  }

  /**
   * Subscribes to an event for a single emission.
   * @param event The name of the event.
   * @param callback The function to call once when the event is emitted.
   */
  public once(event: string, callback: EventCallback): void {
    const onceCallback: EventCallback = (...args: any[]) => {
      // The listener is removed by `off` using the original callback,
      // or it removes itself here after execution.
      this.onceListeners.delete(callback);
      this.off(event, onceCallback);
      callback(...args);
    };
    this.onceListeners.set(callback, onceCallback);
    this.on(event, onceCallback);
  }
}
