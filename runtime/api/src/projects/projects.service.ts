import { BadRequestException, Inject, Injectable, NotFoundException } from '@nestjs/common';
import { randomBytes, createHmac } from 'node:crypto';
import { DataSource } from 'typeorm';
import { SecretsService } from '../config/secrets.service';
import { DATA_SOURCE } from '../db/db.module';
import { isValidSlug } from './slug.util';

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

export interface ProjectDetail extends ProjectListItem {
  github_app_install_id: number;
  host_token_id: string;
  deploy_token_id: string;
  deploy_allowlist_paths: string[];
  deploy_denied_paths: string[];
  branch_protection_required_checks: string[];
  reports_open: number;
  tasks_open: number;
}

export interface CreateProjectInput {
  slug: string;
  name: string;
  host_base_url: string;
  github_app_install_id: number;
  github_owner: string;
  github_repo: string;
  github_default_branch: string;
  created_by: string;
}

export interface CreatedProject {
  id: string;
  slug: string;
  host_token: string;
  deploy_token: string;
}

@Injectable()
export class ProjectsService {
  constructor(
    @Inject(DATA_SOURCE) private readonly ds: DataSource,
    private readonly secrets: SecretsService,
  ) {}

  /**
   * Generate a fresh opaque token: 32 random hex bytes (id) + '.' +
   * 48 random hex bytes (secret). HMAC-SHA256 is computed server-side
   * with the jwt_secret and stored as bytea; the raw token is returned
   * once to the caller and never persisted.
   */
  private mintToken(): { id: string; raw: string; hmac: Buffer } {
    const idBytes = randomBytes(16); // 32 hex chars
    const secretBytes = randomBytes(24); // 48 hex chars
    const id = idBytes.toString('hex');
    const secret = secretBytes.toString('hex');
    const raw = `${id}.${secret}`;
    const key = this.secrets.getSecret('jwt_secret');
    const hmac = createHmac('sha256', key).update(raw).digest();
    return { id, raw, hmac };
  }

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

  public async getBySlug(
    slug: string,
    callerRole: string,
  ): Promise<ProjectDetail> {
    if (callerRole !== 'admin' && callerRole !== 'super_admin') {
      throw new NotFoundException('project not found');
    }
    const rows = (await this.ds.query(
      `
      SELECT
        id,
        slug,
        name,
        status::text AS status,
        host_base_url,
        github_app_install_id,
        github_owner,
        github_repo,
        github_default_branch,
        host_token_id,
        deploy_token_id,
        deploy_allowlist_paths,
        deploy_denied_paths,
        branch_protection_required_checks,
        branch_protection_verified_at,
        created_at
      FROM public.projects
      WHERE slug = $1
      LIMIT 1
      `,
      [slug],
    )) as Array<{
      id: string;
      slug: string;
      name: string;
      status: string;
      host_base_url: string;
      github_app_install_id: string;
      github_owner: string;
      github_repo: string;
      github_default_branch: string;
      host_token_id: string;
      deploy_token_id: string;
      deploy_allowlist_paths: string[];
      deploy_denied_paths: string[];
      branch_protection_required_checks: string[];
      branch_protection_verified_at: Date | null;
      created_at: Date;
    }>;

    const r = rows[0];
    if (!r) throw new NotFoundException('project not found');

    const reportsRow = (await this.ds.query(
      `
      SELECT
        COUNT(*) FILTER (WHERE status IN ('new','triaged','in_progress','needs_info'))::int AS reports_open,
        (SELECT COUNT(*) FROM public.agent_tasks
           WHERE project_id = $1
             AND status NOT IN ('verified','rolled_back','rollback_failed','failed','cancelled'))::int AS tasks_open
      FROM public.reports
      WHERE project_id = $1
      `,
      [r.id],
    )) as Array<{ reports_open: number; tasks_open: number }>;

    const counts = reportsRow[0] ?? { reports_open: 0, tasks_open: 0 };

    return {
      id: r.id,
      slug: r.slug,
      name: r.name,
      status: r.status,
      host_base_url: r.host_base_url,
      github_app_install_id: Number(r.github_app_install_id),
      github_owner: r.github_owner,
      github_repo: r.github_repo,
      github_default_branch: r.github_default_branch,
      host_token_id: r.host_token_id,
      deploy_token_id: r.deploy_token_id,
      deploy_allowlist_paths: r.deploy_allowlist_paths ?? [],
      deploy_denied_paths: r.deploy_denied_paths ?? [],
      branch_protection_required_checks:
        r.branch_protection_required_checks ?? [],
      branch_protection_verified_at:
        r.branch_protection_verified_at === null
          ? null
          : new Date(r.branch_protection_verified_at).toISOString(),
      created_at: new Date(r.created_at).toISOString(),
      reports_open: counts.reports_open,
      tasks_open: counts.tasks_open,
    };
  }

  /**
   * Create a new host project. Returns the raw host_token and
   * deploy_token exactly once — the server only stores HMAC digests.
   *
   * Validation:
   *   - slug must match ^[a-z0-9][a-z0-9-]*$ (CHECK enforced too)
   *   - host_base_url must begin with https://
   *   - github_app_install_id > 0
   *   - github_owner, github_repo non-empty
   */
  public async create(input: CreateProjectInput): Promise<CreatedProject> {
    const slug = input.slug.trim();
    const name = input.name.trim();
    const hostBaseUrl = input.host_base_url.trim();
    const githubOwner = input.github_owner.trim();
    const githubRepo = input.github_repo.trim();
    const defaultBranch = (input.github_default_branch || 'main').trim();
    if (defaultBranch.length === 0 || defaultBranch.length > 128) {
      throw new BadRequestException('github_default_branch must be 1..128 chars');
    }

    if (!isValidSlug(slug)) {
      throw new BadRequestException(
        'slug must match ^[a-z0-9][a-z0-9-]*$ and be 2..64 chars',
      );
    }
    if (name.length === 0 || name.length > 255) {
      throw new BadRequestException('name must be 1..255 chars');
    }
    if (!/^https:\/\//.test(hostBaseUrl)) {
      throw new BadRequestException('host_base_url must start with https://');
    }
    if (hostBaseUrl.length > 512) {
      throw new BadRequestException('host_base_url max 512 chars');
    }
    if (input.github_app_install_id <= 0) {
      throw new BadRequestException('github_app_install_id must be > 0');
    }
    if (githubOwner.length === 0 || githubOwner.length > 128) {
      throw new BadRequestException('github_owner must be 1..128 chars');
    }
    if (githubRepo.length === 0 || githubRepo.length > 128) {
      throw new BadRequestException('github_repo must be 1..128 chars');
    }

    const hostToken = this.mintToken();
    const deployToken = this.mintToken();

    try {
      const rows = (await this.ds.query(
        `
        INSERT INTO public.projects (
          slug, name, host_base_url, github_app_install_id,
          github_owner, github_repo, github_default_branch,
          host_token_id, host_token_hmac,
          deploy_token_id, deploy_token_hmac,
          created_by
        ) VALUES (
          $1, $2, $3, $4,
          $5, $6, $7,
          $8, $9,
          $10, $11,
          $12
        )
        RETURNING id, slug
        `,
        [
          slug,
          name,
          hostBaseUrl,
          input.github_app_install_id,
          githubOwner,
          githubRepo,
          defaultBranch,
          hostToken.id,
          hostToken.hmac,
          deployToken.id,
          deployToken.hmac,
          input.created_by,
        ],
      )) as Array<{ id: string; slug: string }>;

      const row = rows[0];
      if (!row) throw new Error('projects insert did not return id');

      // Emit project_registered audit.
      try {
        await this.ds.query(
          `
          SELECT public.append_audit_event(
            $1::uuid, NULL::uuid, NULL::uuid,
            'project_registered'::public.audit_event_enum,
            'user'::public.actor_kind_enum,
            $2::varchar(128),
            jsonb_build_object('slug', $3::text, 'name', $4::text, 'repo', ($5::text || '/' || $6::text)),
            NULL::varchar(32), NULL::varchar(32), NULL::varchar(64), NULL::varchar(32)
          )
          `,
          [row.id, input.created_by, slug, name, githubOwner, githubRepo],
        );
      } catch {
        // audit failure is non-fatal
      }

      return {
        id: row.id,
        slug: row.slug,
        host_token: hostToken.raw,
        deploy_token: deployToken.raw,
      };
    } catch (err) {
      const msg = (err as Error).message;
      if (msg.includes('projects_slug_key')) {
        throw new BadRequestException(`slug '${slug}' is already taken`);
      }
      if (msg.includes('projects_host_token_id_key')) {
        throw new BadRequestException('host_token_id collision — retry');
      }
      if (msg.includes('projects_deploy_token_id_key')) {
        throw new BadRequestException('deploy_token_id collision — retry');
      }
      if (msg.includes('projects_host_base_url_https')) {
        throw new BadRequestException('host_base_url must start with https://');
      }
      if (msg.includes('projects_slug_format')) {
        throw new BadRequestException('slug must match ^[a-z0-9][a-z0-9-]*$');
      }
      throw err;
    }
  }
}
