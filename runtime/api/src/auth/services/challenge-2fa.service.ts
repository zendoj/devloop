import { Injectable, OnModuleInit } from '@nestjs/common';
import { createHmac, hkdfSync, timingSafeEqual } from 'node:crypto';
import { SecretsService } from '../../config/secrets.service';

/**
 * Challenge2faService — signs and verifies short-lived 2FA challenge
 * tokens for the "password verified, awaiting TOTP" state between
 * POST /auth/login and POST /auth/2fa/verify.
 *
 * Token format:
 *   base64url(payload_json) + '.' + base64url(hmac_sha256(payload_json, jwt_secret))
 *
 * payload_json shape:
 *   { "uid": "<user_uuid>", "iat": <unix_seconds>, "exp": <unix_seconds> }
 *
 * Exp is 5 minutes after iat. Caller gets the token in the login
 * response body, posts it back with the TOTP code; we verify it was
 * signed with our key and has not expired. On success we consume
 * the token (issue a full session). Reuse of an expired token is
 * naturally rejected by the exp check; reuse of an unexpired token
 * is not tracked server-side because the full session cookie that
 * gets issued on /2fa/verify is the authoritative state carrier
 * after that point.
 *
 * We use HMAC-SHA256 instead of a full JWT library because the token
 * shape is fixed, we do not need alg negotiation, and we want the
 * verification path to be trivially auditable.
 */
@Injectable()
export class Challenge2faService implements OnModuleInit {
  private readonly TTL_SECONDS = 5 * 60;

  private key!: Buffer;

  constructor(private readonly secrets: SecretsService) {}

  public onModuleInit(): void {
    // Derive a 2fa-challenge-specific subkey from jwt_secret via HKDF
    // so the challenge HMAC and any future JWT signing path never
    // share the exact same key material. The 'info' label binds the
    // derived key to this purpose; SHA-256 is the default HKDF hash.
    const baseKey = this.secrets.getSecret('jwt_secret');
    if (baseKey.length < 32) {
      throw new Error(
        `Challenge2faService: jwt_secret must be >= 32 bytes (got ${baseKey.length})`,
      );
    }
    const derived = hkdfSync(
      'sha256',
      baseKey,
      Buffer.alloc(0), // empty salt
      Buffer.from('devloop:2fa_challenge:v1', 'utf8'),
      32,
    );
    this.key = Buffer.from(derived);
  }

  public sign(userId: string): string {
    if (typeof userId !== 'string' || userId.length === 0) {
      throw new Error('Challenge2faService.sign: userId must be a non-empty string');
    }
    const now = Math.floor(Date.now() / 1000);
    const payload = { uid: userId, iat: now, exp: now + this.TTL_SECONDS };
    const payloadJson = JSON.stringify(payload);
    const payloadB64 = Buffer.from(payloadJson, 'utf8').toString('base64url');
    const mac = createHmac('sha256', this.key).update(payloadJson).digest();
    const macB64 = mac.toString('base64url');
    return `${payloadB64}.${macB64}`;
  }

  /**
   * Verify a challenge token and return the embedded userId on success,
   * or null on any failure (malformed, bad MAC, expired).
   */
  public verify(token: string): string | null {
    if (typeof token !== 'string' || token.length === 0) {
      return null;
    }
    const parts = token.split('.');
    if (parts.length !== 2) {
      return null;
    }
    const [payloadB64, macB64] = parts;
    if (!payloadB64 || !macB64) {
      return null;
    }

    let payloadJson: string;
    try {
      payloadJson = Buffer.from(payloadB64, 'base64url').toString('utf8');
    } catch {
      return null;
    }

    let expected: Buffer;
    try {
      expected = createHmac('sha256', this.key).update(payloadJson).digest();
    } catch {
      return null;
    }

    let provided: Buffer;
    try {
      provided = Buffer.from(macB64, 'base64url');
    } catch {
      return null;
    }

    if (provided.length !== expected.length) {
      return null;
    }
    if (!timingSafeEqual(provided, expected)) {
      return null;
    }

    let payload: { uid?: unknown; iat?: unknown; exp?: unknown };
    try {
      payload = JSON.parse(payloadJson);
    } catch {
      return null;
    }

    if (
      typeof payload.uid !== 'string' ||
      payload.uid.length === 0 ||
      typeof payload.exp !== 'number'
    ) {
      return null;
    }

    const nowSec = Math.floor(Date.now() / 1000);
    // exp <= nowSec rejects tokens at the exact expiry second.
    if (payload.exp <= nowSec) {
      return null;
    }

    return payload.uid;
  }
}
