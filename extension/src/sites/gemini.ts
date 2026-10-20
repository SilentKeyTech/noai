import type { SiteDef } from './types.ts';

export const gemini: SiteDef = {
  id: 'gemini',
  name: 'Google Gemini',
  hosts: ['gemini.google.com'],
  composer: ['rich-textarea .ql-editor[contenteditable="true"]', 'div.ql-editor[contenteditable="true"]', 'rich-textarea [contenteditable="true"]'],
  send: ['button.send-button', 'button[aria-label="Send message"]', 'button[aria-label*="Send" i]'],
  answers: ['message-content', 'user-query', 'model-response', 'main'],
};
