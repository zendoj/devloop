import { Inject, Injectable } from '@nestjs/common';
import { DataSource } from 'typeorm';
import { DATA_SOURCE } from '../db/db.module';

export interface AgentConfigListItem {
  role: string;
  provider: string;
  model: string;
  api_key_ref: string;
  base_url_ref: string | null;
  system_prompt: string;
  max_budget_usd: string;
  timeout_ms: number;
  enabled: boolean;
  updated_at: string;
  updated_by: string;
}

@Injectable()
export class AgentsService {
  constructor(@Inject(DATA_SOURCE) private readonly ds: DataSource) {}

  public async list(): Promise<AgentConfigListItem[]> {
    const rows = (await this.ds.query(
      `
      SELECT
        role::text               AS role,
        provider::text           AS provider,
        model,
        api_key_ref,
        base_url_ref,
        system_prompt,
        max_budget_usd::text     AS max_budget_usd,
        timeout_ms,
        enabled,
        updated_at,
        updated_by
      FROM public.agent_configs
      ORDER BY
        CASE role
          WHEN 'classifier' THEN 1
          WHEN 'planner'    THEN 2
          WHEN 'coder'      THEN 3
          WHEN 'reviewer'   THEN 4
          WHEN 'auditor'    THEN 5
          WHEN 'summarizer' THEN 6
        END
      `,
    )) as AgentConfigListItem[];
    return rows;
  }
}
