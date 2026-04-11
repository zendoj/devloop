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

export interface CallAgentFile {
  /** File name as it should appear to the model (e.g. 'diff.txt') */
  name: string;
  /** File content as UTF-8 text or raw buffer */
  content: string | Buffer;
}

export interface CallAgentInput {
  role: AgentRole;
  prompt: string;
  /**
   * Optional files to attach. The webengine provider sends them
   * via multipart /ask-with-files; the openai provider (for now)
   * ignores them and falls back to inlining. Keep prompt SHORT
   * and put bulk content (diffs, full files, reports) in files.
   */
  files?: CallAgentFile[];
  /**
   * Optional conversation ref for providers that support threads.
   * Reviewer passes undefined so webengine opens a fresh chat per
   * request — reproducibility beats cheap memory.
   */
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
      const result = await withWebengineSlot(() =>
        callWebengine(
          baseUrl ?? 'http://127.0.0.1:3099',
          apiKey,
          cfg.model,
          cfg.timeout_ms,
          composedPrompt,
          input.files ?? [],
          input.conversationRef,
        ),
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

// ─── Webengine concurrency limiter + throttle + cooldown ────────
// Three layers of protection against hammering webengine's upstream:
//
//   1. SEMAPHORE: at most 5 simultaneous webengine calls across all
//      roles (reviewer, classifier, planner, auditor, summarizer).
//   2. MIN-DELAY: at least WEBENGINE_MIN_DELAY_MS between any two
//      new /ask submits — throughput cap on top of concurrency.
//      Prevents short bursts that trip rate limits even when the
//      semaphore isn't saturated.
//   3. COOLDOWN: if any call returns HTTP 429 OR a body that
//      mentions "temporarily limited" / "rate limit", every
//      subsequent webengine call throws immediately for the next
//      WEBENGINE_COOLDOWN_MS so we stop making things worse. The
//      reviewer/classifier catch this error and leave tasks in
//      their current state for the next poll iteration.
//
// Jonas's explicit guidance (2026-04-11): max 5 simultaneous; must
// wait between bursts; stop everything if ChatGPT says temporarily
// limited.
const WEBENGINE_MAX_CONCURRENT = 5;
const WEBENGINE_MIN_DELAY_MS = 8_000;
const WEBENGINE_COOLDOWN_MS = 10 * 60 * 1000;

let webengineActive = 0;
const webengineWaiters: Array<() => void> = [];
let webengineLastSubmitAt = 0;
let webengineCooldownUntil = 0;

async function withWebengineSlot<T>(fn: () => Promise<T>): Promise<T> {
  // Hard block if we're in cooldown — surface as an error the
  // caller can catch and retry later.
  const now = Date.now();
  if (webengineCooldownUntil > now) {
    const remaining = Math.ceil((webengineCooldownUntil - now) / 1000);
    throw new Error(
      `webengine cooldown active (${remaining}s remaining after upstream rate-limit signal)`,
    );
  }

  // Wait for a slot if concurrency cap is hit.
  if (webengineActive >= WEBENGINE_MAX_CONCURRENT) {
    await new Promise<void>((resolve) => webengineWaiters.push(resolve));
  }

  // Throughput throttle: enforce min-delay between SUBMITS. We
  // do this after claiming a slot so concurrent callers queue
  // politely on the timer instead of all racing through.
  const sinceLastSubmit = Date.now() - webengineLastSubmitAt;
  if (sinceLastSubmit < WEBENGINE_MIN_DELAY_MS) {
    await sleep(WEBENGINE_MIN_DELAY_MS - sinceLastSubmit);
  }
  webengineLastSubmitAt = Date.now();

  webengineActive += 1;
  try {
    return await fn();
  } catch (err) {
    // Detect upstream rate-limit signals and open the cooldown
    // window so every subsequent call bails out fast.
    const msg = (err as Error).message ?? '';
    const looksLikeRateLimit =
      msg.includes('HTTP 429') ||
      /rate.?limit/i.test(msg) ||
      /temporarily limited/i.test(msg) ||
      /too many requests/i.test(msg);
    if (looksLikeRateLimit) {
      webengineCooldownUntil = Date.now() + WEBENGINE_COOLDOWN_MS;
      console.warn(
        `[agent] webengine cooldown engaged for ${WEBENGINE_COOLDOWN_MS / 1000}s — upstream signaled rate-limit: ${msg.slice(0, 200)}`,
      );
    }
    throw err;
  } finally {
    webengineActive -= 1;
    const next = webengineWaiters.shift();
    if (next) next();
  }
}

/**
 * Webengine is async: POST /ask (or /ask-with-files) returns
 * {jobId, conversationId}, then we poll /job/:jobId until status
 * is done/error. The base URL is expected to already target the
 * right path root — either http://127.0.0.1:3099 (direct, nginx-
 * stripped) or https://webengine.airpipe.ai/api (through nginx+
 * Cloudflare). Both work with the same path suffix we build here.
 *
 * When the caller passes `files`, we use POST /ask-with-files as
 * multipart/form-data. The prompt text is kept short because
 * webengine's Playwright driver occasionally trips on long /
 * code-fenced prompts pasted into its chat UI; the heavy content
 * (diffs, file contents, reports) rides along as proper files.
 */
async function callWebengine(
  baseUrl: string,
  apiKey: string,
  model: string,
  timeoutMs: number,
  prompt: string,
  files: CallAgentFile[],
  conversationRef?: string,
): Promise<{ text: string; conversationId: string | null }> {
  const normalized = baseUrl.replace(/\/+$/, '');
  const askPath = files.length > 0
    ? `${normalized}/ask-with-files`
    : `${normalized}/ask`;
  const jobPath = (jobId: string) => `${normalized}/job/${jobId}`;

  // Auth header for both the submit and the poll requests. For
  // multipart we deliberately do NOT set Content-Type — letting
  // node's fetch insert its own boundary.
  const authHeader = `Bearer ${apiKey}`;

  let submitRes: Response;
  if (files.length > 0) {
    const form = new FormData();
    form.set('prompt', prompt);
    form.set('model', model);
    form.set('saveFile', 'true');
    if (conversationRef) form.set('conversationId', conversationRef);
    for (const f of files) {
      const blob =
        typeof f.content === 'string'
          ? new Blob([f.content], { type: 'text/plain; charset=utf-8' })
          : new Blob([new Uint8Array(f.content)], {
              type: 'application/octet-stream',
            });
      form.append('files', blob, f.name);
    }
    submitRes = await fetch(askPath, {
      method: 'POST',
      headers: { 'Authorization': authHeader },
      body: form,
    });
  } else {
    const submitBody: Record<string, unknown> = { prompt, model };
    if (conversationRef) submitBody.conversationId = conversationRef;
    submitRes = await fetch(askPath, {
      method: 'POST',
      headers: {
        'Authorization': authHeader,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify(submitBody),
    });
  }

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
    const res = await fetch(jobPath(jobId), {
      method: 'GET',
      headers: { 'Authorization': authHeader },
    });
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
      fullResponse?: string;
      summary?: string;
      attachments?: Array<{ name: string; url: string }>;
      fileUrl?: string;
      error?: string;
    };
    if (body.status === 'done') {
      // When saveFile:true was set on the submit, webengine writes
      // the model's answer to a server-side .txt file. Prefer that
      // file's contents over the in-chat text fields — it's the
      // canonical output and bypasses any UI-level truncation.
      let content: string | null = null;
      if (body.fileUrl) {
        try {
          const fileRes = await fetch(
            body.fileUrl.startsWith('http')
              ? body.fileUrl
              : `${normalized}${body.fileUrl.replace(/^\/api/, '')}`,
            { headers: { 'Authorization': authHeader } },
          );
          if (fileRes.ok) content = await fileRes.text();
        } catch {
          /* fall through to text-field path */
        }
      }
      if (content === null) {
        content = body.fullResponse ?? body.response ?? body.text ?? '';
      }
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
  // Do NOT unref() this timer. The webengine throttle + job-poll
  // loops are the ONLY pending work during a summarizer call
  // from the deployer — if the timer is unref'd, Node sees zero
  // active handles and cleanly exits the whole process with
  // code 0 while the await is still pending. That manifests as
  // the deployer silently dropping out mid-deploy. Standard
  // (ref'd) setTimeout keeps the loop alive until the sleep
  // resolves and the next real work lands.
  return new Promise((res) => {
    setTimeout(res, ms);
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
