import type { SiteDef } from './types.ts';

/**
 * extension/test-page/chat.html, served by scripts/extension-test-page.ts. It
 * copies ChatGPT's chat box markup so the extension can be tried without an
 * account. Covered only under its own path on 127.0.0.1.
 */
export const local: SiteDef = {
  id: 'local-test',
  name: 'NOAI+ test page',
  hosts: ['127.0.0.1'],
  path: '/noai-extension-test/',
  composer: ['#prompt-textarea[contenteditable="true"]'],
  send: ['button[data-testid="send-button"]'],
  answers: ['[data-message-author-role]'],
};
