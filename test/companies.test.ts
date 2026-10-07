/**
 * Company names hidden on device. A contract names each party in full once
 * and then by a short name, so both must go, under one placeholder. Defined
 * terms ("the Company", "the Contractor") stay readable.
 */
import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { redact, redactAll, rehydrate } from '../src/redact.ts';

const CLAUSE =
  'List the risks for the subcontractor in clause 14.2. The Subcontractor, Sandpiper Fitout Co., represented by Mr. Omar Al-Qahtani (ID 1087654321, phone +966 50 987 6543), shall give notice of any claim within 7 days of the event, failing which the claim is waived. Payment to IBAN SA03 8000 0000 6080 1016 7519. The Contractor, Harbourline Contracting LLC, may deduct delay damages of SAR 25,000 per day.';

describe('companies', () => {
  it('hides both parties in the demo contract clause, and everything else it hid before', () => {
    const r = redact(CLAUSE);
    for (const s of ['Sandpiper', 'Harbourline', 'Omar', 'Qahtani', '1087654321', '987 6543', '8000 0000']) {
      assert.ok(!r.text.includes(s), `"${s}" was not hidden: ${r.text}`);
    }
    assert.equal(r.counts.COMPANY, 2);
    assert.ok(r.text.includes('The Subcontractor, [COMPANY_1]'), r.text);
    assert.ok(r.text.includes('The Contractor, [COMPANY_2]'), r.text);
    assert.ok(r.text.includes('SAR 25,000') && r.text.includes('7 days') && r.text.includes('clause 14.2'), 'terms the question is about stay readable');
    assert.equal(rehydrate(r.text, r.map), CLAUSE);
  });

  it('hides later short mentions under the same placeholder', () => {
    const r = redact('Harbourline Contracting LLC appoints Sandpiper Fitout Co. Sandpiper shall report to Harbourline weekly.');
    assert.ok(!/Sandpiper|Harbourline/.test(r.text), r.text);
    assert.equal(r.counts.COMPANY, 2);
    assert.equal(r.text, '[COMPANY_1] appoints [COMPANY_2] [COMPANY_2] shall report to [COMPANY_1] weekly.');
  });

  it('numbers a company the same way across the question and the passages', () => {
    const r = redactAll(['Is Sandpiper in breach?', 'Sandpiper Fitout Co. missed the 7 day notice.']);
    assert.equal(r.texts[0], 'Is [COMPANY_1] in breach?');
    assert.equal(r.texts[1], '[COMPANY_1] missed the 7 day notice.');
  });

  it('knows the common legal forms', () => {
    for (const name of ['Nimbus Labs Ltd', 'Qarar Analytics Inc.', 'Falcon Steel Corporation', 'Zamil Holding Group', 'Rawabi Est.', 'Tamkeen GmbH', 'Najd Logistics L.L.C.']) {
      const r = redact(`Invoice from ${name} is overdue.`);
      assert.equal(r.counts.COMPANY, 1, `${name}: ${r.text}`);
      assert.equal(r.text, 'Invoice from [COMPANY_1] is overdue.', name);
    }
  });

  it('leaves defined terms and generic words readable', () => {
    for (const text of ['The Company shall pay the Contractor within 30 days.', 'Each Party may terminate. The Group policy applies.']) {
      const r = redact(text);
      assert.equal(r.counts.COMPANY ?? 0, 0, r.text);
      assert.equal(r.text, text);
    }
  });

  it('does not hide a common first word on its own', () => {
    const r = redact('Gulf Marine Services LLC signed. The Gulf is calm today.');
    assert.ok(r.text.startsWith('[COMPANY_1] signed.'), r.text);
    assert.ok(r.text.includes('The Gulf is calm today.'), r.text);
  });

  it('does not take a person in front of the company', () => {
    const r = redact('Signed by Omar Al-Qahtani for Sandpiper Fitout Co. today.');
    assert.ok(r.text.includes('for [COMPANY_1] today.'), r.text);
    assert.equal(r.counts.COMPANY, 1);
  });

  it('hides an Arabic company after شركة or مؤسسة', () => {
    const text = 'تلتزم شركة الرمال للمقاولات بالدفع إلى مؤسسة النخبة للتجارة خلال 30 يوما. وتتحمل الرمال الغرامات.';
    const r = redact(text);
    for (const s of ['الرمال', 'النخبة']) assert.ok(!r.text.includes(s), `"${s}" was not hidden: ${r.text}`);
    assert.equal(r.counts.COMPANY, 2);
    assert.ok(r.text.includes('خلال 30 يوما'), r.text);
    assert.equal(rehydrate(r.text, r.map).startsWith('تلتزم شركة الرمال للمقاولات'), true);
  });
});
