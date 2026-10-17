import type { SiteDef } from './types.ts';

/** Checked against chatgpt.com, logged out, on 17 Oct 2026: a textarea named "prompt" and a "Send message" button. */
export const chatgpt: SiteDef = {
  id: 'chatgpt',
  name: 'ChatGPT',
  hosts: ['chatgpt.com', 'chat.openai.com'],
  composer: [
    '[data-composer-editor-host] textarea',
    'textarea[name="prompt"]',
    '[data-composer-editor-host] [contenteditable="true"]',
    '#prompt-textarea[contenteditable="true"]',
    'div.ProseMirror[contenteditable="true"]',
    'textarea#prompt-textarea',
  ],
  send: ['button[aria-label="Send message"]', 'button[aria-label="Send prompt"]', 'button[data-testid="send-button"]', '#composer-submit-button'],
  answers: ['[data-message-author-role]', 'main article', 'main'],
};
