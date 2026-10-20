import type { SiteDef } from './types.ts';

/**
 * Checked against copilot.com, signed in, on 20 Oct 2026: a Lexical editor
 * (span#m365-chat-editor-target-element, role textbox, "Message Copilot") and
 * a submit button labelled "Send". copilot.microsoft.com sends people to
 * copilot.com since October 2026.
 */
export const copilot: SiteDef = {
  id: 'copilot',
  name: 'Microsoft Copilot',
  hosts: ['copilot.microsoft.com', 'copilot.com', 'www.copilot.com'],
  composer: [
    '#m365-chat-editor-target-element[contenteditable="true"]',
    '[contenteditable="true"][aria-label="Message Copilot"]',
    'textarea#userInput',
    'textarea[data-testid="composer-input"]',
    'textarea[placeholder*="Copilot" i]',
    'main textarea',
    '[contenteditable="true"][role="textbox"]',
  ],
  send: ['button[type="submit"][aria-label="Send"]', 'button[aria-label="Send"]', 'button[data-testid="submit-button"]', 'button[aria-label="Submit message"]'],
  answers: ['[data-content="ai-message"]', '[data-content="user-message"]', 'main', '[role="main"]', '[role="log"]'],
};
