/**
 * Where things are on a chat website. Sites change their markup often, so each
 * one lives in its own small file and lists several selectors, newest first.
 * When none of the `composer` selectors match, the extension refuses to send
 * and warns; it never lets text through unchecked.
 */
export interface SiteDef {
  id: string;
  name: string;
  /** host names this definition covers */
  hosts: string[];
  /** only pages under this path, when set */
  path?: string;
  /** the chat box: a textarea or a contenteditable element */
  composer: string[];
  /** the site's own send button */
  send: string[];
  /** where answers and sent messages are drawn, for putting real values back on screen */
  answers: string[];
}
