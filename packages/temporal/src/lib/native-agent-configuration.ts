import { createHash } from "node:crypto";
import type { DeploymentConfig } from "../activities/deployment-execution";
import { readWorkspaceDocumentFilters } from "./workspace-document-selection";

export interface NativeExecutionConfiguration {
	executionMode?: string;
	goal?: string | null;
	maxIterations?: number;
	successCriteria?: unknown;
}
type NativeConfigurationSnapshot = {
	scope: {
		workspaceIds: string[];
		workspaceDocumentFilters: Array<{
			workspaceId: string;
			documentIds: string[];
		}>;
	};
	configuration: {
		instance: Pick<
			DeploymentConfig["instance"],
			"id" | "name" | "description" | "modelOverride"
		> & {
			customInstructions: unknown;
			modelConfig: unknown;
			toolConnections: unknown;
		};
		template: Omit<
			DeploymentConfig["template"],
			"knowledgeSources" | "tools"
		> | null;
		bindings: Array<{ isEnabled: boolean; mcpConfigId: string }>;
		integrations: Array<{
			isEnabled: boolean;
			integrationId: string;
			integrationType: string;
			allowedResources?: unknown;
		}>;
	};
};
/** Effective native configuration only. Live memory, retrieved bytes and tool results
 * are intentionally not configuration provenance or a grounding receipt.
 */
export function nativeConfigurationFromSavedSnapshot(
	snapshot: NativeConfigurationSnapshot,
): DeploymentConfig {
	const { instance, template, bindings, integrations } =
		snapshot.configuration;
	if (!template) throw new Error("Saved native configuration is unavailable");
	return {
		deploymentId: "",
		template: {
			id: template.id,
			name: template.name,
			slug: template.slug,
			displayName: template.displayName,
			description: template.description,
			instructions: template.instructions,
			knowledgeSources: [],
			tools: [],
			suggestedModel: template.suggestedModel,
		},
		instance: {
			id: instance.id,
			name: instance.name,
			description: instance.description,
			customInstructions: instance.customInstructions as Record<
				string,
				unknown
			> | null,
			modelOverride: instance.modelOverride,
			modelConfig: instance.modelConfig as Record<string, unknown> | null,
		},
		integrationConfigurations: integrations
			.filter((binding) => binding.isEnabled)
			.map((binding) => ({
				integrationId: binding.integrationId,
				integrationType: binding.integrationType,
				allowedResources: binding.allowedResources ?? undefined,
			})),
		mcpConfigIds: bindings
			.filter((binding) => binding.isEnabled)
			.map((binding) => binding.mcpConfigId),
		toolConnections:
			(instance.toolConnections as Record<
				string,
				Record<string, unknown>
			>) || {},
		workspaceIds: [...snapshot.scope.workspaceIds],
		workspaceDocumentFilters: readWorkspaceDocumentFilters(
			snapshot.scope.workspaceDocumentFilters,
			snapshot.scope.workspaceIds,
		),
	};
}
function canonical(
	value: unknown,
	budget: { nodes: number },
	depth = 0,
): unknown {
	if (++budget.nodes > 20000 || depth > 32)
		throw new Error("Native configuration exceeds fingerprint limits");
	if (Array.isArray(value))
		return value.map((item) => canonical(item, budget, depth + 1));
	if (value && typeof value === "object")
		return Object.fromEntries(
			Object.entries(value)
				.sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0))
				.map(([key, item]) => [
					key,
					canonical(item, budget, depth + 1),
				]),
		);
	return value;
}
export function nativeAgentConfigurationFingerprint(
	config: DeploymentConfig,
	execution: NativeExecutionConfiguration,
): string {
	// The database's enabled bindings are unordered sets. Normalize only the
	// fingerprint; never reorder/filter arrays passed into business execution.
	const budget = { nodes: 0 };
	const integrations = config.integrationConfigurations
		.map((binding) => canonical(binding, budget))
		.sort((a, b) =>
			(JSON.stringify(a) ?? "") < (JSON.stringify(b) ?? "")
				? -1
				: (JSON.stringify(a) ?? "") > (JSON.stringify(b) ?? "")
					? 1
					: 0,
		);
	const selected = {
		version: "native-agent-configuration-v1",
		execution: {
			executionMode: execution.executionMode ?? null,
			goal: execution.goal ?? null,
			maxIterations: execution.maxIterations ?? null,
			successCriteria: execution.successCriteria ?? null,
		},
		template: config.template,
		instance: config.instance,
		integrationConfigurations: integrations,
		mcpConfigIds: [...config.mcpConfigIds].sort(),
		toolConnections: config.toolConnections,
		workspaceIds: config.workspaceIds,
		workspaceDocumentFilters: config.workspaceDocumentFilters ?? [],
	};
	return createHash("sha256")
		.update(JSON.stringify(canonical(selected, budget)))
		.digest("hex");
}
