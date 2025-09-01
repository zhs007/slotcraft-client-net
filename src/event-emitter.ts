/**
 * @fileoverview A simple, lightweight event emitter implementation.
 */

import { EventCallback } from './types';

export class EventEmitter {
  private listeners: { [event: string]: EventCallback[] } = {};
  private onceMap = new Map<EventCallback, EventCallback>();

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

    const callbackToRemove = this.onceMap.get(callback) || callback;
    this.listeners[event] = this.listeners[event].filter(
      (listener) => listener !== callbackToRemove
    );

    // Ensure the map is cleaned up if a `once` listener is removed manually.
    this.onceMap.delete(callback);
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
    // Use a copy of the array to prevent issues if a listener calls `off()`
    // during the emission, which would modify the array while it's being iterated.
    [...this.listeners[event]].forEach((listener) => {
      listener(...args);
    });
  }

  /**
   * Subscribes to an event for a single emission.
   * @param event The name of the event.
   * @param callback The function to call once when the event is emitted.
   */
  public once(event: string, callback: EventCallback): void {
    // This wrapper is what's actually stored in the listeners array.
    const onceCallback: EventCallback = (...args: any[]) => {
      // 1. Remove the wrapper from the listeners array for the event.
      this.off(event, onceCallback);
      // 2. Clean up the mapping to prevent memory leaks.
      this.onceMap.delete(callback);
      // 3. Call the original callback.
      callback(...args);
    };

    // Store the mapping from the original callback to the wrapper.
    // This allows `off(event, callback)` to find and remove the wrapper.
    this.onceMap.set(callback, onceCallback);
    this.on(event, onceCallback);
  }
}
