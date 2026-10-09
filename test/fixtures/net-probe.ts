// A file for test/gate.test.ts to read. It never runs. The comments below name
// fetch and WebSocket on purpose, and the code reaches the network only through
// a string, which is the kind of call a plain text search misses.
/* fetch(url) in a block comment, and new WebSocket(url) too */
import { createServer, type IncomingMessage } from 'node:http';
export const probe = () => globalThis['fetch'];
export const later = () => import('node:net');
export const serve = createServer;
