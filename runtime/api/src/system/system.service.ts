import { Inject, Injectable } from '@nestjs/common';
import { DataSource } from 'typeorm';
import { DATA_SOURCE } from '../db/db.module';

export interface HealthProjectSummary {
  project_id: string;
  project_slug: string;
  last_status: string | null;
  last_probed_at: string | null;
  last_latency_ms: number | null;
  last_http_status: number | null;
  open_alert_id: string | null;
  open_alert_since: string | null;
  open_alert_worst: string | null;
  open_alert_ack: boolean;
  branch_protected: boolean | null;
  branch_compliance_pass: boolean | null;
  branch_last_checked_at: string | null;
  branch_failure_reason: string | null;
}

export interface AuditEventListItem {
  id: number;
  project_slug: string | null;
  project_id: string | null;
  task_id: string | null;
  task_display_id: string | null;
  report_id: string | null;
  event_type: string;
  actor_kind: string;
  actor_name: string;
  from_status: string | null;
  to_status: string | null;
  commit_sha: string | null;
  review_decision: string | null;
  details: unknown;
  created_at: string;
  chain_prev_id: number;
}

export interface SettingsPayload {
  signing_keys: Array<{
    key_id: string;
    algorithm: string;
    public_key_hex: string;
    status: string;
    created_at: string;
    retired_at: string | null;
  }>;
  sessions: Array<{
    id: string;
    user_id: string;
    username: string | null;
    created_at: string;
    last_seen_at: string | null;
    expires_at: string;
    ip: string | null;
    user_agent: string | null;
  }>;
  global_quota: Array<{
    period_key: string;
    metric: string;
    used_value: string;
    limit_value: string;
    updated_at: string;
  }>;
  project_quota: Array<{
    project_slug: string;
    period_key: string;
    metric: string;
    used_value: string;
    limit_value: string;
    updated_at: string;
  }>;
  secrets_status: Array<{
    name: string;
    present: boolean;
    bytes: number;
  }>;
}

@Injectable()
export class SystemService {
  constructor(@Inject(DATA_SOURCE) private readonly ds: DataSource) {}

  public async healthOverview(): Promise<HealthProjectSummary[]> {
    // For every project return: latest probe + open alert + latest
    // branch-protection check in a single round-trip. LATERAL
    // joins keep the query linear in #projects instead of doing
    // a full scan of host_health per row.
    const rows = (await this.ds.query(
      `
      SELECT
        p.id::text                         AS project_id,
        p.slug                             AS project_slug,
        hh.status::text                    AS last_status,
        hh.probed_at                       AS last_probed_at,
        hh.latency_ms                      AS last_latency_ms,
        hh.http_status                     AS last_http_status,
        ha.id::text                        AS open_alert_id,
        ha.opened_at                       AS open_alert_since,
        ha.worst_status::text              AS open_alert_worst,
        (ha.acknowledged_at IS NOT NULL)   AS open_alert_ack,
        bpc.is_protected                   AS branch_protected,
        bpc.compliance_pass                AS branch_compliance_pass,
        bpc.checked_at                     AS branch_last_checked_at,
        bpc.failure_reason                 AS branch_failure_reason
      FROM public.projects p
      LEFT JOIN LATERAL (
        SELECT status, probed_at, latency_ms, http_status
          FROM public.host_health
         WHERE project_id = p.id
         ORDER BY probed_at DESC, id DESC
         LIMIT 1
      ) hh ON TRUE
      LEFT JOIN public.host_health_alerts ha
        ON ha.project_id = p.id
       AND ha.resolved_at IS NULL
      LEFT JOIN LATERAL (
        SELECT is_protected, compliance_pass, checked_at, failure_reason
          FROM public.branch_protection_checks
         WHERE project_id = p.id
         ORDER BY checked_at DESC
         LIMIT 1
      ) bpc ON TRUE
      WHERE p.status IN ('active', 'paused')
      ORDER BY p.slug
      `,
    )) as HealthProjectSummary[];
    return rows;
  }

  public async auditList(limit = 200): Promise<AuditEventListItem[]> {
    const rows = (await this.ds.query(
      `
      SELECT
        ae.id::int                 AS id,
        ae.project_id::text        AS project_id,
        p.slug                     AS project_slug,
        ae.task_id::text           AS task_id,
        at.display_id              AS task_display_id,
        ae.report_id::text         AS report_id,
        ae.event_type::text        AS event_type,
        ae.actor_kind::text        AS actor_kind,
        ae.actor_name,
        ae.from_status,
        ae.to_status,
        ae.commit_sha,
        ae.review_decision,
        ae.details,
        ae.created_at,
        ae.chain_prev_id::int      AS chain_prev_id
      FROM public.audit_events ae
      LEFT JOIN public.projects    p  ON p.id  = ae.project_id
      LEFT JOIN public.agent_tasks at ON at.id = ae.task_id
      ORDER BY ae.id DESC
      LIMIT $1
      `,
      [limit],
    )) as AuditEventListItem[];
    return rows;
  }

  public async settings(): Promise<SettingsPayload> {
    const signingRows = (await this.ds.query(
      `
      SELECT
        key_id,
        algorithm::text AS algorithm,
        encode(public_key, 'hex') AS public_key_hex,
        status::text AS status,
        created_at,
        retired_at
      FROM public.signing_keys
      ORDER BY created_at DESC
      `,
    )) as SettingsPayload['signing_keys'];

    const sessionRows = (await this.ds.query(
      `
      SELECT
        s.id::text                 AS id,
        s.user_id::text            AS user_id,
        u.email                    AS username,
        s.issued_at                AS created_at,
        s.last_seen_at,
        s.expires_at,
        host(s.ip_addr)::text      AS ip,
        s.user_agent
      FROM public.sessions s
      LEFT JOIN public.users u ON u.id = s.user_id
      WHERE s.revoked_at IS NULL
        AND s.expires_at > now()
      ORDER BY s.last_seen_at DESC NULLS LAST
      LIMIT 50
      `,
    )) as SettingsPayload['sessions'];

    const globalQuotaRows = (await this.ds.query(
      `
      SELECT
        period_key,
        metric,
        used_value::text           AS used_value,
        limit_value::text          AS limit_value,
        updated_at
      FROM public.quota_usage_global
      ORDER BY period_key DESC, metric
      LIMIT 20
      `,
    )) as SettingsPayload['global_quota'];

    const projectQuotaRows = (await this.ds.query(
      `
      SELECT
        p.slug                     AS project_slug,
        qup.period_key,
        qup.metric,
        qup.used_value::text       AS used_value,
        qup.limit_value::text      AS limit_value,
        qup.updated_at
      FROM public.quota_usage_project qup
      JOIN public.projects p ON p.id = qup.project_id
      ORDER BY p.slug, qup.period_key DESC, qup.metric
      LIMIT 40
      `,
    )) as SettingsPayload['project_quota'];

    // The API service does not load secrets itself — it only
    // reports whether the files the other services use exist.
    // This mirrors how `systemctl show` reports credential refs
    // without exposing plaintext.
    const secretsStatus = this.probeSecrets([
      'jwt_secret',
      'data_encryption_key',
      'github_token',
      'openai_api_key',
      'webengine_api_key',
      'webengine_base_url',
      'deploy_signing_active_key_id',
    ]);

    return {
      signing_keys: signingRows,
      sessions: sessionRows,
      global_quota: globalQuotaRows,
      project_quota: projectQuotaRows,
      secrets_status: secretsStatus,
    };
  }

  private probeSecrets(
    names: string[],
  ): SettingsPayload['secrets_status'] {
    // eslint-disable-next-line @typescript-eslint/no-require-imports
    const fs = require('node:fs') as typeof import('node:fs');
    const credDir = process.env['CREDENTIALS_DIRECTORY'];
    return names.map((name) => {
      for (const dir of [credDir, '/etc/devloop']) {
        if (!dir) continue;
        try {
          const stat = fs.statSync(`${dir}/${name}`);
          return { name, present: true, bytes: stat.size };
        } catch {
          /* try next dir */
        }
      }
      return { name, present: false, bytes: 0 };
    });
  }
}
