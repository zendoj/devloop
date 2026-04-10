import { Injectable, Logger, OnModuleInit } from '@nestjs/common';
import { readFileSync } from 'node:fs';

/**
 * SecretsService — loads file-backed runtime secrets per ARCHITECTURE §4.3.
 *
 * The canonical storage model is: each secret lives in a file on disk at
 * /etc/devloop/<name>, mode 0440, owner root:<service-group>, loaded into
 * the service via systemd LoadCredential. LoadCredential places the file
 * under $CREDENTIALS_DIRECTORY at runtime; we check that first, then
 * fall back to /etc/devloop/<name>, then to a same-named environment
 * variable for developer workflow outside systemd.
 *
 * No secret is read twice: every secret is loaded eagerly in onModuleInit
 * and cached in memory. If the underlying file rotates, the service must
 * be restarted — this matches the manual-rotation design in §4.3.
 */
@Injectable()
export class SecretsService implements OnModuleInit {
  private readonly logger = new Logger(SecretsService.name);
  private readonly cache = new Map<string, Buffer>();

  public async onModuleInit(): Promise<void> {
    // Eagerly load the two secrets the API needs today. Later phases may
    // extend this list; each addition should be explicit, not lazy.
    this.loadSecret('jwt_secret', { minBytes: 32 });
    this.loadSecret('data_encryption_key', { exactBytes: 32 });
  }

  public getSecret(name: string): Buffer {
    const cached = this.cache.get(name);
    if (!cached) {
      throw new Error(
        `SecretsService: secret '${name}' was not loaded at init. Add it to onModuleInit().`,
      );
    }
    // Return a defensive copy so callers can mutate without affecting
    // the cache or other consumers.
    return Buffer.from(cached);
  }

  private loadSecret(
    name: string,
    opts: { exactBytes?: number; minBytes?: number },
  ): void {
    const raw = this.readSecretBytes(name);

    if (opts.exactBytes !== undefined && raw.length !== opts.exactBytes) {
      throw new Error(
        `SecretsService: '${name}' must be exactly ${opts.exactBytes} bytes (got ${raw.length})`,
      );
    }
    if (opts.minBytes !== undefined && raw.length < opts.minBytes) {
      throw new Error(
        `SecretsService: '${name}' must be at least ${opts.minBytes} bytes (got ${raw.length})`,
      );
    }

    this.cache.set(name, raw);
    this.logger.log(`loaded secret '${name}' (${raw.length} bytes)`);
  }

  private readSecretBytes(name: string): Buffer {
    // 1. systemd LoadCredential
    const credDir = process.env['CREDENTIALS_DIRECTORY'];
    if (credDir) {
      try {
        return readFileSync(`${credDir}/${name}`);
      } catch {
        // fall through to next source
      }
    }

    // 2. canonical disk path
    try {
      return readFileSync(`/etc/devloop/${name}`);
    } catch {
      // fall through
    }

    // 3. dev fallback — environment variable. The raw value is treated
    // as UTF-8 text and decoded as base64 if it starts with 'base64:',
    // otherwise its UTF-8 bytes are used verbatim. This makes it easy to
    // provide hex/base64 keys in a .env without a wrapping shell quote
    // dance while keeping the production path file-backed.
    const envKey = `DEVLOOP_${name.toUpperCase()}`;
    const envVal = process.env[envKey];
    if (envVal !== undefined && envVal.length > 0) {
      if (envVal.startsWith('base64:')) {
        return Buffer.from(envVal.slice(7), 'base64');
      }
      return Buffer.from(envVal, 'utf8');
    }

    throw new Error(
      `SecretsService: secret '${name}' not found. Tried $CREDENTIALS_DIRECTORY/${name}, /etc/devloop/${name}, and $${envKey}.`,
    );
  }
}
