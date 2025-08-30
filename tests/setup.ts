// This file is used to set up the test environment for Vitest.
// It is referenced in `vitest.config.ts`.

// Polyfill the global WebSocket object for the Node.js environment.
import 'isomorphic-ws';
