import { z } from 'zod';

const boolFromString = z
  .union([z.boolean(), z.enum(['true', 'false', '1', '0'])])
  .transform((v) => (typeof v === 'boolean' ? v : v === 'true' || v === '1'));

export const envSchema = z
  .object({
    NODE_ENV: z.enum(['development', 'test', 'production']).default('development'),
    PORT: z.coerce.number().default(3000),
    LOG_LEVEL: z.enum(['fatal', 'error', 'warn', 'info', 'debug', 'trace']).default('info'),
    DATABASE_URL: z.string().url(),
    OPENAI_API_KEY: z.string().optional(),
    OPENAI_MODEL: z.string().default('gpt-4.1-mini'),
    LLM_TIMEOUT_MS: z.coerce.number().default(30000),
    FAKE_LLM: boolFromString.default(false),
    MAX_AGENT_ITERATIONS: z.coerce.number().default(6),
    MAX_SIDE_EFFECTS_PER_TURN: z.coerce.number().default(4),
    /** Simulated latency of the mocked downstream tools. Tests set 0. */
    MOCK_TOOL_LATENCY_MS: z.coerce.number().default(250),
    /**
     * How often the reconciliation pass runs. `0` disables the timer; the pass
     * stays callable, which is how the tests drive it.
     */
    RECONCILE_INTERVAL_MS: z.coerce.number().min(0).default(60_000),
    /**
     * Safety factor over the DERIVED worst-case turn duration
     * (LLM_TIMEOUT_MS x attempts-per-call x MAX_AGENT_ITERATIONS). The
     * threshold is not a free-standing number: reconciling a turn that is still
     * legitimately running is worse than the leak it fixes, so this multiplies
     * a bound that already exists rather than replacing it. Minimum 1 - below
     * that the threshold is shorter than a legal turn by construction.
     */
    RECONCILE_STALE_MULTIPLIER: z.coerce.number().min(1).default(2),
    /** Rows per table per sweep. Bounds one pass's lock and pool footprint. */
    RECONCILE_BATCH_SIZE: z.coerce.number().int().min(1).default(100),
    /**
     * How long a TERMINAL `idempotency_keys` row is kept. 24h matches what
     * payment APIs promise for an idempotency key; past it the table is a
     * liability, since nothing else ever removes a row.
     */
    IDEMPOTENCY_RETENTION_MS: z.coerce.number().min(0).default(86_400_000),
  })
  .superRefine((val, ctx) => {
    if (!val.FAKE_LLM && val.NODE_ENV !== 'test' && !val.OPENAI_API_KEY) {
      ctx.addIssue({
        code: 'custom',
        path: ['OPENAI_API_KEY'],
        message: 'OPENAI_API_KEY is required when FAKE_LLM is false and NODE_ENV is not "test"',
      });
    }
  });

export type Env = z.infer<typeof envSchema>;

/**
 * Parses a raw environment object against the schema, throwing a single
 * readable, aggregated error listing every missing/invalid variable.
 * Pure function with no side effects — safe to unit test directly with
 * an injected object, without touching process.env or requiring a DB.
 */
export function parseEnv(raw: Record<string, string | undefined>): Env {
  const result = envSchema.safeParse(raw);
  if (!result.success) {
    const issues = result.error.issues
      .map((issue) => `  - ${issue.path.join('.') || '(root)'}: ${issue.message}`)
      .join('\n');
    throw new Error(`Invalid environment configuration:\n${issues}`);
  }
  return result.data;
}
