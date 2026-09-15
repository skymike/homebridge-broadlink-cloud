import { createCipheriv, createHash } from 'node:crypto';

export interface EncodedEmailLogin {
  headers: { timestamp: string; token: string };
  body: Buffer;
}

/** Encode an email-only BroadLink SDK login request; performs no network access. */
export function encodeEmailLogin(email: string, password: string, timestampSeconds: number): EncodedEmailLogin {
  if (typeof email !== 'string' || !email.trim() || /[\x00-\x1f\x7f]/.test(email)) throw new Error('Invalid email');
  if (typeof password !== 'string' || password.length === 0) throw new Error('Invalid password');
  if (!Number.isSafeInteger(timestampSeconds) || timestampSeconds < 0) throw new Error('Invalid timestamp');

  // Property order and protocol constants match Android BroadLink SDK 2.18.10.
  const json = JSON.stringify({
    email,
    password: createHash('sha1').update(password + '4969fj#k23#', 'utf8').digest('hex'),
    companyid: 'b0491bc574dfa144908c3cd671f56370',
    lid: '5eda600025ae5057181daaa2124f79b7',
  });
  const timestamp = String(timestampSeconds);
  const token = createHash('md5').update(json + 'xgx3d*fe3478$ukx', 'utf8').digest('hex');
  const key = createHash('md5').update(timestamp + 'kdixkdqp54545^#*', 'utf8').digest();
  const clear = Buffer.from(json, 'utf8');
  // SDK manually rounds up, then BouncyCastle ZeroBytePadding adds a full block.
  // Preserve both stages, including the extra block when already aligned.
  const padded = Buffer.alloc(Math.ceil(clear.length / 16) * 16 + 16);
  clear.copy(padded);
  const cipher = createCipheriv('aes-128-cbc', key, Buffer.from('eaaaaa3abb5862a21918b5771d1615aa', 'hex'));
  cipher.setAutoPadding(false);
  return { headers: { timestamp, token }, body: Buffer.concat([cipher.update(padded), cipher.final()]) };
}
