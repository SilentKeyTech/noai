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
const B64 = 'MIIEowIBAAKCAQEAu1SU1LfVLPHCozMxH2Mo4lgOEePzNm0tRgeLezV6ffAt0gun';
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
  it('hides an IBAN with letters in the bank code in any case, grouped or not, and only the IBAN', () => {
    for (const v of ['Gb82west12345698765432', 'GB82west12345698765432', 'gb82 west 1234 5698 7654 32', 'Gb82 West 1234 5698 7654 32', 'gb82west12345698765432']) {
      const r = redact(`iban ${v} please`);
      assert.equal(r.text, 'iban [IBAN_1] please', v);
    }
    assert.equal(redact('iban sa0380000000608010167519 please').text, 'iban [IBAN_1] please');
    assert.equal(redact('gb82west12345698765433 is wrong').counts.IBAN, undefined, 'a lower case IBAN that fails its check is not one');
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
  it('hides a JWT with no signature, and a JWE with five parts', () => {
    const none = `${JWT.split('.').slice(0, 2).join('.')}.`;
    assert.equal(hides(`token ${none} end`, [none.slice(0, 20)], 'SECRET').text, 'token [SECRET_1] end');
    const jwe = 'eyJhbGciOiJSU0EtT0FFUCIsImVuYyI6IkEyNTZHQ00ifQ.OKOawDo13gRp2ojaHV7LFpZcgV7T6DVZKTyKOMTYUmKoTCVJRgckCL9kiMT03JGeipsEdY3mx_etLbbWSrFr05kLzcSr4qKAq7YN7e9jwQRb23nfa6c9d.48V1_ALb6US04U3b.5eym8TW_c8SuK0ltJ3rpYIzOeDQz7TALvtu6UG9oMo4vpzs9tX_EFShS8iB7j6jiSdiwkIr3ajwQzaBt9D1ZGdRkNq5GI7Ki_c-MLdhbgIaR2tLEhhBubTrDfGpuPXcD_j7ChzSVJtQ_aHRdeV0hWPY39Wfxk2Jt5dCUdx2yvZGoA.XFBoMYUZodetZdvTiFvSkQ';
    assert.equal(hides(`${jwe} end`, ['OKOawDo13', 'XFBoMYUZ'], 'SECRET').text, '[SECRET_1] end');
    assert.equal(hides(`${JWT}.extraSegmentHere1234 end`, ['SflKxw', 'extraSegment'], 'SECRET').text, '[SECRET_1] end');
  });
  it('leaves dotted versions, domains and short dotted strings alone', () => {
    leaves('node v22.1.3 on example.com.au, see a.b.c and eyJabc.eyJdef.ghi and v1.2.3', 'SECRET');
  });

  it('hides a PEM private key block from BEGIN to END, over several lines', () => {
    const r = hides(`key:\n${PEM}\nend`, ['MIIEow', 'BEGIN RSA', 'END RSA'], 'SECRET');
    assert.equal(r.text, 'key:\n[SECRET_1]\nend');
    hides('-----BEGIN OPENSSH PRIVATE KEY-----\nb3BlbnNzaC1rZXktdjEAAAAABG5vbmUAAAAEbm9uZQAAAAAAAAABAAAAMwAAAAtzc2gtZW\n-----END OPENSSH PRIVATE KEY-----', ['b3BlbnNzaC'], 'SECRET');
    hides('-----BEGIN PRIVATE KEY-----\r\nMIIEvQIBADANBgkqhkiG9w0BAQEFAASCBKcwggSjAgEAAoIBAQC\r\n-----END PRIVATE KEY-----', ['MIIEvQ'], 'SECRET');
  });
  it('leaves a certificate, a public key and the words private key alone', () => {
    leaves(`-----BEGIN CERTIFICATE-----\n${B64}\n${B64.slice(0, 40)}\n-----END CERTIFICATE-----`, 'SECRET');
    leaves(`-----BEGIN PGP PUBLIC KEY BLOCK-----\n\nmQENBF${B64.slice(6)}\n=abcd\n-----END PGP PUBLIC KEY BLOCK-----`, 'SECRET');
    leaves(`-----BEGIN PUBLIC KEY-----\n${B64}\n-----END PUBLIC KEY-----`, 'SECRET');
    leaves('keep the private key in the vault', 'SECRET');
  });
  it('hides a private key whose END line is missing, and a key body with no armour at all', () => {
    const cut = `-----BEGIN RSA PRIVATE KEY-----\n${B64}\nVTLw7onLRnrq0/IzW7yWR7QkrmBL7jTKEn5u+qKhbwKfBstIs+bMY2Zkp18gnTxK\n`;
    assert.equal(hides(`key\n${cut}`, ['MIIEow', 'VTLw7on', 'BEGIN RSA'], 'SECRET').text, 'key\n[SECRET_1]\n');
    assert.equal(hides(`${cut}end of note`, ['MIIEow'], 'SECRET').text, '[SECRET_1]\nend of note');
    assert.equal(hides(`key ${B64}${B64.slice(0, 20)} end`, ['MIIEow'], 'SECRET').text, 'key [SECRET_1] end');
    assert.equal(hides(`key\n${B64}\n${B64}\nend`, ['MIIEow'], 'SECRET').text, 'key\n[SECRET_1]\nend');
    const ssh = 'b3BlbnNzaC1rZXktdjEAAAAABG5vbmUAAAAEbm9uZQAAAAAAAAABAAAAMwAAAAtzc2gtZW';
    assert.equal(hides(`key ${ssh} end`, ['b3BlbnNzaC1rZXktdjEAAAAABG5vbmU'], 'SECRET').text, 'key [SECRET_1] end');
  });
  it('hides a PGP private key block like a PEM one', () => {
    const pgp = `-----BEGIN PGP PRIVATE KEY BLOCK-----\n\nlQOYBF${B64.slice(6)}\n=abcd\n-----END PGP PRIVATE KEY BLOCK-----`;
    assert.equal(hides(`key\n${pgp}\nend`, ['lQOYBF', 'BEGIN PGP'], 'SECRET').text, 'key\n[SECRET_1]\nend');
    assert.equal(hides(`-----BEGIN PGP PRIVATE KEY BLOCK-----\n\nlQOYBF${B64.slice(6)}\n`, ['lQOYBF'], 'SECRET').text, '[SECRET_1]\n');
  });
});

const INVISIBLE = ['​', '‌', '‍', '﻿', '­', '⁠'];

describe('names and values split by characters that have no width', () => {
  it('hides a name with a zero width character inside it, and gives the owner back the clean name', () => {
    for (const z of INVISIBLE) {
      const text = `My brother Sa${z}mi Had${z}dad called.`;
      const r = redact(text);
      assert.equal(r.text, 'My brother [PERSON_1] called.', JSON.stringify(text));
      assert.equal(r.map.get('[PERSON_1]'), 'Sami Haddad');
      assert.equal(rehydrate(r.text, r.map), 'My brother Sami Haddad called.');
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
    const k = knownPeople([{ title: 'House', body: 'My landlord Zor\u200Bvath Quell wants the rent.' }]);
    assert.deepEqual(k.people, ['Zorvath Quell']);
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
  it('leaves places and organisations written with Al or El readable, and still hides a person', () => {
    const places = 'Drive to Al Khobar, Al Ain, Al Ula, Al Hasa, Al Jubail, Al Qassim, Al Taif, Al Hofuf. Watch Al Jazeera and Al-Jazeera, read about Al-Qaeda and El-Alamein. El Paso, El Salvador, El Niño and El Camino Real. الخبر والعلا والأحساء والطائف.';
    assert.deepEqual(redact(places).counts, {}, redact(places).text);
    assert.equal(redact('Al Rashid called.').text, '[PERSON_1] called.');
    assert.equal(redact('Ask Mr. Al Rashid and Al Gore.').text, 'Ask Mr. [PERSON_1] and [PERSON_2].');
    assert.equal(redact('أحمد الرياض اتصل').text, '[PERSON_1] الرياض اتصل', 'a city after a given name is not a family name');
  });
  it('LIMIT: a bare Arabic ال- family name is an ordinary word until the vault knows the person', () => {
    assert.deepEqual(redact('الرشيد اتصل').counts, {});
    const r = redact('الرشيد اتصل', { people: ['أحمد الرشيد'] });
    assert.equal(r.text, '[PERSON_1] اتصل');
  });
});

describe('found in review: what the invisible characters still let through', () => {
  it('hides a name that a zero width space has glued to the next word, which the first reading cannot see', () => {
    for (const text of ['Sami\u200BHaddad called', 'Sami\u200Bsaid hi', 'My brother Sami\u200BHaddad called']) {
      const r = redact(text);
      assert.ok(!r.text.includes('Sami') && !r.text.includes('Haddad'), `${JSON.stringify(text)} -> ${JSON.stringify(r.text)}`);
    }
  });
  it('hides two values a zero width space has glued together, both of them', () => {
    const r = redact('a@b.com\u200Bc@d.com');
    assert.ok(!r.text.includes('a@b') && !r.text.includes('c@d') && !r.text.includes('@d.com'), r.text);
    const ids = redact('ID 1012345678\u200B0551234567');
    assert.ok(!ids.text.includes('1012345678') && !ids.text.includes('0551234567'), ids.text);
    const card = redact('card 4111111111111111\u200B1');
    assert.ok(!card.text.includes('4111'), card.text);
  });
  it('hides a value with a bidi or format control inside it, as Arabic text often carries', () => {
    assert.equal(redact('055\u200E1234567').text, '[PHONE_1]', 'left to right mark');
    assert.equal(redact('\u200F0551234567\u200F').text, '\u200F[PHONE_1]\u200F', 'right to left marks around');
    assert.equal(redact('call \u202A+966 55 123 4567\u202C now').text, 'call \u202A[PHONE_1]\u202C now', 'embedding and pop');
    assert.equal(redact('call \u2066+966551234567\u2069 now').text, 'call \u2066[PHONE_1]\u2069 now', 'isolate');
    assert.equal(redact('Sa\u202Emi Haddad called').text, '[PERSON_1] called', 'right to left override');
    assert.equal(redact('أخي سا\u061Cمي اتصل').text, 'أخي [PERSON_1] اتصل', 'Arabic letter mark');
    assert.equal(redact('أخي سا\u200Cمي اتصل').text, 'أخي [PERSON_1] اتصل', 'zero width non-joiner');
    assert.equal(redact('Sami\uFE0F Haddad called').text, '[PERSON_1] called', 'variation selector');
    assert.equal(redact('Sa\u034Fmi Haddad called').text, '[PERSON_1] called', 'combining grapheme joiner');
    assert.equal(redact('call \u180E0551234567 now').text, 'call \u180E[PHONE_1] now', 'Mongolian vowel separator');
  });
  it('keeps an invisible character at the very start of a text, and leaves one right after a value out of the value', () => {
    const bom = redact('\uFEFFhello world');
    assert.equal(bom.text, '\uFEFFhello world');
    assert.equal(rehydrate(bom.text, bom.map), '\uFEFFhello world');
    const r = redact('call \u200B0551234567\u200B now');
    assert.equal(r.text, 'call \u200B[PHONE_1]\u200B now');
    assert.equal(r.map.get('[PHONE_1]'), '0551234567');
    assert.equal(rehydrate(r.text, r.map), 'call \u200B0551234567\u200B now');
    const name = redact('\uFEFFSami called');
    assert.equal(name.text, '\uFEFF[PERSON_1] called');
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
