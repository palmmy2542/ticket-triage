/**
 * Tool registry.
 *
 * Adding a tool is one file plus one line here. The autonomy boundary and the
 * dedup rule travel on the descriptor, so a new tool cannot be registered
 * without declaring whether it may run unattended - there is no separate policy
 * table to forget to update.
 */
import { strictJsonSchema } from '../schema';
import type { LlmToolDef, ToolDescriptor, ToolRegistry } from '../types';
import { createCheckServiceStatusTool } from './check-service-status';
import { createGetCustomerAccountTool } from './get-customer-account';
import { createIssueRefundTool } from './issue-refund';
import { createOpenIncidentTool } from './open-incident';
import { createSearchKnowledgeBaseTool } from './search-knowledge-base';
import type { MockToolConfig } from './support';

/**
 * Fail at construction, not at 3am: a side-effecting tool without a
 * server-derived dedup key cannot be made retry-safe.
 *
 * Exported so the test can feed it a deliberately broken descriptor and
 * exercise *this* code. The previous test re-implemented the same `if` inside
 * its own body, so deleting this guard left it green (verified by mutation) -
 * the forcing function was only pretending to be tested.
 */
export function assertRetrySafe(tools: readonly ToolDescriptor[]): void {
  for (const tool of tools) {
    if (tool.sideEffecting && !tool.dedupKey) {
      throw new Error(`Tool ${tool.name} is side-effecting but declares no dedupKey`);
    }
  }
}

export function createToolRegistry(config: MockToolConfig): ToolRegistry {
  const tools: ToolDescriptor[] = [
    createSearchKnowledgeBaseTool(config),
    createGetCustomerAccountTool(config),
    createCheckServiceStatusTool(config),
    createIssueRefundTool(config),
    createOpenIncidentTool(config),
  ];

  assertRetrySafe(tools);

  return new Map(tools.map((tool) => [tool.name, tool]));
}

/** Translate the registry into the provider's function-calling format. */
export function toolDefinitions(registry: ToolRegistry): LlmToolDef[] {
  return [...registry.values()].map((tool) => ({
    name: tool.name,
    description: tool.description,
    parameters: strictJsonSchema(tool.args),
  }));
}
