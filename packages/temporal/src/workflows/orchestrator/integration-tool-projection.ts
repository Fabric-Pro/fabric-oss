/**
 * Projection of discovered integrations into synthetic chat tools.
 *
 * Pure string/object shaping — no IO, clock or env access — so it is safe to
 * call from inside the workflow sandbox, and can be unit-tested directly
 * rather than only through a replayed workflow.
 */

import { encodeIntegrationToolRef } from "@repo/utils/integration-tool-ref";

export interface DiscoveredIntegration {
	integrationId: string;
	provider: string;
	description: string;
	confidence: number;
	operations: Array<{
		name: string;
		description: string;
		inputSchema?: Record<string, unknown>;
	}>;
}

export interface IntegrationToolProjection {
	toolName: string;
	/** Provider this tool belongs to; several tools may share one provider. */
	provider: string;
	description: string;
	inputSchema: Record<string, unknown>;
	configId: string;
	confidence: number;
}

/**
 * Build the synthetic tool(s) for one integration.
 *
 * Each operation becomes its OWN tool — `integration__{PROVIDER}__{operation}` —
 * carrying that operation's registry-derived schema directly at the schema
 * root. That binds arguments to their operation by construction, with no JSON
 * Schema combinator anywhere.
 *
 * Combinators are not merely inelegant here, they are rejected: the repository's
 * compatibility contract in `__tests__/fabric-ai-tools-schema.test.ts` records
 * that Anthropic, Gemini and OpenAI strict mode refuse tool input schemas with
 * root `oneOf`/`allOf`/`anyOf` (they are permitted only nested inside
 * `properties`/`items`), and `run-agent-iteration.ts` forwards the schema with
 * those keywords intact — so a root combinator can fail the whole model request
 * before any tool is called.
 *
 * Fallback: activity results recorded before operation schemas were carried have
 * none at all. Those keep the original single `integration__{PROVIDER}` tool
 * with the generic `operation` + `args` envelope, so replayed histories project
 * exactly what they projected before.
 */
export function buildIntegrationToolProjections(
	integration: DiscoveredIntegration,
): IntegrationToolProjection[] {
	const configId = encodeIntegrationToolRef(
		integration.provider,
		integration.integrationId,
	);
	const shared = {
		provider: integration.provider,
		configId,
		confidence: integration.confidence,
	};

	if (!integration.operations.some((op) => op.inputSchema)) {
		const opNames = integration.operations.map((op) => op.name);
		const opList = integration.operations
			.map((op) => `${op.name}: ${op.description}`)
			.join("; ");
		return [
			{
				...shared,
				toolName: `integration__${integration.provider}`,
				description: `${integration.description}. Available operations: ${opList}. Use the 'operation' parameter with one of: ${opNames.join(", ")}`,
				inputSchema: {
					type: "object",
					properties: {
						operation: {
							type: "string",
							description: `The operation to execute. Must be one of: ${opNames.join(", ")}`,
							enum: opNames,
						},
						args: {
							type: "object",
							description: "Arguments for the operation",
						},
					},
					required: ["operation"],
				},
			},
		];
	}

	return integration.operations.map((op) => ({
		...shared,
		toolName: `integration__${integration.provider}__${op.name}`,
		description: `${integration.description} — ${op.name}: ${op.description}`,
		// An operation discovery gave no schema for still gets a tool, so it
		// stays reachable; it simply advertises an open object.
		inputSchema: op.inputSchema ?? { type: "object", properties: {} },
	}));
}

/**
 * Project discovered integrations into synthetic tools.
 *
 * A tenant may have several configurations of the same provider, and they all
 * bind to the same provider-scoped tool names. Discovery returns results in
 * descending confidence, so the FIRST configuration of a provider is the one
 * the user's query actually matched — later rows are skipped entirely, and all
 * of a provider's operation tools bind to that one winning configId. Otherwise
 * execution silently targets a less relevant configuration (for Databricks, a
 * different workspace).
 *
 * Callers must pass results in discovery order; `searchAvailableIntegrations`
 * sorts by descending confidence before applying `limit`.
 */
export function projectIntegrationTools(
	integrations: readonly DiscoveredIntegration[],
): IntegrationToolProjection[] {
	const seenProviders = new Set<string>();
	const projections: IntegrationToolProjection[] = [];

	for (const integration of integrations) {
		if (seenProviders.has(integration.provider)) {
			continue;
		}
		seenProviders.add(integration.provider);
		projections.push(...buildIntegrationToolProjections(integration));
	}

	return projections;
}
