/**
 * Pure helpers for persisting / hydrating the Nexus agent picker
 * selection. Lives in `lib` (not the component file) so it is
 * unit-testable without rendering CopilotPage.
 *
 * The shape mirrors `PersistedSelectedAgent` in
 * `packages/database/prisma/queries/chat-agent-selection.ts` — kept in
 * lockstep manually because the cross-package Zod re-export trips a
 * `version.minor` mismatch between the api/database Zod patches.
 *
 * `instructions` is intentionally omitted from the persisted shape: it
 * is a derived runtime value (template instances re-resolve their
 * instructions on read), and persisting it would risk divergence if the
 * template author edits the prompt.
 */

export interface PersistedSelectedAgent {
	agentId: string;
	name: string;
	vendor?: string;
	modelOverride?: string;
	instanceId?: string;
	description?: string | null;
	workspaceIds?: string[];
	enabledMcpConfigIds?: string[] | null;
	enabledIntegrationIds?: string[];
}

/**
 * Minimal shape of a live `SelectedAgent` chip the picker hands us.
 * Mirrors the interface declared inline in CopilotPage.tsx — keeping
 * this duplicated rather than exporting the original prevents an import
 * cycle through the giant client component.
 */
export interface SelectedAgentLike {
	agentId: string;
	name: string;
	description?: string | null;
	instructions?: string | null;
	enabledMcpConfigIds?: string[] | null;
	workspaceIds?: string[];
	modelOverride?: string;
	vendor?: string;
	instanceId?: string;
	enabledIntegrationIds?: string[];
	enabledIntegrationProviders?: string[];
}

/**
 * Project a live `SelectedAgent` array into the persisted wire shape.
 * Pure — no closures, no side effects. Strips runtime-only fields
 * (`instructions`, `enabledIntegrationProviders`) so the persisted
 * payload only carries identity + reference fields.
 */
export function persistSelectionShape(
	agents: ReadonlyArray<SelectedAgentLike>,
): PersistedSelectedAgent[] {
	return agents.map((a) => ({
		agentId: a.agentId,
		name: a.name,
		...(a.vendor !== undefined ? { vendor: a.vendor } : {}),
		...(a.modelOverride !== undefined
			? { modelOverride: a.modelOverride }
			: {}),
		...(a.instanceId !== undefined ? { instanceId: a.instanceId } : {}),
		...(a.description !== undefined ? { description: a.description } : {}),
		...(a.workspaceIds !== undefined
			? { workspaceIds: a.workspaceIds }
			: {}),
		...(a.enabledMcpConfigIds !== undefined
			? { enabledMcpConfigIds: a.enabledMcpConfigIds }
			: {}),
		...(a.enabledIntegrationIds !== undefined
			? { enabledIntegrationIds: a.enabledIntegrationIds }
			: {}),
	}));
}
