import type { SiteDef } from './types.ts';

export const copilot: SiteDef = {
  id: 'copilot',
  name: 'Microsoft Copilot',
  hosts: ['copilot.microsoft.com'],
  composer: ['textarea#userInput', 'textarea[data-testid="composer-input"]', 'textarea[placeholder*="Copilot" i]', 'main textarea'],
  send: ['button[data-testid="submit-button"]', 'button[aria-label="Submit message"]', 'button[aria-label*="Submit" i]', 'button[aria-label*="Send" i]'],
  answers: ['[data-content="ai-message"]', '[data-content="user-message"]', 'main'],
};
