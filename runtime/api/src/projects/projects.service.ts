import { Inject, Injectable } from '@nestjs/common';
import { DataSource } from 'typeorm';
import { DATA_SOURCE } from '../db/db.module';

/**
 * The shape returned by GET /projects. Deliberately NOT a 1:1 mirror
 * of the public.projects row — we exclude the token HMACs and the
 * bytea host/deploy credentials because they are useless to the UI
 * and leaking them (even to admins) is pure attack surface.
 */
export interface ProjectListItem {
  id: string;
  slug: string;
  name: string;
  status: string;
  host_base_url: string;
  github_owner: string;
  github_repo: string;
  github_default_branch: string;
  branch_protection_verified_at: string | null;
  created_at: string;
}

@Injectable()
export class ProjectsService {
  constructor(@Inject(DATA_SOURCE) private readonly ds: DataSource) {}

  /**
   * Return all projects the caller is allowed to see. For Fas 1b this
   * is "every admin sees every project". Per-project ACL narrowing
   * belongs to a later phase when non-admin roles exist.
   *
   * Security:
   *   - Parameterized query (no interpolation)
   *   - Explicit column allowlist (no SELECT *)
   *   - Narrow return type (no token_hmac, no deploy paths)
   */
  public async list(callerRole: string): Promise<ProjectListItem[]> {
    if (callerRole !== 'admin' && callerRole !== 'super_admin') {
      // Lower roles get an empty list until scoped ACLs ship.
      return [];
    }

    const rows = (await this.ds.query(
      `
      SELECT
        id,
        slug,
        name,
        status::text                    AS status,
        host_base_url,
        github_owner,
        github_repo,
        github_default_branch,
        branch_protection_verified_at,
        created_at
      FROM public.projects
      ORDER BY created_at DESC, slug ASC
      LIMIT 500
      `,
    )) as Array<{
      id: string;
      slug: string;
      name: string;
      status: string;
      host_base_url: string;
      github_owner: string;
      github_repo: string;
      github_default_branch: string;
      branch_protection_verified_at: Date | null;
      created_at: Date;
    }>;

    return rows.map((r) => ({
      id: r.id,
      slug: r.slug,
      name: r.name,
      status: r.status,
      host_base_url: r.host_base_url,
      github_owner: r.github_owner,
      github_repo: r.github_repo,
      github_default_branch: r.github_default_branch,
      branch_protection_verified_at:
        r.branch_protection_verified_at === null
          ? null
          : new Date(r.branch_protection_verified_at).toISOString(),
      created_at: new Date(r.created_at).toISOString(),
    }));
  }
}
