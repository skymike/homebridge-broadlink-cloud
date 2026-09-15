import assert from 'node:assert/strict';
import { createDecipheriv, createHash } from 'node:crypto';
import { test } from 'node:test';
import { encodeEmailLogin as encode } from '../src/auth.ts';


// Synthetic credentials; generated offline with the real Android SDK 2.18.10.
const email = 'fixture@example.invalid';
const password = 'fixture-password';
const timestamp = 1700000000;
const sdkCiphertext = 'db73e27f9e3914a549a9bf32118341bf1109200daf1b66e8309d91d2ab7602e7cf6acc23a4e831fa9b9ab6f69f93b49c26e3cc4ec51bad18d2ea003296adae7ce7964ce6539749b9df4ff6ab2e41722092d1a3765ac1ebc4aa56c50ada7b58e4cb056f65c09fe96991c6869f33cc3e8708aa36f2762f5f7b31f8e5780ab3332729cd41ee971404963894b8bb2579d9f06d49ed173a8c22994957eb8c0f213cbcf19881a083ba63d115784c0fcf9e35897785a0918a6be1c6e503388e1bfa7a7a9b31e32121bd26f551e82f7652b1f8ad';

function decrypt(body: Buffer, seconds = timestamp): Buffer {
  const key = createHash('md5').update(String(seconds) + 'kdixkdqp54545^#*').digest();
  const decipher = createDecipheriv('aes-128-cbc', key, Buffer.from('eaaaaa3abb5862a21918b5771d1615aa', 'hex'));
  decipher.setAutoPadding(false);
  return Buffer.concat([decipher.update(body), decipher.final()]);
}

test('email login matches the literal Android SDK token and encrypted body', () => {
  const result = encode(email, password, timestamp);
  assert.deepEqual(result.headers, { timestamp: '1700000000', token: '80958b1bf67eba3b483e1b87b1487c02' });
  assert.ok(Buffer.isBuffer(result.body));
  assert.equal(result.body.toString('hex'), sdkCiphertext);
});

test('aligned plaintext receives the SDK extra zero block and preserves field order', () => {
  // This email makes the UTF-8 JSON exactly 192 bytes (12 AES blocks).
  const result = encode('fixture123456789012345@example.invalid', password, timestamp);
  assert.equal(result.headers.token, '702c5a97183b2cd7d257a0e7863673bc');
  assert.equal(result.body.toString('hex'), 'db73e27f9e3914a549a9bf32118341bf0c27eb6aae0137858df57e7dd541163c2800b9f0c72db30187902ad91ce2d9a8d409d5d947d18071d6a439cd9882dac1a7c3db30995917d5860a2a5e07d248a7a072a388d60691223d43890ffa40f800ee9d2b4e05f4cd80be4d60e24e519e2898813a9f2dc9b44cc4c8c510cf38b96adcc5b407ed33462b87fba3fef683823539388cd11056ae78ad711fcf1e62dbbf79d8701d75e4830d67efed2937e640cd5c3afdbce1491bbfbfd6063866771a8ca784f49d55bc6cc307ede8d10c879893');
  assert.equal(result.body.length, 208);
  const clear = decrypt(result.body);
  assert.equal(clear.subarray(0, 192).toString('utf8'), '{"email":"fixture123456789012345@example.invalid","password":"dff15eea13643928c23d76e7733f4db34e9ecc99","companyid":"b0491bc574dfa144908c3cd671f56370","lid":"5eda600025ae5057181daaa2124f79b7"}');
  assert.deepEqual(clear.subarray(192), Buffer.alloc(16));
});

test('unaligned UTF-8 plaintext uses only zero bytes for padding', () => {
  const clear = decrypt(encode('é@example.invalid', password, timestamp).body);
  const end = clear.indexOf(0);
  assert.ok(end > 0);
  assert.ok(clear.subarray(end).every(byte => byte === 0));
  assert.equal(clear.length, Math.ceil(end / 16) * 16 + 16);
  assert.equal(JSON.parse(clear.subarray(0, end).toString('utf8')).email, 'é@example.invalid');
});

test('password whitespace is preserved and timestamp changes encryption', () => {
  assert.notDeepEqual(encode(email, ` ${password} `, timestamp).body, encode(email, password, timestamp).body);
  const first = encode(email, password, 0);
  const second = encode(email, password, 1);
  assert.equal(first.headers.timestamp, '0');
  assert.equal(first.headers.token, second.headers.token);
  assert.notDeepEqual(first.body, second.body);
  assert.deepEqual(decrypt(first.body, 0), decrypt(second.body, 1));
  assert.doesNotThrow(() => encode(email, ' ', Number.MAX_SAFE_INTEGER));
});

test('invalid credentials and timestamps are rejected without echoing inputs', () => {
  for (const invalidEmail of ['', '  ', 'fixture\r\n@example.invalid', 'fixture\0@example.invalid', 'fixture\t@example.invalid', 'fixture\x7f@example.invalid']) {
    assert.throws(() => encode(invalidEmail, password, timestamp), /^Error: Invalid email$/);
  }
  assert.throws(() => encode(email, '', timestamp), /^Error: Invalid password$/);
  for (const invalidTimestamp of [-1, 1.5, NaN, Infinity, Number.MAX_SAFE_INTEGER + 1]) {
    assert.throws(() => encode(email, password, invalidTimestamp), /^Error: Invalid timestamp$/);
  }
});
