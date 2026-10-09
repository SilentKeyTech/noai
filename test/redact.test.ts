/**
 * Regressions from the egress and redaction audit of 9 Oct 2026. Each test is
 * one claim about what leaves the device, what stays readable on purpose, and
 * what the owner gets back. No network.
 */
import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { cleanName, knownPeople } from '../src/people.ts';
import { findPeople, redact, redactAll, rehydrate } from '../src/redact.ts';

const hides = (text: string, secrets: string[], kind: string) => {
  const r = redact(text);
  for (const s of secrets) assert.ok(!r.text.includes(s), `"${s}" was not hidden: ${r.text}`);
  assert.ok((r.counts[kind] ?? 0) >= 1, `no ${kind} counted: ${r.text}`);
  assert.equal(rehydrate(r.text, r.map), text, 'the real text must come back whole');
  return r;
};
const leaves = (text: string, kind: string) => {
  const r = redact(text);
  assert.equal(r.counts[kind], undefined, `${kind} hidden in ordinary text: ${r.text}`);
  return r;
};

const PAT = `github_pat_11ABCDEFG0${'abcdefghijklmnop'.slice(0, 12)}_${'A1b2C3d4E5f6G7h8I9j0K1l2M3n4O5p6Q7r8S9t0U1v2W3x4Y5z6A7b8C9d'.slice(0, 59)}`;
const GOOGLE = 'AIzaSyD-9tSrke72PouQMnMX-a7eZSW0jkFMBxY';
const JWT = 'eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJzdWIiOiIxMjM0NTY3ODkwIiwibmFtZSI6IkpvaG4gRG9lIn0.SflKxwRJSMeKKF2QT4fwpMeJf36POk6yJV_adQssw5c';
const PEM = '-----BEGIN RSA PRIVATE KEY-----\nMIIEowIBAAKCAQEAu1SU1LfVLPHCozMxH2Mo4lgOEePzNm0tRgeLezV6ffAt0gun\nVTLw7onLRnrq0/IzW7yWR7QkrmBL7jTKEn5u+qKhbwKfBstIs+bMY2Zkp18gnTxK\n-----END RSA PRIVATE KEY-----';

describe('structured kinds the audit found missing', () => {
  it('hides an IBAN typed in lower case or mixed case', () => {
    hides('iban sa0380000000608010167519 please', ['sa0380000000608010167519'], 'IBAN');
    hides('Sa03 8000 0000 6080 1016 7519', ['6080'], 'IBAN');
    hides('lb62 0999 0000 0001 0019 0122 9114', ['9114'], 'IBAN');
  });
  it('leaves lower case letters and digits that do not check out as an IBAN alone', () => {
    leaves('build id ab12cdefghijklmnopqrst ran', 'IBAN');
    leaves('ref xy99 1234 5678 9012 3456', 'IBAN');
    leaves('commit ab12cdef0123456789abcdef0123456789abcdef', 'IBAN');
  });
  it('LIMIT: an IBAN with letters in it, typed in lower case with spaces, reads as words', () => {
    assert.equal(redact('gb82 west 1234 5698 7654 32').counts.IBAN, undefined);
    assert.equal(redact('gb82west12345698765432').counts.IBAN, 1);
  });

  it('hides a phone written with dashes that are not hyphens, or with full width digits', () => {
    hides('call 055–123–4567 now', ['055–123–4567'], 'PHONE');
    hides('call 055—123—4567 now', ['055—123—4567'], 'PHONE');
    hides('call ０５５１２３４５６７ now', ['０５５１２３４５６７'], 'PHONE');
    hides('call ＋９６６ ５５ １２３ ４５６７ now', ['１２３'], 'PHONE');
  });
  it('gives one placeholder to one number, however the dashes, spaces and digits are written', () => {
    const r = redactAll(['055-123-4567', '055–123–4567', '０５５１２３４５６７', '055 123 4567', '055 (123) 4567']);
    assert.deepEqual(r.texts, ['[PHONE_1]', '[PHONE_1]', '[PHONE_1]', '[PHONE_1]', '[PHONE_1]']);
    assert.equal(r.map.get('[PHONE_1]'), '055-123-4567');
    assert.deepEqual(redactAll(['0551234567', '+966551234567']).texts, ['[PHONE_1]', '[PHONE_2]'], 'with and without the country code are two numbers');
  });
  it('leaves a page range and a year span with a dash alone', () => {
    leaves('see pages 12–15 and the 2–3 figures', 'PHONE');
  });

  it('hides a GitHub fine grained token', () => {
    hides(`token ${PAT} end`, [PAT, PAT.slice(11, 30)], 'SECRET');
  });
  it('leaves the words github_pat and ghp alone', () => {
    leaves('a github_pat is longer than a ghp token', 'SECRET');
  });

  it('hides a Google API key whole, not just the digits in it', () => {
    const r = hides(`key ${GOOGLE} end`, [GOOGLE, 'AIzaSy', 'FMBxY'], 'SECRET');
    assert.equal(r.text, 'key [SECRET_1] end');
  });
  it('leaves AIza as a word and a short string after it alone', () => {
    leaves('AIza and AIzaShort are not keys', 'SECRET');
  });

  it('hides a JWT: three base64url parts, header and payload starting eyJ', () => {
    const r = hides(`Authorization: Bearer ${JWT}.`, [JWT, 'SflKxw'], 'SECRET');
    assert.equal(r.text, 'Authorization: Bearer [SECRET_1].');
  });
  it('leaves dotted versions, domains and short dotted strings alone', () => {
    leaves('node v22.1.3 on example.com.au, see a.b.c and eyJabc.eyJdef.ghi', 'SECRET');
  });

  it('hides a PEM private key block from BEGIN to END, over several lines', () => {
    const r = hides(`key:\n${PEM}\nend`, ['MIIEow', 'BEGIN RSA', 'END RSA'], 'SECRET');
    assert.equal(r.text, 'key:\n[SECRET_1]\nend');
    hides('-----BEGIN OPENSSH PRIVATE KEY-----\nb3BlbnNzaC1rZXktdjEAAAAABG5vbmUAAAAEbm9uZQAAAAAAAAABAAAAMwAAAAtzc2gtZW\n-----END OPENSSH PRIVATE KEY-----', ['b3BlbnNzaC'], 'SECRET');
    hides('-----BEGIN PRIVATE KEY-----\r\nMIIEvQIBADANBgkqhkiG9w0BAQEFAASCBKcwggSjAgEAAoIBAQC\r\n-----END PRIVATE KEY-----', ['MIIEvQ'], 'SECRET');
  });
  it('leaves a certificate and the words private key alone', () => {
    leaves('-----BEGIN CERTIFICATE-----\nMIIBszCCAVmgAwIBAgIUYJm\n-----END CERTIFICATE-----', 'SECRET');
    leaves('keep the private key in the vault', 'SECRET');
  });
});

const INVISIBLE = ['​', '‌', '‍', '﻿', '­', '⁠'];

describe('names and values split by characters that have no width', () => {
  it('hides a name with a zero width character inside it, and gives the owner back what they typed', () => {
    for (const z of INVISIBLE) {
      const text = `My brother Sa${z}mi Had${z}dad called.`;
      const r = redact(text);
      assert.equal(r.text, 'My brother [PERSON_1] called.', JSON.stringify(text));
      assert.equal(rehydrate(r.text, r.map), text);
    }
  });
  it('hides a known name even when the note splits it', () => {
    const r = redactAll(['Zor​vath paid.'], { people: ['Zorvath Quell'] });
    assert.equal(r.texts[0], '[PERSON_1] paid.');
    assert.equal(r.map.get('[PERSON_1]'), 'Zorvath Quell');
  });
  it('hides an email, a phone and an ID with zero width characters inside them', () => {
    for (const z of ['​', '­', '﻿']) {
      hides(`mail sami${z}@exa${z}mple.com`, ['example', `sami${z}@`], 'EMAIL');
      hides(`call 055${z}123${z}4567`, ['4567'], 'PHONE');
      hides(`ID 10${z}12345678`, ['12345678'], 'ID');
    }
  });
  it('keeps zero width characters that are not inside a hidden value, where they were', () => {
    const family = '\u{1F468}‍\u{1F469}‍\u{1F467}';
    const r = redact(`${family} call 0551234567 soft­ware`);
    assert.equal(r.text, `${family} call [PHONE_1] soft­ware`);
    assert.equal(r.map.get('[PHONE_1]'), '0551234567');
  });
  it('learns a split name from the vault as the clean name', () => {
    const k = knownPeople([{ title: 'House', body: 'My landlord Zor​vath Quell wants the rent.' }]);
    assert.deepEqual(k.people.map((p) => p.replace(/​/g, '')), ['Zorvath Quell']);
    assert.equal(cleanName('Zor​vath Qu­ell'), 'Zorvath Quell');
    const r = redactAll(['Zorvath paid.'], k);
    assert.equal(r.texts[0], '[PERSON_1] paid.');
  });
});

describe('Arabic al- family names', () => {
  it('hides a family name written Al-, Al or El with nothing before it', () => {
    assert.equal(redact('Al-Rashid called.').text, '[PERSON_1] called.');
    assert.equal(redact('Al Rashid called.').text, '[PERSON_1] called.');
    assert.equal(redact('El Masri called.').text, '[PERSON_1] called.');
    assert.equal(redact('Ask Mr. Al Rashid.').text, 'Ask Mr. [PERSON_1].');
  });
  it('hides a given name and an Al- family name as one person, in either script', () => {
    const r = redactAll(['Ahmad Al-Rashid called.', 'أحمد الرشيد اتصل.']);
    assert.deepEqual(r.texts, ['[PERSON_1] called.', '[PERSON_2] اتصل.']);
    assert.deepEqual(r.counts, { PERSON: 2 });
  });
  it('leaves Al on its own alone', () => {
    assert.deepEqual(redact('Meet Al at noon, then al fresco.').counts, {});
  });
  it('LIMIT: a bare Arabic ال- family name is an ordinary word until the vault knows the person', () => {
    assert.deepEqual(redact('الرشيد اتصل').counts, {});
    const r = redact('الرشيد اتصل', { people: ['أحمد الرشيد'] });
    assert.equal(r.text, '[PERSON_1] اتصل');
  });
});

describe('a placeholder the owner typed', () => {
  it('is never mapped to a value, and a generated placeholder never takes its name', () => {
    const text = 'Say [PHONE_1] literally. My number is 0551234567.';
    const r = redact(text);
    assert.equal(r.text, 'Say [PHONE_1] literally. My number is [PHONE_2].');
    assert.equal(r.map.has('[PHONE_1]'), false);
    assert.equal(r.map.get('[PHONE_2]'), '0551234567');
    assert.deepEqual(r.counts, { PHONE: 1 });
    assert.equal(rehydrate(r.text, r.map), text);
    assert.equal(rehydrate('Call [PHONE_1] or [PHONE_2].', r.map), 'Call [PHONE_1] or 0551234567.');
  });
  it('is respected across every text in one disclosure', () => {
    const r = redactAll(['The form says [EMAIL_2].', 'Mail a@example.com and b@example.com.']);
    assert.deepEqual(r.texts, ['The form says [EMAIL_2].', 'Mail [EMAIL_1] and [EMAIL_3].']);
    assert.deepEqual([...r.map.keys()], ['[EMAIL_1]', '[EMAIL_3]']);
  });
  it('does not stop the real values around it from being hidden', () => {
    const text = '[PHONE_1][PHONE_2] 0551234567 and 0551234568';
    const r = redact(text);
    assert.equal(r.text, '[PHONE_1][PHONE_2] [PHONE_3] and [PHONE_4]');
    assert.equal(rehydrate(r.text, r.map), text);
  });
});

describe('putting values back', () => {
  it('follows the placeholders in the reply, in any order, however often they repeat', () => {
    const r = redact('B b@example.com then A a@example.com.');
    assert.equal(r.text, 'B [EMAIL_1] then A [EMAIL_2].');
    assert.equal(rehydrate('[EMAIL_2], then [EMAIL_1], then [EMAIL_2] again', r.map), 'a@example.com, then b@example.com, then a@example.com again');
  });
  it('keeps punctuation and brackets around a placeholder', () => {
    const text = '(sami@example.com), [0551234567]; "1012345678"!';
    const r = redact(text);
    assert.equal(r.text, '([EMAIL_1]), [[PHONE_1]]; "[ID_1]"!');
    assert.equal(rehydrate(r.text, r.map), text);
  });
  it('handles a value inside a longer one, and one value that two kinds could claim', () => {
    const text = 'see https://sami@example.com/path?ip=10.0.0.1 and ID 1012345678 or call 1012345678.';
    const r = redact(text);
    assert.equal(r.text, 'see https://[EMAIL_1]/path?ip=[IP_1] and ID [ID_1] or call [ID_1].');
    assert.equal(rehydrate(r.text, r.map), text);
    const iban = redact('SA0380000000608010167519 and 0380000000608010167519');
    assert.equal(iban.text, '[IBAN_1] and [PHONE_1]');
  });
  it('leaves a placeholder it did not make, and lower case brackets, as they are', () => {
    const r = redact('Mail sami@example.com');
    assert.equal(rehydrate('[EMAIL_1] [EMAIL_2] [email_1] [P1] [EMAIL_1 ]', r.map), 'sami@example.com [EMAIL_2] [email_1] [P1] [EMAIL_1 ]');
  });
});

describe('multi word and Arabic names, in the finder and in the vault', () => {
  const NAMES = ['Mohammed bin Salman Al Saud', 'Abu Bakr Al Siddiq', 'Omar ibn Al-Khattab', 'Abdul Rahman Al-Harbi', 'Sami Karam Haddad', 'أحمد بن محمد الرشيد', 'عبد الرحمن الحربي', 'أبو بكر الصديق'];
  it('finds a two, three and four part name whole, with bin, ibn, Abu, Abdul and Al- in it', () => {
    for (const n of NAMES) assert.deepEqual(findPeople(`${n} came to the office.`), [n], n);
  });
  it('keeps such a name whole when it comes from a contact', () => {
    for (const n of NAMES) assert.equal(cleanName(n), n);
    assert.equal(cleanName('Sheikh Ahmad Al-Rashid'), 'Ahmad Al-Rashid');
    assert.equal(cleanName('الشيخ أحمد الرشيد'), 'أحمد الرشيد');
  });
  it('hides a part of a known long name under the placeholder of the whole name', () => {
    const k = knownPeople([{ title: 'Work', body: 'My boss is Sami Karam Haddad.' }, { title: 'Contact: عبد الرحمن الحربي', body: 'Name: عبد الرحمن الحربي' }]);
    assert.deepEqual(k.people, ['Sami Karam Haddad', 'عبد الرحمن الحربي']);
    const r = redactAll(['Karam signed. Haddad paid. اتصل الحربي.'], k);
    assert.equal(r.texts[0], '[PERSON_1] signed. [PERSON_1] paid. اتصل [PERSON_2].');
    assert.equal(r.map.get('[PERSON_1]'), 'Sami Karam Haddad');
  });
  it('numbers one person once across question and passages, by any part of the name', () => {
    const r = redactAll(['Did Salman reply?', 'Mohammed bin Salman Al Saud wrote back. Al Saud said yes.']);
    assert.deepEqual(r.texts, ['Did [PERSON_1] reply?', '[PERSON_1] wrote back. [PERSON_1] said yes.']);
  });
});
