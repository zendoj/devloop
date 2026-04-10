import { Injectable } from '@nestjs/common';
import { generateSecret, generateURI, verify } from 'otplib';

/**
 * TotpService — RFC 6238 TOTP via the otplib v13 functional API.
 *
 * Parameters (all otplib defaults unless noted):
 *   algorithm       SHA-1 (RFC 6238 default; supported everywhere)
 *   digits          6
 *   period          30 seconds
 *   epochTolerance  30 seconds -> ±1 step window for clock skew
 */
@Injectable()
export class TotpService {
  private readonly ISSUER = 'DevLoop';

  // 30-second tolerance = one additional TOTP step on either side.
  // Matches the window=1 posture Fas 0.9b was designed with.
  private readonly EPOCH_TOLERANCE_SECONDS = 30;

  public generateSecret(): string {
    return generateSecret();
  }

  public buildOtpauthUri(label: string, secret: string): string {
    return generateURI({
      issuer: this.ISSUER,
      label,
      secret,
    });
  }

  public async verify(code: string, secret: string): Promise<boolean> {
    if (typeof code !== 'string' || typeof secret !== 'string') {
      return false;
    }
    try {
      const result = await verify({
        token: code,
        secret,
        epochTolerance: this.EPOCH_TOLERANCE_SECONDS,
      });
      return result.valid === true;
    } catch {
      return false;
    }
  }
}
