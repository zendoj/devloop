import { Injectable } from '@nestjs/common';
import * as argon2 from 'argon2';

/**
 * PasswordService — Argon2id wrapper with the parameters mandated by
 * ARCHITECTURE.md §5.1:
 *
 *   memoryCost: 65536   (64 MiB)
 *   timeCost:   3       (iterations)
 *   parallelism: 4      (lanes)
 *   algorithm:  Argon2id
 *
 * These values are fixed on purpose. Changing them is a security event,
 * not a tuning knob — document in SECURITY.md and bump a migration if
 * ever adjusted.
 *
 * Verification uses the encoded hash stored in users.password_hash so
 * legacy hashes with different parameters still verify, but new hashes
 * always use the current params.
 */
@Injectable()
export class PasswordService {
  private readonly HASH_OPTIONS: argon2.Options = {
    type: argon2.argon2id,
    memoryCost: 65_536,
    timeCost: 3,
    parallelism: 4,
  };

  public async hash(plaintext: string): Promise<string> {
    if (typeof plaintext !== 'string' || plaintext.length === 0) {
      throw new Error('PasswordService.hash: plaintext must be a non-empty string');
    }
    return argon2.hash(plaintext, this.HASH_OPTIONS);
  }

  public async verify(encodedHash: string, plaintext: string): Promise<boolean> {
    if (
      typeof encodedHash !== 'string' ||
      encodedHash.length === 0 ||
      typeof plaintext !== 'string' ||
      plaintext.length === 0
    ) {
      return false;
    }
    try {
      return await argon2.verify(encodedHash, plaintext);
    } catch {
      // A malformed hash string throws; treat that as "no match" rather
      // than a server error. Logging is the caller's responsibility.
      return false;
    }
  }

  /**
   * Returns true if the encoded hash uses weaker parameters than the
   * current policy and should be re-hashed on successful verification.
   * Callers invoke this after a successful verify() and, if true,
   * re-hash the plaintext and UPDATE users.password_hash.
   */
  public needsRehash(encodedHash: string): boolean {
    return argon2.needsRehash(encodedHash, this.HASH_OPTIONS);
  }
}
