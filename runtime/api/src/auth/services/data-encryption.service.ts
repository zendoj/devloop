import { Injectable, OnModuleInit } from '@nestjs/common';
import { createCipheriv, createDecipheriv, randomBytes } from 'node:crypto';
import { SecretsService } from '../../config/secrets.service';

/**
 * DataEncryptionService — AES-256-GCM encryption for at-rest PII in the
 * database. Currently used only by users.two_factor_secret per
 * ARCHITECTURE §4.3 (the single documented exception to "no DB-level
 * secret encryption").
 *
 * Storage format (v1):
 *   single base64-encoded blob:
 *     byte 0      : version byte (0x01)
 *     bytes 1-12  : 12-byte GCM nonce
 *     bytes 13..N : ciphertext
 *     bytes N..   : 16-byte GCM auth tag
 *
 * The version byte lets us rotate the format or algorithm later
 * without tripping old rows. Decryption refuses unknown versions.
 *
 * The key is loaded via SecretsService.getSecret('data_encryption_key')
 * which must resolve to exactly 32 bytes (AES-256).
 */
@Injectable()
export class DataEncryptionService implements OnModuleInit {
  private readonly VERSION_BYTE = 0x01;
  private readonly NONCE_LENGTH = 12;
  private readonly TAG_LENGTH = 16;
  private readonly ALGORITHM = 'aes-256-gcm' as const;

  private key!: Buffer;

  constructor(private readonly secrets: SecretsService) {}

  public onModuleInit(): void {
    const raw = this.secrets.getSecret('data_encryption_key');
    if (raw.length !== 32) {
      throw new Error(
        `DataEncryptionService: data_encryption_key must be 32 bytes (got ${raw.length})`,
      );
    }
    this.key = raw;
  }

  public encrypt(plaintext: string): string {
    if (typeof plaintext !== 'string') {
      throw new Error('DataEncryptionService.encrypt: plaintext must be a string');
    }
    const nonce = randomBytes(this.NONCE_LENGTH);
    const cipher = createCipheriv(this.ALGORITHM, this.key, nonce);
    const ciphertext = Buffer.concat([
      cipher.update(plaintext, 'utf8'),
      cipher.final(),
    ]);
    const tag = cipher.getAuthTag();
    if (tag.length !== this.TAG_LENGTH) {
      // Node documents GCM tags as 16 bytes by default; this is a sanity check.
      throw new Error('DataEncryptionService.encrypt: unexpected GCM tag length');
    }
    const blob = Buffer.concat([
      Buffer.from([this.VERSION_BYTE]),
      nonce,
      ciphertext,
      tag,
    ]);
    return blob.toString('base64');
  }

  public decrypt(encoded: string): string {
    if (typeof encoded !== 'string' || encoded.length === 0) {
      throw new Error('DataEncryptionService.decrypt: encoded value must be a non-empty string');
    }
    const blob = Buffer.from(encoded, 'base64');
    if (blob.length < 1 + this.NONCE_LENGTH + this.TAG_LENGTH) {
      throw new Error('DataEncryptionService.decrypt: blob too short');
    }
    const version = blob.readUInt8(0);
    if (version !== this.VERSION_BYTE) {
      throw new Error(
        `DataEncryptionService.decrypt: unknown version byte 0x${version.toString(16).padStart(2, '0')}`,
      );
    }
    const nonce = blob.subarray(1, 1 + this.NONCE_LENGTH);
    const tag = blob.subarray(blob.length - this.TAG_LENGTH);
    const ciphertext = blob.subarray(
      1 + this.NONCE_LENGTH,
      blob.length - this.TAG_LENGTH,
    );

    const decipher = createDecipheriv(this.ALGORITHM, this.key, nonce);
    decipher.setAuthTag(tag);
    const plaintext = Buffer.concat([
      decipher.update(ciphertext),
      decipher.final(),
    ]);
    return plaintext.toString('utf8');
  }
}
