/**
 * @fileoverview Main entry point for the slotcraft-client-net library.
 *
 * This file exports the primary client class `SlotcraftClient` as well as all
 * relevant types and interfaces for consumers of the library.
 */

export { SlotcraftClient } from './main';
export {
  ConnectionState,
  SlotcraftClientOptions,
  DisconnectEventPayload,
  RawMessagePayload,
  StateChangePayload,
  UserInfo,
  SpinParams,
  Logger,
} from './types';
