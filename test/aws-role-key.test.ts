/**
 * The AWS role key: on an AWS server the gateway signs its own short-lived
 * Bedrock key from the server's role, so no key is ever saved.
 */
import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { type AwsCredentials, awsCredentials, awsRoleKeySource, bedrockApiKey, type MetadataFetch } from '../src/gate.ts';

const CREDS: AwsCredentials = { accessKeyId: 'ASIAEXAMPLEKEY', secretAccessKey: 'wJalrXUtnFEMI/K7MDENG/bPxRfiCYEXAMPLEKEY', sessionToken: 'session+token/==' };
const AT = new Date('2026-10-12T15:00:00.000Z');

const decode = (key: string): URL => {
  assert.ok(key.startsWith('bedrock-api-key-'), key);
  return new URL('https://' + Buffer.from(key.slice('bedrock-api-key-'.length), 'base64').toString('utf8'));
};

describe('bedrockApiKey', () => {
  it('is a presigned CallWithBearerToken request for the right region', () => {
    const url = decode(bedrockApiKey(CREDS, 'eu-north-1', AT, 3600));
    assert.equal(url.host, 'bedrock.amazonaws.com');
    assert.equal(url.pathname, '/');
    const p = url.searchParams;
    assert.equal(p.get('Action'), 'CallWithBearerToken');
    assert.equal(p.get('X-Amz-Algorithm'), 'AWS4-HMAC-SHA256');
    assert.equal(p.get('X-Amz-Credential'), 'ASIAEXAMPLEKEY/20261012/eu-north-1/bedrock/aws4_request');
    assert.equal(p.get('X-Amz-Date'), '20261012T150000Z');
    assert.equal(p.get('X-Amz-Expires'), '3600');
    assert.equal(p.get('X-Amz-SignedHeaders'), 'host');
    assert.equal(p.get('X-Amz-Security-Token'), 'session+token/==');
    assert.equal(p.get('Version'), '1');
    assert.match(p.get('X-Amz-Signature') ?? '', /^[0-9a-f]{64}$/);
  });

  it('never contains the secret key', () => {
    const key = bedrockApiKey(CREDS, 'eu-north-1', AT);
    assert.ok(!Buffer.from(key.slice(16), 'base64').toString('utf8').includes(CREDS.secretAccessKey));
  });

  it('is the same for the same inputs and changes with the secret, the time or the region', () => {
    const a = bedrockApiKey(CREDS, 'eu-north-1', AT);
    assert.equal(bedrockApiKey(CREDS, 'eu-north-1', AT), a);
    assert.notEqual(bedrockApiKey({ ...CREDS, secretAccessKey: 'other' }, 'eu-north-1', AT), a);
    assert.notEqual(bedrockApiKey(CREDS, 'eu-north-1', new Date(AT.getTime() + 1000)), a);
    assert.notEqual(bedrockApiKey(CREDS, 'us-east-1', AT), a);
  });
});

/** A stand-in for the instance metadata service. */
function fakeMetadata(expiration: string, calls: string[]): MetadataFetch {
  return async (url, init) => {
    calls.push(`${init.method} ${url}`);
    const reply = (text: string) => ({ ok: true, status: 200, text: async () => text });
    if (url.endsWith('/api/token')) {
      assert.equal(init.method, 'PUT');
      return reply('imds-token');
    }
    assert.equal(init.headers['x-aws-ec2-metadata-token'], 'imds-token');
    if (url.endsWith('/security-credentials/')) return reply('noai-gateway-role\n');
    if (url.endsWith('/security-credentials/noai-gateway-role')) {
      return reply(JSON.stringify({ AccessKeyId: 'ASIAROLE', SecretAccessKey: 'role-secret', Token: 'role-token', Expiration: expiration }));
    }
    return { ok: false, status: 404, text: async () => '' };
  };
}

describe('awsCredentials', () => {
  it('reads the role from the instance metadata service, IMDSv2 style', async () => {
    const saved = { ...process.env };
    delete process.env.AWS_ACCESS_KEY_ID;
    delete process.env.AWS_SECRET_ACCESS_KEY;
    try {
      const calls: string[] = [];
      const c = await awsCredentials(fakeMetadata('2026-10-12T21:00:00Z', calls));
      assert.equal(c.accessKeyId, 'ASIAROLE');
      assert.equal(c.sessionToken, 'role-token');
      assert.equal(c.expiration, Date.parse('2026-10-12T21:00:00Z'));
      assert.equal(calls[0], 'PUT http://169.254.169.254/latest/api/token');
    } finally {
      process.env = saved;
    }
  });

  it('says plainly when this is not an AWS server', async () => {
    const saved = { ...process.env };
    delete process.env.AWS_ACCESS_KEY_ID;
    delete process.env.AWS_SECRET_ACCESS_KEY;
    try {
      await assert.rejects(awsCredentials(async () => { throw new Error('no route'); }), /not an AWS server/);
    } finally {
      process.env = saved;
    }
  });
});

describe('awsRoleKeySource', () => {
  it('reuses a key for half an hour, then signs a new one', async () => {
    const saved = { ...process.env };
    delete process.env.AWS_ACCESS_KEY_ID;
    delete process.env.AWS_SECRET_ACCESS_KEY;
    try {
      const calls: string[] = [];
      let t = AT.getTime();
      const source = awsRoleKeySource('eu-north-1', fakeMetadata('2026-10-12T21:00:00Z', calls), () => t);
      const first = await source();
      t += 10 * 60_000;
      assert.equal(await source(), first);
      assert.equal(calls.length, 3, 'no second trip to the metadata service within the half hour');
      t += 25 * 60_000;
      assert.notEqual(await source(), first);
      assert.equal(calls.length, 6);
    } finally {
      process.env = saved;
    }
  });

  it('never signs a key that outlives its credentials', async () => {
    const saved = { ...process.env };
    delete process.env.AWS_ACCESS_KEY_ID;
    delete process.env.AWS_SECRET_ACCESS_KEY;
    try {
      const source = awsRoleKeySource('eu-north-1', fakeMetadata('2026-10-12T15:20:00Z', []), () => AT.getTime());
      const url = decode(await source());
      assert.equal(url.searchParams.get('X-Amz-Expires'), String(20 * 60 - 60));
    } finally {
      process.env = saved;
    }
  });
});
