/**
 * @fileoverview A simple, lightweight event emitter implementation.
 */

import { EventCallback } from './types';

export class EventEmitter {
  private listeners: { [event: string]: EventCallback[] } = {};

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
    this.listeners[event] = this.listeners[event].filter(
      (listener) => listener !== callback
    );
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
      this.off(event, onceCallback);
      callback(...args);
    };
    this.on(event, onceCallback);
  }
}
