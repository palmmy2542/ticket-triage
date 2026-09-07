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
