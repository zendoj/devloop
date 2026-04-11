import { Inject, Injectable, Logger } from '@nestjs/common';
import { DataSource } from 'typeorm';
import { DATA_SOURCE } from '../db/db.module';
import { callAgent } from '../agents/call-agent';

/**
 * Shape of the classifier_rules JSONB column on project_configs.
 * Matches what the classifier expects:
 *
 *   {
 *     "rules": [
 *       { "match": "login|sign in|auth",  "module": "auth",        "risk_tier": "high" },
 *       { "match": "db|database|query",   "module": "backend/db",  "risk_tier": "standard" },
 *       { "match": "style|css|layout",    "module": "frontend/ui", "risk_tier": "low" }
 *     ],
 *     "default_module": "unknown",
 *     "default_risk_tier": "standard"
 *   }
 *
 * Rules are applied in order; the first match wins. Match is a
 * JavaScript-compatible regex that runs case-insensitively against
 * the concatenation of report title + description.
 */
export interface ClassifierRules {
  rules: ClassifierRule[];
  default_module: string;
  default_risk_tier: RiskTier;
}

export interface ClassifierRule {
  match: string;
  module: string;
  risk_tier: RiskTier;
}

export type RiskTier = 'low' | 'standard' | 'high' | 'critical';

export interface ClassificationResult {
  module: string;
  risk_tier: RiskTier;
  matched_rule: string | null;
  config_id: string | null;
}

/**
 * Fallback classifier used when a project has no active
 * project_configs row. This is the shape most projects actually
 * start with — nobody wants to configure classifier rules before
 * the first bug report lands.
 */
const DEFAULT_RULES: ClassifierRules = {
  rules: [
    { match: '\\b(login|sign\\s*in|auth|password|2fa|otp)\\b', module: 'auth', risk_tier: 'high' },
    { match: '\\b(payment|billing|invoice|checkout)\\b', module: 'billing', risk_tier: 'critical' },
    { match: '\\b(database|db|query|sql|migration)\\b', module: 'backend/db', risk_tier: 'standard' },
    { match: '\\b(api|endpoint|request|response|status\\s*code)\\b', module: 'backend/api', risk_tier: 'standard' },
    { match: '\\b(style|css|layout|theme|dark\\s*mode)\\b', module: 'frontend/ui', risk_tier: 'low' },
    { match: '\\b(button|form|input|click|render)\\b', module: 'frontend', risk_tier: 'standard' },
    { match: '\\b(email|inbox|imap|smtp)\\b', module: 'email', risk_tier: 'high' },
    { match: '\\b(phone|call|sip|webrtc|46elks)\\b', module: 'telephony', risk_tier: 'high' },
  ],
  default_module: 'unknown',
  default_risk_tier: 'standard',
};

@Injectable()
export class ClassifierService {
  private readonly logger = new Logger(ClassifierService.name);

  constructor(@Inject(DATA_SOURCE) private readonly ds: DataSource) {}

  public async classify(
    projectId: string,
    title: string,
    description: string,
  ): Promise<ClassificationResult> {
    const rules = await this.loadRules(projectId);

    // Fas F2: try the AI classifier first. It gets a constrained
    // list of valid module names + risk tiers derived from the
    // project's rules (so the response is guaranteed to be a
    // module the downstream pipeline already knows about). On
    // ANY failure — disabled agent, network hiccup, unparseable
    // JSON, out-of-allowlist module — we fall through to the
    // regex rules below. This keeps the pipeline deterministic
    // and bounded-latency even when the AI provider is flaky.
    try {
      const aiResult = await this.classifyWithAi(title, description, rules);
      if (aiResult) {
        return aiResult;
      }
    } catch (err) {
      this.logger.warn(
        `AI classifier failed, falling back to regex rules: ${(err as Error).message}`,
      );
    }

    const text = `${title}\n${description}`.toLowerCase();
    for (const rule of rules.rules) {
      let re: RegExp;
      try {
        re = new RegExp(rule.match, 'i');
      } catch (err) {
        this.logger.warn(
          `classifier rule has invalid regex ${rule.match}: ${String(err)}`,
        );
        continue;
      }
      if (re.test(text)) {
        return {
          module: rule.module,
          risk_tier: rule.risk_tier,
          matched_rule: rule.match,
          config_id: null,
        };
      }
    }

    return {
      module: rules.default_module,
      risk_tier: rules.default_risk_tier,
      matched_rule: null,
      config_id: null,
    };
  }

  /**
   * Classify via the `classifier` agent role. Returns null if the
   * AI picks an out-of-allowlist module (so the caller falls back
   * to regex rules). Throws on infra failure.
   */
  private async classifyWithAi(
    title: string,
    description: string,
    rules: ClassifierRules,
  ): Promise<ClassificationResult | null> {
    const allowedModules = new Set<string>([
      rules.default_module,
      ...rules.rules.map((r) => r.module),
    ]);
    const moduleList = Array.from(allowedModules).sort().join(', ');
    const validRiskTiers: RiskTier[] = ['low', 'standard', 'high', 'critical'];

    const prompt = `Classify this bug report into a module and a risk tier.

Allowed modules: ${moduleList}
Allowed risk_tier: ${validRiskTiers.join(', ')}

Return ONLY a JSON object with exactly these keys and no extra text:
{"module":"<one of the allowed modules>","risk_tier":"<one of the allowed tiers>"}

Report title: ${title}
Report description:
${description.slice(0, 4000)}`;

    const result = await callAgent(this.ds, {
      role: 'classifier',
      prompt,
    });

    const stripped = stripJsonFence(result.text);
    let parsed: { module?: unknown; risk_tier?: unknown };
    try {
      parsed = JSON.parse(stripped);
    } catch {
      this.logger.warn(
        `classifier returned non-JSON: ${stripped.slice(0, 200)}`,
      );
      return null;
    }

    const mod = typeof parsed.module === 'string' ? parsed.module.trim() : '';
    const tier = typeof parsed.risk_tier === 'string' ? parsed.risk_tier : '';

    if (!allowedModules.has(mod)) {
      this.logger.warn(`classifier picked disallowed module '${mod}'`);
      return null;
    }
    if (!validRiskTiers.includes(tier as RiskTier)) {
      this.logger.warn(`classifier picked invalid risk_tier '${tier}'`);
      return null;
    }

    this.logger.log(
      `AI classified as module=${mod} risk_tier=${tier} (${result.model}, ${result.elapsedMs}ms)`,
    );
    return {
      module: mod,
      risk_tier: tier as RiskTier,
      matched_rule: `ai:${result.model}`,
      config_id: null,
    };
  }

  /**
   * Load the active project_configs row and extract classifier_rules.
   * Falls back to DEFAULT_RULES if the project has no active config
   * or the stored rules do not pass a minimal shape check.
   */
  private async loadRules(projectId: string): Promise<ClassifierRules> {
    const rows = (await this.ds.query(
      `
      SELECT id, classifier_rules
        FROM public.project_configs
       WHERE project_id = $1
         AND is_active = true
       LIMIT 1
      `,
      [projectId],
    )) as Array<{ id: string; classifier_rules: unknown }>;

    const row = rows[0];
    if (!row) {
      return DEFAULT_RULES;
    }

    const raw = row.classifier_rules;
    if (typeof raw !== 'object' || raw === null) {
      this.logger.warn(
        `project_configs ${row.id} has non-object classifier_rules; using DEFAULT_RULES`,
      );
      return DEFAULT_RULES;
    }
    const r = raw as Record<string, unknown>;
    if (!Array.isArray(r.rules)) {
      return DEFAULT_RULES;
    }
    const validRiskTiers: RiskTier[] = ['low', 'standard', 'high', 'critical'];
    // Module names flow into module_locks.module, audit payloads,
    // logs, and git branch derivatives. Restrict to a sane
    // charset so a malformed config row cannot inject whitespace
    // or control characters downstream. Matches the pattern
    // worker-runtime enforces on branch names: lowercase alpha,
    // digits, and safe path-ish punctuation.
    const MODULE_CHARSET = /^[a-z0-9][a-z0-9/._-]*$/;

    const filteredRules = r.rules
      .filter((x: unknown): x is ClassifierRule => {
        if (typeof x !== 'object' || x === null) return false;
        const rule = x as Record<string, unknown>;
        if (typeof rule.match !== 'string' || rule.match.length === 0) return false;
        if (typeof rule.module !== 'string') return false;
        const m = rule.module.trim();
        if (m.length === 0 || m.length > 64) return false;
        if (!MODULE_CHARSET.test(m)) {
          this.logger.warn(
            `classifier rule module '${m}' has invalid characters — discarded`,
          );
          return false;
        }
        if (
          typeof rule.risk_tier !== 'string' ||
          !validRiskTiers.includes(rule.risk_tier as RiskTier)
        ) {
          this.logger.warn(
            `classifier rule has invalid risk_tier ${String(rule.risk_tier)} — discarded`,
          );
          return false;
        }
        return true;
      })
      .map((x) => ({
        match: x.match,
        module: x.module.trim(),
        risk_tier: x.risk_tier,
      }));

    const defaultModuleRaw =
      typeof r.default_module === 'string' ? r.default_module.trim() : '';
    const defaultModule =
      defaultModuleRaw.length > 0 &&
      defaultModuleRaw.length <= 64 &&
      MODULE_CHARSET.test(defaultModuleRaw)
        ? defaultModuleRaw
        : DEFAULT_RULES.default_module;

    const defaultRiskTier: RiskTier =
      typeof r.default_risk_tier === 'string' &&
      validRiskTiers.includes(r.default_risk_tier as RiskTier)
        ? (r.default_risk_tier as RiskTier)
        : DEFAULT_RULES.default_risk_tier;

    return {
      rules: filteredRules,
      default_module: defaultModule,
      default_risk_tier: defaultRiskTier,
    };
  }
}

function stripJsonFence(s: string): string {
  const trimmed = s.trim();
  const fence = trimmed.match(/^```(?:json)?\s*\n?([\s\S]*?)\n?```$/);
  if (fence && fence[1]) return fence[1].trim();
  return trimmed;
}
