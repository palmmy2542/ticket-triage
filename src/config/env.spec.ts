import { parseEnv } from './env.schema';

const validBase = {
  DATABASE_URL: 'postgresql://triage:triage@localhost:5433/triage?schema=public',
  FAKE_LLM: 'true',
};

describe('parseEnv', () => {
  it('parses a valid env object and applies defaults', () => {
    const result = parseEnv(validBase);
    expect(result.NODE_ENV).toBe('development');
    expect(result.PORT).toBe(3000);
    expect(result.LOG_LEVEL).toBe('info');
    expect(result.OPENAI_MODEL).toBe('gpt-4.1-mini');
    expect(result.LLM_TIMEOUT_MS).toBe(30000);
    expect(result.FAKE_LLM).toBe(true);
    expect(result.MAX_AGENT_ITERATIONS).toBe(6);
    expect(result.MAX_SIDE_EFFECTS_PER_TURN).toBe(4);
    expect(result.RECONCILE_INTERVAL_MS).toBe(60_000);
    expect(result.RECONCILE_STALE_MULTIPLIER).toBe(2);
    expect(result.RECONCILE_BATCH_SIZE).toBe(100);
    expect(result.IDEMPOTENCY_RETENTION_MS).toBe(86_400_000);
  });

  it('accepts RECONCILE_INTERVAL_MS=0 as "run the pass only when called"', () => {
    expect(parseEnv({ ...validBase, RECONCILE_INTERVAL_MS: '0' }).RECONCILE_INTERVAL_MS).toBe(0);
  });

  it('refuses a stale multiplier below 1', () => {
    // Below 1 the threshold is shorter than a legitimate turn BY CONSTRUCTION,
    // so the reconciler would fail-safe running turns and re-drive refunds that
    // are still in flight. Rejected at boot rather than discovered in
    // production.
    expect(() => parseEnv({ ...validBase, RECONCILE_STALE_MULTIPLIER: '0.5' })).toThrow(
      /RECONCILE_STALE_MULTIPLIER/,
    );
  });

  it('refuses a batch size below 1, which would make the sweep a no-op', () => {
    expect(() => parseEnv({ ...validBase, RECONCILE_BATCH_SIZE: '0' })).toThrow(
      /RECONCILE_BATCH_SIZE/,
    );
  });

  it('fails when DATABASE_URL is missing', () => {
    const { DATABASE_URL: _DATABASE_URL, ...rest } = validBase;
    expect(() => parseEnv(rest)).toThrow(/DATABASE_URL/);
  });

  it('fails when FAKE_LLM is false, NODE_ENV is production, and no OPENAI_API_KEY is set', () => {
    expect(() =>
      parseEnv({
        ...validBase,
        FAKE_LLM: 'false',
        NODE_ENV: 'production',
      }),
    ).toThrow(/OPENAI_API_KEY/);
  });

  it('succeeds when FAKE_LLM is false but NODE_ENV is test, even without a key', () => {
    const result = parseEnv({
      ...validBase,
      FAKE_LLM: 'false',
      NODE_ENV: 'test',
    });
    expect(result.FAKE_LLM).toBe(false);
  });

  it('succeeds when FAKE_LLM is false and an OPENAI_API_KEY is provided', () => {
    const result = parseEnv({
      ...validBase,
      FAKE_LLM: 'false',
      NODE_ENV: 'production',
      OPENAI_API_KEY: 'sk-test',
    });
    expect(result.OPENAI_API_KEY).toBe('sk-test');
  });
});
