/**
 * Shared fixtures for the IntegrationHandler suites.
 *
 * Both suites drive the handler end-to-end and need the same step/context
 * scaffolding; keeping one copy means a change to `ExecuteStepInput` lands in
 * one place rather than two.
 */
import type { ExecuteStepInput } from "../../../types";
import type { HandlerContext } from "../types";

export const DATABRICKS_CREDS = {
	DATABRICKS_HOST: "https://example.azuredatabricks.net",
	DATABRICKS_CLIENT_ID: "client",
	DATABRICKS_CLIENT_SECRET: "secret",
};

export function buildInput(
	provider: string,
	overrides: {
		description?: string;
		inputs?: Record<string, unknown>;
		integrationId?: string;
	} = {},
): ExecuteStepInput {
	return {
		step: {
			id: "s1",
			description: overrides.description ?? `Use ${provider}`,
			type: "api",
			status: "pending",
			order: 1,
			capability: "integration",
			inputs: overrides.inputs,
		},
		message: "",
		systemPrompt: "",
		variables: {},
		userId: "u1",
		organizationId: "org-1",
		executionId: "exec-1",
		executionMode: "balanced",
		totalSteps: 1,
		stepIndex: 1,
		previousStepResults: [],
		matchedIntegrations: [
			{
				integrationId: overrides.integrationId ?? "int-1",
				name: `${provider} integration`,
				provider,
				description: "",
				confidence: 0.9,
				reason: "",
				capabilities: [],
			},
		],
	};
}

export function buildContext(input: ExecuteStepInput): HandlerContext {
	return { input, variables: {}, toolCalls: [], startTime: Date.now() };
}
