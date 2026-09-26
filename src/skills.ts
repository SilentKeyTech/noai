/**
 * Reusable skills: the same gate, the same redaction, the same receipt, with
 * a task line added to the question. Pure text handling, shared by the Node
 * agent and the browser build.
 *
 * A skill never changes the system prompt, because the relay only forwards
 * NOAI's own system prompt. It only shapes the QUESTION the model sees.
 */

export type SkillId = 'draft' | 'remind' | 'bill';

export interface Skill {
  id: SkillId;
  label: string;
  /** what the input box is pre-filled with when the skill is picked */
  starter: string;
  /** the task line the model sees, appended to the owner's words */
  task: string;
  /** how many passages the retriever may add; 0 means the question carries everything */
  passages: number;
}

export const SKILLS: Record<SkillId, Skill> = {
  draft: {
    id: 'draft',
    label: 'Draft a message',
    starter: 'Draft a message to ',
    task: 'TASK: Write a short message the owner can send, in plain first person, using only facts from the passages. Output the message only.',
    passages: 3,
  },
  remind: {
    id: 'remind',
    label: 'Set a reminder',
    starter: 'Remind me to ',
    task: 'TASK: The owner wants a reminder. Confirm it in one sentence, then end with one line of the form "REMIND: <YYYY-MM-DD> | <what>" using the date they gave or the one in the passages. If no date is given or found, ask for one and add no REMIND line.',
    passages: 2,
  },
  bill: {
    id: 'bill',
    label: 'Summarise a bill',
    starter: 'Summarise this bill: ',
    task: 'TASK: Summarise the bill in the question in at most four short lines: who it is from, the amount, the due date, and anything unusual. Keep placeholders exactly as written.',
    passages: 0,
  },
};

const PATTERNS: [SkillId, RegExp][] = [
  ['draft', /^\s*(?:please\s+)?(?:draft|write)\s+(?:a\s+|an\s+)?(?:message|text|note|email|reply)\b/i],
  ['remind', /^\s*(?:please\s+)?(?:remind me|set (?:a )?reminder)\b/i],
  ['bill', /^\s*(?:please\s+)?summari[sz]e\s+(?:this|my|the)\s+(?:bill|invoice|statement)\b/i],
];

export function detectSkill(text: string): Skill | null {
  for (const [id, re] of PATTERNS) if (re.test(text)) return SKILLS[id];
  return null;
}

/** The question the model sees for a skill: the owner's words, then the task. */
export function skillQuestion(skill: Skill, text: string): string {
  return `${text.trim()}\n\n${skill.task}`;
}

export interface Reminder {
  due: string;
  what: string;
}

/** Pull "REMIND:" lines out of a rehydrated answer. Only real calendar dates are accepted. */
export function splitReminders(answer: string): { answer: string; reminders: Reminder[] } {
  const reminders: Reminder[] = [];
  const kept = answer
    .split('\n')
    .filter((line) => {
      if (!/^\s*REMIND:/i.test(line)) return true;
      // Every REMIND line is an instruction to the device, never text for the owner.
      // Only a well formed one with a real calendar date becomes a reminder.
      const m = /^\s*REMIND:\s*(\d{4}-\d{2}-\d{2})\s*\|\s*(.+)$/i.exec(line);
      if (!m) return false;
      const [, due = '', what = ''] = m;
      const d = new Date(`${due}T00:00:00Z`);
      if (!Number.isNaN(d.getTime()) && d.toISOString().slice(0, 10) === due && what.trim()) reminders.push({ due, what: what.trim() });
      return false;
    })
    .join('\n')
    .trim();
  return { answer: kept, reminders };
}
