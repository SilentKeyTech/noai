// SPDX-License-Identifier: MIT OR Apache-2.0
/** Netlify adapter for the voice token endpoint. All logic lives in relay/core.mjs. */
import { voiceToken } from '../../relay/core.mjs';

export default (request) => voiceToken(request, process.env);

export const config = { path: '/api/voice-token' };
