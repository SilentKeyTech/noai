/** Netlify adapter for the relay. All logic lives in relay/core.mjs. */
import { relay } from '../../relay/core.mjs';

export default (request) => relay(request, process.env);

export const config = { path: '/api/chat' };
