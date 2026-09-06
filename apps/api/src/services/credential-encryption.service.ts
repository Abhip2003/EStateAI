import crypto from 'node:crypto';
import { config } from '../config/env.js';

const ALGORITHM = 'aes-256-gcm';
const IV_LENGTH = 12; // 96-bit nonce, recommended size for GCM
const AUTH_TAG_LENGTH = 16;

class CredentialEncryptionService {
  private readonly key: Buffer;

  constructor() {
    this.key = Buffer.from(config.security.credentialEncryptionKey, 'hex');
  }

  encrypt(plainText: string): string {
    const iv = crypto.randomBytes(IV_LENGTH);
    const cipher = crypto.createCipheriv(ALGORITHM, this.key, iv);
    const ciphertext = Buffer.concat([cipher.update(plainText, 'utf8'), cipher.final()]);
    const authTag = cipher.getAuthTag();

    // iv + authTag + ciphertext concatenated, then base64-encoded as one
    // opaque string — this is exactly what gets stored in
    // Account.credentialCiphertext.
    return Buffer.concat([iv, authTag, ciphertext]).toString('base64');
  }

  decrypt(encoded: string): string {
    const raw = Buffer.from(encoded, 'base64');
    const iv = raw.subarray(0, IV_LENGTH);
    const authTag = raw.subarray(IV_LENGTH, IV_LENGTH + AUTH_TAG_LENGTH);
    const ciphertext = raw.subarray(IV_LENGTH + AUTH_TAG_LENGTH);

    const decipher = crypto.createDecipheriv(ALGORITHM, this.key, iv);
    decipher.setAuthTag(authTag);
    // GCM verifies the auth tag here — decipher.final() throws if the
    // ciphertext (or tag) was tampered with, so no separate integrity
    // check is needed.
    const plainText = Buffer.concat([decipher.update(ciphertext), decipher.final()]);
    return plainText.toString('utf8');
  }
}

export const credentialEncryptionService = new CredentialEncryptionService();
