import { MigrationInterface, QueryRunner } from 'typeorm';

/**
 * Migration 021 — agent_configs + agent_conversations.
 *
 * Fas F1 groundwork for multi-provider agent routing. Introduces a
 * single table that every AI-calling service reads at request time
 * to decide:
 *
 *   - which provider to talk to (webengine / openai / claude-cli)
 *   - which model string to pass
 *   - which secret file (api_key_ref) holds the credentials
 *   - optional override base_url
 *   - the system-prompt template to prepend
 *   - max_budget_usd per single call (advisory cap the caller should
 *     enforce — the DB does not enforce)
 *
 * One row per logical role. The fixed role names are an enum at
 * the DB level so typos in calling code surface immediately.
 *
 * A separate table `agent_conversations` tracks webengine
 * conversation-id per (project, role, module) so the Planner role
 * (disabled by default in F1) can preserve thread context across
 * tasks within the same module without polluting the agent_configs
 * row with mutable state.
 *
 * Seeds six rows (classifier, planner, coder, reviewer, auditor,
 * summarizer) with sensible defaults. Planner is disabled=true
 * because Fas F1 does not introduce the planner pipeline step yet.
 *
 * Grants: devloop_api gets SELECT on agent_configs and full
 * read/write on agent_conversations (so services can upsert the
 * conversation_id after creating a fresh webengine conversation).
 * Only devloop_owner can modify agent_configs rows — the web GUI
 * at /agents will route updates through a SECURITY DEFINER helper
 * in a later migration.
 */
export class AgentConfigs1712700000021 implements MigrationInterface {
  name = 'AgentConfigs1712700000021';

  public async up(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(`
      CREATE TYPE public.agent_role_enum AS ENUM (
        'classifier',
        'planner',
        'coder',
        'reviewer',
        'auditor',
        'summarizer'
      )
    `);

    await queryRunner.query(`
      CREATE TYPE public.agent_provider_enum AS ENUM (
        'webengine',
        'openai',
        'claude_cli',
        'anthropic'
      )
    `);

    await queryRunner.query(`
      CREATE TABLE public.agent_configs (
        role             public.agent_role_enum PRIMARY KEY,
        provider         public.agent_provider_enum NOT NULL,
        model            varchar(128)  NOT NULL,
        api_key_ref      varchar(128)  NOT NULL,
        base_url_ref     varchar(128),
        system_prompt    text          NOT NULL DEFAULT '',
        max_budget_usd   numeric(10,4) NOT NULL DEFAULT 1.0000,
        timeout_ms       integer       NOT NULL DEFAULT 600000,
        enabled          boolean       NOT NULL DEFAULT true,
        updated_at       timestamptz   NOT NULL DEFAULT now(),
        updated_by       varchar(128)  NOT NULL DEFAULT 'migration',
        CONSTRAINT agent_configs_budget_positive CHECK (max_budget_usd > 0),
        CONSTRAINT agent_configs_timeout_positive CHECK (timeout_ms > 0),
        CONSTRAINT agent_configs_model_nonempty CHECK (char_length(model) > 0),
        CONSTRAINT agent_configs_api_key_ref_nonempty CHECK (char_length(api_key_ref) > 0)
      )
    `);

    await queryRunner.query(`
      CREATE TABLE public.agent_conversations (
        id               bigserial PRIMARY KEY,
        project_id       uuid NOT NULL REFERENCES public.projects(id) ON DELETE CASCADE,
        role             public.agent_role_enum NOT NULL,
        module           varchar(64),
        provider         public.agent_provider_enum NOT NULL,
        conversation_ref varchar(64) NOT NULL,
        created_at       timestamptz NOT NULL DEFAULT now(),
        last_used_at     timestamptz NOT NULL DEFAULT now(),
        message_count    integer     NOT NULL DEFAULT 0,
        CONSTRAINT agent_conversations_uniq UNIQUE (project_id, role, module, provider)
      )
    `);

    // Seed default agent configs. Webengine is the default provider
    // for every role except 'coder' — the coder defaults to the
    // local Claude CLI because that was already wired in Fas B1 and
    // is configurable per-project in a later phase.
    await queryRunner.query(`
      INSERT INTO public.agent_configs
        (role, provider, model, api_key_ref, base_url_ref, system_prompt, max_budget_usd, timeout_ms, enabled)
      VALUES
        (
          'classifier',
          'webengine',
          'latest-instant',
          'webengine_api_key',
          'webengine_base_url',
          'You classify bug reports into {module, risk_tier}. Return only JSON.',
          0.1000,
          60000,
          true
        ),
        (
          'planner',
          'webengine',
          'latest-thinking-light',
          'webengine_api_key',
          'webengine_base_url',
          'You plan minimal code changes. Return only JSON with a file list and one-line rationale per file.',
          0.5000,
          300000,
          false
        ),
        (
          'coder',
          'claude_cli',
          'claude-opus-4-6',
          'claude_home',
          NULL,
          '',
          5.0000,
          900000,
          true
        ),
        (
          'reviewer',
          'webengine',
          'latest-thinking-standard',
          'webengine_api_key',
          'webengine_base_url',
          'You are a code reviewer. Return only JSON {decision, score, summary}.',
          1.0000,
          600000,
          true
        ),
        (
          'auditor',
          'webengine',
          'latest-thinking-extended',
          'webengine_api_key',
          'webengine_base_url',
          'You are a security auditor. Scan for secret leaks, injection patterns, unsafe deserialization. Return only JSON.',
          1.5000,
          600000,
          false
        ),
        (
          'summarizer',
          'webengine',
          'latest-instant',
          'webengine_api_key',
          'webengine_base_url',
          'You summarise a diff into a one-line PR title and a two-paragraph PR body. Return only JSON.',
          0.1000,
          60000,
          true
        )
    `);

    // Grants.
    await queryRunner.query(`
      GRANT SELECT ON public.agent_configs       TO devloop_api
    `);
    await queryRunner.query(`
      GRANT SELECT, INSERT, UPDATE ON public.agent_conversations TO devloop_api
    `);
    await queryRunner.query(`
      GRANT USAGE, SELECT ON SEQUENCE public.agent_conversations_id_seq TO devloop_api
    `);
  }

  public async down(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(`DROP TABLE IF EXISTS public.agent_conversations`);
    await queryRunner.query(`DROP TABLE IF EXISTS public.agent_configs`);
    await queryRunner.query(`DROP TYPE  IF EXISTS public.agent_provider_enum`);
    await queryRunner.query(`DROP TYPE  IF EXISTS public.agent_role_enum`);
  }
}
