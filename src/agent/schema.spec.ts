import { z } from 'zod';

import {
  DecisionSchema,
  ModelDecisionSchema,
  strictJsonSchema,
  CustomerProfileSchema,
} from './schema';
import { createToolRegistry } from './tools/registry';
import { decisionFixture } from './llm/fake';

describe('decision schema', () => {
  it('accepts a well-formed model decision', () => {
    expect(ModelDecisionSchema.safeParse(decisionFixture()).success).toBe(true);
  });

  it('rejects an unknown urgency', () => {
    const result = ModelDecisionSchema.safeParse(decisionFixture({ urgency: 'urgent' as never }));
    expect(result.success).toBe(false);
  });

  it('rejects extra fields, so a model cannot smuggle in its own claims', () => {
    const result = ModelDecisionSchema.safeParse({ ...decisionFixture(), refund_issued: true });
    expect(result.success).toBe(false);
  });

  it('does not let the model set server-owned fields', () => {
    // requires_human / degraded / tools_used exist only on the server-side schema.
    expect(Object.keys(ModelDecisionSchema.shape)).not.toContain('requires_human');
    expect(Object.keys(DecisionSchema.shape)).toContain('requires_human');
    expect(Object.keys(DecisionSchema.shape)).toContain('tools_used');
  });
});

describe('strictJsonSchema', () => {
  it('builds a strict schema for the decision', () => {
    const json = strictJsonSchema(ModelDecisionSchema) as Record<string, unknown>;
    expect(json['additionalProperties']).toBe(false);
    const required = json['required'] as string[];
    expect(required.sort()).toEqual(Object.keys(ModelDecisionSchema.shape).sort());
  });

  it('builds a strict schema for every registered tool', () => {
    const registry = createToolRegistry({ latencyMs: 0 });
    for (const tool of registry.values()) {
      expect(() => strictJsonSchema(tool.args)).not.toThrow();
    }
  });

  it('fails loudly on an optional property, which OpenAI strict mode rejects', () => {
    // This is the guard that keeps a future tool author from shipping a schema
    // the provider will reject at runtime.
    const bad = z.strictObject({ a: z.string(), b: z.string().optional() });
    expect(() => strictJsonSchema(bad)).toThrow(/non-required properties/);
  });

  it('fails loudly on a non-strict object', () => {
    expect(() => strictJsonSchema(z.object({ a: z.string() }))).toThrow(/additionalProperties/);
  });
});

describe('customer profile schema', () => {
  it('accepts the sample enterprise customer', () => {
    const parsed = CustomerProfileSchema.safeParse({
      id: 'cust_2002',
      plan: 'enterprise',
      tenure_months: 8,
      region: 'asia-southeast-1',
      seats: 45,
      prior_tickets: 0,
    });
    expect(parsed.success).toBe(true);
  });

  it('rejects an unknown plan', () => {
    const parsed = CustomerProfileSchema.safeParse({
      id: 'c',
      plan: 'platinum',
      tenure_months: 1,
      region: 'us-east-1',
      prior_tickets: 0,
    });
    expect(parsed.success).toBe(false);
  });
});
