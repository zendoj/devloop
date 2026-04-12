import { BadRequestException, Injectable, Logger, NotFoundException } from '@nestjs/common';
import {
  readdir,
  stat,
  writeFile,
  unlink,
  readFile,
  mkdir,
} from 'node:fs/promises';
import { existsSync } from 'node:fs';
import { randomBytes } from 'node:crypto';

/**
 * FilesService — scratchpad file store for the operator.
 *
 * Files live under /var/lib/devloop/files/ on the DevLoop server.
 * Jonas uploads reference images, specs, screenshots, json dumps
 * via the sidebar panel; gets a stable path back like
 * /var/lib/devloop/files/<name> that can be pasted into a bug
 * report's description or into Claude's prompt.
 *
 * Nothing elevated here — it's just a named-bucket on disk:
 *   - list()    — returns everything in the dir
 *   - save()    — writes a new file with a collision-safe name
 *   - delete()  — removes by name
 *   - read()    — returns file bytes for GET download
 *
 * Every method validates the name against a strict charset
 * ([A-Za-z0-9._-], max 128 chars) and rejects anything with
 * a slash, so path traversal is impossible regardless of
 * what the caller sends.
 */

const FILES_DIR = '/var/lib/devloop/files';
const MAX_FILE_BYTES = 50 * 1024 * 1024; // 50 MB per file
const NAME_PATTERN = /^[A-Za-z0-9._-]{1,128}$/;

export interface StoredFile {
  name: string;
  size: number;
  mtime: string;
  abs_path: string;
}

@Injectable()
export class FilesService {
  private readonly logger = new Logger(FilesService.name);

  public async ensureDir(): Promise<void> {
    if (!existsSync(FILES_DIR)) {
      await mkdir(FILES_DIR, { recursive: true });
    }
  }

  public async list(): Promise<StoredFile[]> {
    await this.ensureDir();
    const entries = await readdir(FILES_DIR);
    const out: StoredFile[] = [];
    for (const name of entries) {
      if (!NAME_PATTERN.test(name)) continue;
      try {
        const s = await stat(`${FILES_DIR}/${name}`);
        if (!s.isFile()) continue;
        out.push({
          name,
          size: s.size,
          mtime: s.mtime.toISOString(),
          abs_path: `${FILES_DIR}/${name}`,
        });
      } catch {
        // skip unreadable
      }
    }
    out.sort((a, b) => (a.mtime > b.mtime ? -1 : 1));
    return out;
  }

  public async save(
    originalName: string,
    content: Buffer,
  ): Promise<StoredFile> {
    await this.ensureDir();
    if (content.length > MAX_FILE_BYTES) {
      throw new BadRequestException(
        `file too large (${content.length} > ${MAX_FILE_BYTES} bytes)`,
      );
    }
    const name = this.makeUniqueName(originalName);
    const path = `${FILES_DIR}/${name}`;
    await writeFile(path, content);
    const s = await stat(path);
    this.logger.log(`saved ${name} (${s.size} bytes)`);
    return {
      name,
      size: s.size,
      mtime: s.mtime.toISOString(),
      abs_path: path,
    };
  }

  public async read(name: string): Promise<Buffer> {
    this.assertValidName(name);
    const path = `${FILES_DIR}/${name}`;
    if (!existsSync(path)) {
      throw new NotFoundException(`file not found: ${name}`);
    }
    return readFile(path);
  }

  public async delete(name: string): Promise<void> {
    this.assertValidName(name);
    const path = `${FILES_DIR}/${name}`;
    if (!existsSync(path)) {
      throw new NotFoundException(`file not found: ${name}`);
    }
    await unlink(path);
    this.logger.log(`deleted ${name}`);
  }

  private assertValidName(name: string): void {
    if (!NAME_PATTERN.test(name)) {
      throw new BadRequestException(`invalid name: ${name}`);
    }
  }

  /**
   * Build a collision-safe name from the upload's original name.
   * Strips the extension, sanitizes the base, appends an 8-char
   * hex suffix, restores the extension. Max final length 128.
   */
  private makeUniqueName(originalName: string): string {
    const safe = (originalName || 'upload')
      .replace(/[^A-Za-z0-9._-]/g, '_')
      .slice(0, 100);
    const dot = safe.lastIndexOf('.');
    const base = dot > 0 ? safe.slice(0, dot) : safe;
    const ext = dot > 0 ? safe.slice(dot) : '';
    const suffix = randomBytes(4).toString('hex');
    return `${base}-${suffix}${ext}`.slice(0, 128);
  }
}
