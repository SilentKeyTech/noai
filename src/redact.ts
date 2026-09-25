/**
 * Redaction happens on device, before the gate hashes and sends anything.
 * Each value becomes a placeholder like [EMAIL_1]. The map from placeholder to
 * real value never leaves this process, so the answer is rehydrated locally:
 * the model can say "call [PHONE_1]" and the owner reads the real number.
 */

interface Rule {
  kind: string;
  pattern: RegExp;
  accept?: (m: string) => boolean;
}

function luhn(digits: string): boolean {
  const d = digits.replace(/\D/g, '');
  if (d.length < 13 || d.length > 19) return false;
  let sum = 0;
  for (let i = 0; i < d.length; i++) {
    let n = Number(d[d.length - 1 - i]);
    if (i % 2 === 1) {
      n *= 2;
      if (n > 9) n -= 9;
    }
    sum += n;
  }
  return sum % 10 === 0;
}

/** Order matters: the most specific patterns run first. */
const RULES: Rule[] = [
  { kind: 'SECRET', pattern: /\b(?:sk|pk|rk|ghp|gho|xox[bap]|AKIA)[-_A-Za-z0-9]{16,}\b/g },
  { kind: 'EMAIL', pattern: /\b[A-Za-z0-9._%+-]+@[A-Za-z0-9.-]+\.[A-Za-z]{2,}\b/g },
  { kind: 'IBAN', pattern: /\b[A-Z]{2}\d{2}(?: ?[A-Z0-9]{4}){3,7}(?: ?[A-Z0-9]{1,4})?\b/g },
  { kind: 'CARD', pattern: /\b(?:\d[ -]?){13,19}\b/g, accept: luhn },
  { kind: 'PHONE', pattern: /(?<![\w])\+?\d[\d\s().-]{6,}\d(?![\w])/g, accept: (m) => m.replace(/\D/g, '').length >= 8 },
  { kind: 'IP', pattern: /\b(?:\d{1,3}\.){3}\d{1,3}\b/g },
];

export interface Redaction {
  text: string;
  counts: Record<string, number>;
  /** placeholder -> original, stays on device */
  map: Map<string, string>;
}

/**
 * Redact one or more texts with a shared placeholder space, so the same value
 * gets the same placeholder in the question and in every passage.
 */
export function redactAll(texts: string[]): { texts: string[]; counts: Record<string, number>; map: Map<string, string> } {
  const byValue = new Map<string, string>();
  const map = new Map<string, string>();
  const counts: Record<string, number> = {};
  const out = texts.map((input) => {
    let text = input;
    for (const rule of RULES) {
      text = text.replace(rule.pattern, (m) => {
        if (/^\[[A-Z]+_\d+\]$/.test(m)) return m;
        if (rule.accept && !rule.accept(m)) return m;
        const key = `${rule.kind}:${m}`;
        let ph = byValue.get(key);
        if (!ph) {
          counts[rule.kind] = (counts[rule.kind] ?? 0) + 1;
          ph = `[${rule.kind}_${String(counts[rule.kind])}]`;
          byValue.set(key, ph);
          map.set(ph, m);
        }
        return ph;
      });
    }
    return text;
  });
  return { texts: out, counts, map };
}

export function redact(text: string): Redaction {
  const r = redactAll([text]);
  return { text: r.texts[0] ?? '', counts: r.counts, map: r.map };
}

export function rehydrate(text: string, map: Map<string, string>): string {
  return text.replace(/\[[A-Z]+_\d+\]/g, (ph) => map.get(ph) ?? ph);
}
