/**
 * More kinds hidden on device: addresses, dates of birth, medical terms. Each
 * test is one claim, including what is deliberately left readable.
 */
import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { redact, rehydrate } from '../src/redact.ts';

const hides = (text: string, secrets: string[], kind: string) => {
  const r = redact(text);
  for (const s of secrets) assert.ok(!r.text.includes(s), `"${s}" was not hidden: ${r.text}`);
  assert.ok((r.counts[kind] ?? 0) >= 1, `no ${kind} counted: ${r.text}`);
  assert.equal(rehydrate(r.text, r.map), text, 'the real text must come back whole');
  return r;
};

describe('addresses', () => {
  it('hides a Saudi National Address code', () => {
    hides('Deliver to RRRD2929 before Friday.', ['RRRD2929'], 'ADDRESS');
  });
  it('hides a numbered street address', () => {
    hides('Meet at 221 Olaya Main Street, Riyadh tomorrow.', ['221 Olaya Main Street'], 'ADDRESS');
  });
  it('hides what follows "my address is" and "lives at"', () => {
    hides('My address is Building 12, Al Nakheel District, Riyadh 12382', ['Al Nakheel'], 'ADDRESS');
    hides('Sami lives at the villa behind the old souq in Jeddah', ['villa behind'], 'ADDRESS');
  });
  it('hides an Arabic address after العنوان and a postal code', () => {
    hides('العنوان: حي النخيل، شارع الأمير سلطان، الرياض', ['النخيل'], 'ADDRESS');
    hides('Postal code: 12382 Riyadh', ['12382'], 'ADDRESS');
  });
  it('leaves an email address, an IP address and a landmark alone', () => {
    const r = redact('My email address is sami@example.com and the server ip address is 10.0.0.5. We met on King Fahd Road.');
    assert.equal(r.counts.ADDRESS, undefined, r.text);
    assert.match(r.text, /King Fahd Road/);
  });
});

describe('dates of birth', () => {
  it('hides a full date of birth in several writings', () => {
    hides('Sami was born on 12/03/1985 in Beirut.', ['12/03/1985'], 'DOB');
    hides('Date of birth: 1985-03-12', ['1985-03-12'], 'DOB');
    hides('DOB 12 March 1985', ['12 March 1985'], 'DOB');
    hides('born March 12, 1985', ['March 12, 1985'], 'DOB');
    hides('تاريخ الميلاد: 12/03/1985', ['12/03/1985'], 'DOB');
  });
  it('hides a date of birth written in Arabic-Indic digits', () => {
    hides('تاريخ الميلاد: ١٢/٠٣/١٩٨٥', ['١٢/٠٣/١٩٨٥'], 'DOB');
  });
  it('leaves an ordinary date and a birthday with no year readable, because a reminder needs them', () => {
    const r = redact('Sami turns 30 on 22 November. The invoice is due 2026-10-12. Meeting 12/10/2026.');
    assert.equal(r.counts.DOB, undefined, r.text);
    assert.match(r.text, /22 November/);
    assert.match(r.text, /2026-10-12/);
    assert.match(r.text, /12\/10\/2026/);
  });
});

describe('medical terms', () => {
  it('hides conditions and treatments, in English and Arabic', () => {
    hides('He was treated for Diabetes and takes metformin daily.', ['Diabetes', 'metformin'], 'MEDICAL');
    hides('She is pregnant and has high blood pressure.', ['pregnant', 'high blood pressure'], 'MEDICAL');
    hides('عنده السكري وسرطان الدم', ['السكري', 'سرطان'], 'MEDICAL');
  });
  it('gives one placeholder to one term, however often it is written', () => {
    const r = redact('Her diabetes runs in the family. His diabetes is under control.');
    assert.equal(r.counts.MEDICAL, 1);
    assert.equal((r.text.match(/\[MEDICAL_1\]/g) ?? []).length, 2);
  });
  it('does not hide ordinary words that only contain a term', () => {
    const r = redact('Teaching aids, a hearing aid and an insulated cup. Sunday stroke of luck. Cancel the booking.');
    assert.equal(r.counts.MEDICAL, undefined, r.text);
  });
});

describe('the older kinds still work beside the new ones', () => {
  it('hides an email, a phone and an address together and restores all of it', () => {
    const t = 'Mail sami@example.com, call 0551234567, address: 14 Palm Road Jeddah, born 12/03/1985, has asthma.';
    const r = redact(t);
    for (const s of ['sami@example.com', '0551234567', 'Palm Road', '12/03/1985', 'asthma']) assert.ok(!r.text.includes(s), s);
    assert.equal(rehydrate(r.text, r.map), t);
  });
});
