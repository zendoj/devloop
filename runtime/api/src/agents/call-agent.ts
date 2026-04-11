/* eslint-disable no-console */
import { readFileSync } from 'node:fs';
import { DataSource } from 'typeorm';

/**
 * Fas F1 — generic agent call wrapper.
 *
 * Every AI-calling service in DevLoop (reviewer, classifier,
 * summarizer, auditor, planner) goes through `callAgent(role, ...)`.
 * The function:
 *
 *   1. Reads the row for `role` from public.agent_configs.
 *   2. Loads the plaintext API key from the file referenced by
 *      api_key_ref (via systemd LoadCredential or /etc/devloop/).
 *   3. Loads the optional base URL from base_url_ref the same way.
 *   4. Prepends the row's system_prompt to the caller's prompt
 *      (webengine has no system-role field, so we just embed it).
 *   5. Dispatches to the right provider implementation:
 *        - webengine → async POST /ask + poll /job/:jobId
 *        - openai    → sync POST /v1/chat/completions
 *        - claude_cli → reserved; the worker still uses the
 *          direct git-worker.ts CLI path so callAgent doesn't
 *          need to dispatch to it for now.
 *        - anthropic → reserved for future direct-API use.
 *   6. Returns the model's textual response. The caller parses
 *      it (usually JSON.parse) — callAgent stays schema-agnostic.
 *
 * Every call is timed and logged with role + provider + elapsed
 * ms so the audit chain is consistent across providers.
 */

export type AgentRole =
  | 'classifier'
  | 'planner'
  | 'coder'
  | 'reviewer'
  | 'auditor'
  | 'summarizer';

interface AgentConfigRow {
  role: AgentRole;
  provider: 'webengine' | 'openai' | 'claude_cli' | 'anthropic';
  model: string;
  api_key_ref: string;
  base_url_ref: string | null;
  system_prompt: string;
  max_budget_usd: string; // numeric comes back as string
  timeout_ms: number;
  enabled: boolean;
}

export interface CallAgentInput {
  role: AgentRole;
  prompt: string;
  // Optional conversation ref for providers that support threads
  // (webengine). A value here is passed through verbatim. NOT
  // looked up in agent_conversations — that's the caller's
  // responsibility.
  conversationRef?: string;
}

export interface CallAgentResult {
  text: string;
  elapsedMs: number;
  model: string;
  provider: AgentConfigRow['provider'];
  conversationRef: string | null;
}

const CONFIG_CACHE = new Map<AgentRole, { row: AgentConfigRow; loadedAt: number }>();
const CONFIG_TTL_MS = 30_000;

function loadFile(name: string): string | null {
  const credDir = process.env['CREDENTIALS_DIRECTORY'];
  if (credDir) {
    try {
      return readFileSync(`${credDir}/${name}`, 'utf8').trim();
    } catch {
      /* fall through */
    }
  }
  try {
    return readFileSync(`/etc/devloop/${name}`, 'utf8').trim();
  } catch {
    return null;
  }
}

async function loadConfig(
  ds: DataSource,
  role: AgentRole,
): Promise<AgentConfigRow> {
  const cached = CONFIG_CACHE.get(role);
  if (cached && Date.now() - cached.loadedAt < CONFIG_TTL_MS) {
    return cached.row;
  }
  const rows = (await ds.query(
    `SELECT role, provider::text AS provider, model, api_key_ref,
            base_url_ref, system_prompt, max_budget_usd::text AS max_budget_usd,
            timeout_ms, enabled
       FROM public.agent_configs
      WHERE role = $1::public.agent_role_enum
      LIMIT 1`,
    [role],
  )) as AgentConfigRow[];
  const row = rows[0];
  if (!row) {
    throw new Error(`callAgent: no agent_configs row for role '${role}'`);
  }
  if (!row.enabled) {
    throw new Error(`callAgent: role '${role}' is disabled`);
  }
  CONFIG_CACHE.set(role, { row, loadedAt: Date.now() });
  return row;
}

export async function callAgent(
  ds: DataSource,
  input: CallAgentInput,
): Promise<CallAgentResult> {
  const cfg = await loadConfig(ds, input.role);

  const apiKey = loadFile(cfg.api_key_ref);
  if (apiKey === null || apiKey.length === 0) {
    throw new Error(
      `callAgent: api_key_ref '${cfg.api_key_ref}' missing or empty`,
    );
  }
  const baseUrl = cfg.base_url_ref ? loadFile(cfg.base_url_ref) : null;

  const composedPrompt =
    cfg.system_prompt.length > 0
      ? `${cfg.system_prompt}\n\n---\n\n${input.prompt}`
      : input.prompt;

  const started = Date.now();
  let text: string;
  let conversationRef: string | null = null;

  switch (cfg.provider) {
    case 'webengine': {
      const result = await callWebengine(
        baseUrl ?? 'http://127.0.0.1:3099',
        apiKey,
        cfg.model,
        cfg.timeout_ms,
        composedPrompt,
        input.conversationRef,
      );
      text = result.text;
      conversationRef = result.conversationId;
      break;
    }
    case 'openai': {
      text = await callOpenai(
        baseUrl ?? 'https://api.openai.com',
        apiKey,
        cfg.model,
        cfg.timeout_ms,
        cfg.system_prompt,
        input.prompt,
      );
      break;
    }
    case 'claude_cli':
    case 'anthropic':
      throw new Error(
        `callAgent: provider '${cfg.provider}' is not yet implemented as a synchronous call — the worker path uses git-worker.ts directly.`,
      );
    default:
      throw new Error(`callAgent: unknown provider '${String(cfg.provider)}'`);
  }

  const elapsedMs = Date.now() - started;
  console.log(
    `[agent] ${cfg.provider}:${cfg.model} role=${cfg.role} elapsed=${elapsedMs}ms`,
  );
  return {
    text,
    elapsedMs,
    model: cfg.model,
    provider: cfg.provider,
    conversationRef,
  };
}

/**
 * Webengine is async: POST /ask returns {jobId, conversationId},
 * then we poll /job/:jobId until status is done/error. The base
 * URL is expected to already target the right path root — either
 * http://127.0.0.1:3099 (direct, nginx-stripped) or
 * https://webengine.airpipe.ai/api (through nginx+CF). We check
 * which by looking at the base URL's path and branch accordingly
 * so the same secret-file value works in both test and prod.
 */
async function callWebengine(
  baseUrl: string,
  apiKey: string,
  model: string,
  timeoutMs: number,
  prompt: string,
  conversationRef?: string,
): Promise<{ text: string; conversationId: string | null }> {
  const normalized = baseUrl.replace(/\/+$/, '');
  // If the configured base URL ends in /api we talk to the nginx
  // path, otherwise we talk to the upstream directly (127.0.0.1:3099
  // strips /api at the nginx layer).
  const askPath = normalized.endsWith('/api')
    ? `${normalized}/ask`
    : `${normalized}/ask`;
  const jobPath = (jobId: string) =>
    normalized.endsWith('/api')
      ? `${normalized}/job/${jobId}`
      : `${normalized}/job/${jobId}`;

  const headers: Record<string, string> = {
    'Authorization': `Bearer ${apiKey}`,
    'Content-Type': 'application/json',
  };

  const submitBody: Record<string, unknown> = { prompt, model };
  if (conversationRef) submitBody.conversationId = conversationRef;

  const submitRes = await fetch(askPath, {
    method: 'POST',
    headers,
    body: JSON.stringify(submitBody),
  });
  if (!submitRes.ok && submitRes.status !== 202) {
    const body = await submitRes.text().catch(() => '');
    throw new Error(
      `webengine /ask HTTP ${submitRes.status}: ${body.slice(0, 200)}`,
    );
  }
  const submitJson = (await submitRes.json()) as {
    jobId?: string;
    conversationId?: string;
  };
  const jobId = submitJson.jobId;
  if (typeof jobId !== 'string' || jobId.length === 0) {
    throw new Error(`webengine /ask returned no jobId`);
  }
  const convId = submitJson.conversationId ?? null;

  const deadline = Date.now() + timeoutMs;
  // Poll every 3s. Small initial backoff so tiny requests don't
  // eat an extra 3s round-trip — matches webengine's observed
  // ~10s total turnaround on latest-instant.
  let pollInterval = 1_500;
  while (Date.now() < deadline) {
    await sleep(pollInterval);
    pollInterval = Math.min(pollInterval + 500, 5_000);
    const res = await fetch(jobPath(jobId), { method: 'GET', headers });
    if (res.status === 404) {
      throw new Error(`webengine job ${jobId} disappeared (404)`);
    }
    if (!res.ok) {
      const body = await res.text().catch(() => '');
      throw new Error(
        `webengine /job HTTP ${res.status}: ${body.slice(0, 200)}`,
      );
    }
    const body = (await res.json()) as {
      status?: string;
      response?: string;
      text?: string;
      error?: string;
    };
    if (body.status === 'done') {
      const content = body.response ?? body.text ?? '';
      if (typeof content !== 'string' || content.length === 0) {
        throw new Error(`webengine job ${jobId} done with empty body`);
      }
      return { text: content, conversationId: convId };
    }
    if (body.status === 'error') {
      throw new Error(
        `webengine job ${jobId} error: ${(body.error ?? 'unknown').slice(0, 300)}`,
      );
    }
  }
  throw new Error(`webengine job ${jobId} timed out after ${timeoutMs}ms`);
}

async function callOpenai(
  baseUrl: string,
  apiKey: string,
  model: string,
  timeoutMs: number,
  systemPrompt: string,
  userPrompt: string,
): Promise<string> {
  const url = `${baseUrl.replace(/\/+$/, '')}/v1/chat/completions`;
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), timeoutMs);
  try {
    const res = await fetch(url, {
      method: 'POST',
      headers: {
        'Authorization': `Bearer ${apiKey}`,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({
        model,
        messages: [
          { role: 'system', content: systemPrompt },
          { role: 'user', content: userPrompt },
        ],
        reasoning_effort: 'medium',
        max_completion_tokens: 4000,
        response_format: { type: 'json_object' },
      }),
      signal: ctrl.signal,
    });
    if (!res.ok) {
      const body = await res.text().catch(() => '');
      throw new Error(`openai HTTP ${res.status}: ${body.slice(0, 200)}`);
    }
    const body = (await res.json()) as {
      choices?: Array<{ message?: { content?: string } }>;
    };
    const content = body.choices?.[0]?.message?.content;
    if (typeof content !== 'string' || content.length === 0) {
      throw new Error('openai returned empty content');
    }
    return content;
  } finally {
    clearTimeout(timer);
  }
}

function sleep(ms: number): Promise<void> {
  return new Promise((res) => {
    const t = setTimeout(res, ms);
    t.unref();
  });
}

/**
 * Strip a ```json ... ``` fence if present, otherwise return the
 * trimmed input. Models occasionally wrap their JSON output in a
 * fenced code block; callers that parse JSON should run this
 * first.
 */
export function stripJsonFence(s: string): string {
  const trimmed = s.trim();
  const fence = trimmed.match(/^```(?:json)?\s*\n?([\s\S]*?)\n?```$/);
  if (fence && fence[1]) return fence[1].trim();
  return trimmed;
}
