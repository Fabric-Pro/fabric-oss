import type { UseOrchestratorStreamOptions } from "./orchestrator-stream-types";

/** What one send adds to the chat's options (an @template mention, composer uploads). */
export interface OrchestratorSendFields {
	templateInstructions?: string | null;
	templateIntegrationIds?: string[];
	templateMcpConfigIds?: string[];
	templateFabricToolIds?: string[];
	/**
	 * Document IDs freshly uploaded from the composer this send. Merged with
	 * the option-level `attachedDocumentIds` (pre-attached project /
	 * workspace context) — never replacing it.
	 */
	sessionDocumentIds?: string[];
}

/** Template ids are additive: they enable more for this message only. */
function mergeIds(
	configured: string[] | null | undefined,
	template: string[] | undefined,
): string[] | null | undefined {
	const templateIds = template ?? [];
	if (templateIds.length === 0) {
		return configured;
	}
	// Merge and deduplicate
	return [...new Set([...(configured ?? []), ...templateIds])];
}

/**
 * A new Orchestrator turn's request fields beyond its message, history and
 * key: the chat's options with this send's template and composer additions
 * merged in. The stream route takes them as its body; the agent runtime as
 * the run's `forwardedProps`.
 */
export function orchestratorRequestFields(
	options: UseOrchestratorStreamOptions,
	send: OrchestratorSendFields,
) {
	const {
		organizationId,
		executionMode = "balanced",
		enabledMcpConfigIds = null,
		enabledAgentIds = null,
		enabledFabricToolIds = null,
		enabledIntegrationIds = null,
		prioritizedToolIds,
		prioritizedAgentIds,
		prioritizedMcpConfigIds,
		prioritizedIntegrationIds,
		workspaceIds,
		attachedDocumentIds,
		projectId,
		systemPrompt,
		instanceId,
		modelOverride,
		advisorOrigin = false,
		launchWorkspaceId,
		launchFrameId,
		launchSurface,
		surface = "loom-orchestrator",
	} = options;

	// Merge template instructions with system prompt (template takes precedence)
	const effectiveSystemPrompt = send.templateInstructions
		? send.templateInstructions +
			(systemPrompt ? `\n\n---\n\n${systemPrompt}` : "")
		: systemPrompt;

	// Merge pre-attached prop docs with composer-uploaded docs,
	// de-duplicated, so neither channel clobbers the other.
	const mergedAttachedDocumentIds = (() => {
		const merged = [
			...(attachedDocumentIds ?? []),
			...(send.sessionDocumentIds ?? []),
		];
		return merged.length > 0 ? [...new Set(merged)] : undefined;
	})();

	return {
		organizationId,
		executionMode,
		enabledMcpConfigIds: mergeIds(
			enabledMcpConfigIds,
			send.templateMcpConfigIds,
		),
		enabledAgentIds,
		enabledFabricToolIds: mergeIds(
			enabledFabricToolIds,
			send.templateFabricToolIds,
		),
		enabledIntegrationIds: mergeIds(
			enabledIntegrationIds,
			send.templateIntegrationIds,
		),
		prioritizedToolIds,
		prioritizedAgentIds,
		prioritizedMcpConfigIds,
		systemPrompt: effectiveSystemPrompt,
		instanceId,
		modelOverride,
		prioritizedIntegrationIds,
		workspaceIds,
		attachedDocumentIds: mergedAttachedDocumentIds,
		projectId: projectId || undefined,
		// UI surface that started this run. Read by the orchestrator workflow
		// to scope the up-front clarifying question to the standalone Loom
		// chat ("loom-orchestrator"). Without it the workflow sees surface:
		// undefined and never asks.
		surface,
		// Omitted, not false, outside the Advisor.
		advisorOrigin: advisorOrigin ? true : undefined,
		launchWorkspaceId: launchWorkspaceId ?? undefined,
		launchFrameId: launchFrameId ?? undefined,
		launchSurface: launchSurface ?? undefined,
	};
}
