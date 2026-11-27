import crypto from 'node:crypto';

const EPHEMERAL_SESSION_KEY = crypto.randomBytes(32);
const EPHEMERAL_DATA_KEY = crypto.randomBytes(32);

function getSessionKey(): Buffer {
  const envKey = process.env.SESSION_SECRET?.trim();
  if (envKey && envKey.length >= 16) {
    return crypto.createHash('sha256').update(envKey).digest();
  }
  return EPHEMERAL_SESSION_KEY;
}

function getDataKey(): Buffer {
  const envKey = process.env.DATA_ENCRYPTION_KEY?.trim() || process.env.SESSION_SECRET?.trim();
  if (envKey && envKey.length >= 16) {
    return crypto.createHash('sha256').update(envKey).digest();
  }
  return EPHEMERAL_DATA_KEY;
}

export function hashPassword(password: string): string {
  const salt = crypto.randomBytes(16).toString('hex');
  const derived = crypto.scryptSync(password, salt, 64).toString('hex');
  return `scrypt$${salt}$${derived}`;
}

export function verifyPassword(password: string, stored: string): boolean {
  const parts = stored.split('$');
  if (parts.length !== 3 || parts[0] !== 'scrypt') {
    return false;
  }
  const [, salt, hashHex] = parts;
  const expected = Buffer.from(hashHex, 'hex');
  const actual = crypto.scryptSync(password, salt, 64);
  if (expected.length !== actual.length) {
    return false;
  }
  return crypto.timingSafeEqual(expected, actual);
}

export function verifyPlainPasscode(input: string, envPasscode: string): boolean {
  const a = crypto.createHash('sha256').update(input).digest();
  const b = crypto.createHash('sha256').update(envPasscode).digest();
  return crypto.timingSafeEqual(a, b);
}

export interface SessionPayload {
  userId?: string;
  username?: string;
  role: string;
  exp: number;
}

export function signSessionToken(payload: SessionPayload): string {
  const body = Buffer.from(JSON.stringify(payload), 'utf8').toString('base64url');
  const sig = crypto.createHmac('sha256', getSessionKey()).update(body).digest('base64url');
  return `${body}.${sig}`;
}

export function verifySessionToken(token: string): SessionPayload | null {
  const parts = token.split('.');
  if (parts.length !== 2) {
    return null;
  }
  const [body, sig] = parts;
  const expectedSig = crypto.createHmac('sha256', getSessionKey()).update(body).digest('base64url');
  const a = Buffer.from(sig);
  const b = Buffer.from(expectedSig);
  if (a.length !== b.length || !crypto.timingSafeEqual(a, b)) {
    return null;
  }
  try {
    const parsed = JSON.parse(Buffer.from(body, 'base64url').toString('utf8')) as SessionPayload;
    if (!parsed || typeof parsed.exp !== 'number' || Date.now() > parsed.exp) {
      return null;
    }
    return parsed;
  } catch {
    return null;
  }
}

export function encryptSecret(plaintext: string): string {
  if (!plaintext) {
    return '';
  }
  const iv = crypto.randomBytes(12);
  const cipher = crypto.createCipheriv('aes-256-gcm', getDataKey(), iv);
  const encrypted = Buffer.concat([cipher.update(plaintext, 'utf8'), cipher.final()]);
  const tag = cipher.getAuthTag();
  return `enc1$${iv.toString('hex')}$${tag.toString('hex')}$${encrypted.toString('hex')}`;
}

export function decryptSecret(stored: string | null | undefined): string {
  if (!stored) {
    return '';
  }
  if (!stored.startsWith('enc1$')) {
    return '';
  }
  const parts = stored.split('$');
  if (parts.length !== 4) {
    return '';
  }
  try {
    const [, ivHex, tagHex, dataHex] = parts;
    const decipher = crypto.createDecipheriv(
      'aes-256-gcm',
      getDataKey(),
      Buffer.from(ivHex, 'hex'),
    );
    decipher.setAuthTag(Buffer.from(tagHex, 'hex'));
    const decrypted = Buffer.concat([
      decipher.update(Buffer.from(dataHex, 'hex')),
      decipher.final(),
    ]);
    return decrypted.toString('utf8');
  } catch {
    return '';
  }
}

export function maskSecret(plaintext: string): string {
  if (!plaintext) {
    return '';
  }
  if (plaintext.length <= 6) {
    return '••••••';
  }
  return `${plaintext.slice(0, 4)}••••${plaintext.slice(-4)}`;
}

export function verifyGitHubSignature(
  rawBody: Buffer,
  signatureHeader: string | undefined,
  secret: string,
): boolean {
  if (!signatureHeader || !secret) {
    return false;
  }
  if (!signatureHeader.startsWith('sha256=')) {
    return false;
  }
  const expected =
    'sha256=' + crypto.createHmac('sha256', secret).update(rawBody).digest('hex');
  const a = Buffer.from(signatureHeader, 'utf8');
  const b = Buffer.from(expected, 'utf8');
  if (a.length !== b.length) {
    return false;
  }
  return crypto.timingSafeEqual(a, b);
}

export function generateRandomHex(bytes = 24): string {
  return crypto.randomBytes(bytes).toString('hex');
}

export interface EncryptedBackupEnvelope {
  encrypted: true;
  format: 'sokkan-backup-enc-v1';
  schemaVersion: 2;
  exportedAt: string;
  kdf: 'scrypt';
  cipher: 'aes-256-gcm';
  salt: string;
  iv: string;
  tag: string;
  ciphertext: string;
}

export function isEncryptedBackupEnvelope(value: unknown): value is EncryptedBackupEnvelope {
  if (!value || typeof value !== 'object') return false;
  const v = value as Record<string, unknown>;
  return (
    v.encrypted === true &&
    v.format === 'sokkan-backup-enc-v1' &&
    typeof v.salt === 'string' &&
    typeof v.iv === 'string' &&
    typeof v.tag === 'string' &&
    typeof v.ciphertext === 'string'
  );
}

export function encryptBackupPayload(
  payload: Record<string, unknown>,
  passphrase: string,
): EncryptedBackupEnvelope {
  const cleanPass = passphrase.trim();
  if (cleanPass.length < 6) {
    throw new Error('رمز رمزنگاری فایل پشتیبان باید حداقل ۶ کاراکتر باشد.');
  }
  const salt = crypto.randomBytes(16);
  const iv = crypto.randomBytes(12);
  const key = crypto.scryptSync(cleanPass, salt, 32, { N: 16384, r: 8, p: 1 });
  const cipher = crypto.createCipheriv('aes-256-gcm', key, iv);
  const plaintext = JSON.stringify(payload);
  const encrypted = Buffer.concat([cipher.update(plaintext, 'utf8'), cipher.final()]);
  const tag = cipher.getAuthTag();
  return {
    encrypted: true,
    format: 'sokkan-backup-enc-v1',
    schemaVersion: 2,
    exportedAt: String(payload.exportedAt || new Date().toISOString()),
    kdf: 'scrypt',
    cipher: 'aes-256-gcm',
    salt: salt.toString('hex'),
    iv: iv.toString('hex'),
    tag: tag.toString('hex'),
    ciphertext: encrypted.toString('base64'),
  };
}

export function decryptBackupPayload(
  envelope: EncryptedBackupEnvelope,
  passphrase: string,
): Record<string, unknown> {
  const cleanPass = passphrase.trim();
  if (!cleanPass) {
    throw new Error('این فایل پشتیبان رمزنگاری شده است. لطفاً رمز بازگشایی بکاپ را وارد کنید.');
  }
  try {
    const salt = Buffer.from(envelope.salt, 'hex');
    const iv = Buffer.from(envelope.iv, 'hex');
    const tag = Buffer.from(envelope.tag, 'hex');
    const ciphertext = Buffer.from(envelope.ciphertext, 'base64');
    const key = crypto.scryptSync(cleanPass, salt, 32, { N: 16384, r: 8, p: 1 });
    const decipher = crypto.createDecipheriv('aes-256-gcm', key, iv);
    decipher.setAuthTag(tag);
    const decrypted = Buffer.concat([decipher.update(ciphertext), decipher.final()]).toString('utf8');
    const parsed = JSON.parse(decrypted) as unknown;
    if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) {
      throw new Error('ساختار داخلی فایل بکاپ نامعتبر است.');
    }
    return parsed as Record<string, unknown>;
  } catch (err) {
    if (err instanceof Error && err.message.includes('ساختار داخلی')) {
      throw err;
    }
    throw new Error('رمز بازگشایی فایل پشتیبان نادرست است یا فایل آسیب دیده است.');
  }
}

