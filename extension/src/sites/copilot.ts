import type { SiteDef } from './types.ts';

export const copilot: SiteDef = {
  id: 'copilot',
  name: 'Microsoft Copilot',
  // copilot.microsoft.com sends people to copilot.com since October 2026
  hosts: ['copilot.microsoft.com', 'copilot.com', 'www.copilot.com'],
  composer: ['textarea#userInput', 'textarea[data-testid="composer-input"]', 'textarea[placeholder*="Copilot" i]', 'main textarea', '[contenteditable="true"][role="textbox"]', 'textarea[placeholder*="message" i]'],
  send: ['button[data-testid="submit-button"]', 'button[aria-label="Submit message"]', 'button[aria-label*="Submit" i]', 'button[aria-label*="Send" i]'],
  answers: ['[data-content="ai-message"]', '[data-content="user-message"]', 'main'],
};
