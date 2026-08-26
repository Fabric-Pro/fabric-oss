/**
 * Chat Agent Selection Queries
 *
 * Persists the "last successfully sent" Nexus agent picker selection per
 * (user × organization context) pair so reopening Nexus restores the
 * previous selection.
 *
 * Mirrors `orchestrator-preferences.ts` exactly:
 *   - empty-string sentinel for personal scope (Prisma compound unique
 *     does not handle null cleanly)
 *   - composite unique on (userId, organizationId)
 *   - tenant XOR isolation enforced at the procedure layer via
 *     `tenantProtectedProcedure`, not via DB RLS (`user_chat_agent_selection`
 *     intentionally tracks `user_orchestrator_preferences` and is excluded
 *     from `apply-rls-direct.ts`'s table list)
 *
 * Naming is deliberately generic (`chatAgentSelection`, not
 * `nexusAgentSelection`) so a future Loom picker can plug in without a
 * rename — Decision 1 in `fabric/specs/2026-05-09-persistent-agent-selection`.
 */

import { z } from "zod";
import { db } from "../client";

/**
 * Persisted shape of a single Nexus chip. Mirrors `SelectedAgent` in
 * `apps/web/modules/saas/ai/components/CopilotPage.tsx`.
 *
 * Polymorphism is encoded in `agentId`:
 *   - "<agentId>"               — real Agent row (USER / ORGANIZATION / SYSTEM)
 *   - "model:<canonicalName>"   — model-as-agent shortcut
 *   - "template-instance:<id>"  — instance of an agent template
 *   - "history:<slug>"          — reference to a history entry
 *
 * The validator (server-side, in `@repo/api`) uses the prefix to decide
 * which existence check to run.
 *
 * `instructions` is intentionally NOT persisted: it is a derived runtime
 * value (template instances re-resolve their instructions on read), and
 * persisting it would risk divergence if the template author edits the
 * prompt.
 */
export const PersistedSelectedAgentSchema = z.object({
	agentId: z.string().min(1),
	name: z.string().min(1),
	vendor: z.string().optional(),
	modelOverride: z.string().optional(),
	instanceId: z.string().optional(),
	// Auxiliary fields used by the picker but not validated by the server.
	// Optional so future shape additions are non-breaking when `version` is
	// unchanged.
	description: z.string().nullable().optional(),
	workspaceIds: z.array(z.string()).optional(),
	enabledMcpConfigIds: z.array(z.string()).nullable().optional(),
	enabledIntegrationIds: z.array(z.string()).optional(),
});

export type PersistedSelectedAgent = z.infer<
	typeof PersistedSelectedAgentSchema
>;

export const PersistedSelectionSchema = z.array(PersistedSelectedAgentSchema);

export type PersistedSelection = z.infer<typeof PersistedSelectionSchema>;

/**
 * Forward-compat marker for the persisted JSON shape. Bumped when
 * `PersistedSelectedAgentSchema` gains a non-additive change. The read-side
 * validator drops entries whose `version` it cannot interpret.
 *
 * When this constant changes, also update the `version` default in
 * `prisma/schema.prisma` model `UserChatAgentSelection` and add migration
 * notes for older rows.
 */
export const CURRENT_CHAT_AGENT_SELECTION_VERSION = 1;

/**
 * Result of `getChatAgentSelection` — `null` when no row exists for this
 * (user × org). Otherwise returns the raw stored array (caller is
 * responsible for running the server-side validator before exposing chips
 * to the user).
 */
export interface ChatAgentSelectionRow {
	version: number;
	selectedAgents: PersistedSelectedAgent[];
}

// Helper: normalize org id to "" sentinel, matching orchestrator-preferences.
function normalizeOrgId(organizationId?: string | null): string {
	return organizationId || "";
}

/**
 * Get persisted Nexus agent selection for (userId, organizationId).
 * Returns `null` when no row exists.
 *
 * The returned `selectedAgents` is the raw stored value — the caller MUST
 * run the server-side validator (in `@repo/api`) to drop invalid entries
 * before returning chips to the client (Decision 7 / spec §5.4).
 *
 * @param userId         The user ID
 * @param organizationId Organization ID (null/undefined for personal account)
 */
export async function getChatAgentSelection(
	userId: string,
	organizationId?: string | null,
): Promise<ChatAgentSelectionRow | null> {
	const row = await db.userChatAgentSelection.findUnique({
		where: {
			userId_organizationId: {
				userId,
				organizationId: normalizeOrgId(organizationId),
			},
		},
		select: {
			version: true,
			selectedAgents: true,
		},
	});

	if (!row) {
		return null;
	}

	// `selectedAgents` is `Prisma.JsonValue`; trust the upsert path to write
	// arrays only, but defensively coerce so a legacy hand-edited row cannot
	// crash the read.
	const raw = Array.isArray(row.selectedAgents) ? row.selectedAgents : [];

	// Best-effort parse of each entry; entries that fail Zod parsing fall
	// out here. The server-side validator does the *resolution* drop rules
	// (deleted agent, INACTIVE, missing provider, cross-tenant) on top of
	// these surviving entries.
	const parsed: PersistedSelectedAgent[] = [];
	for (const entry of raw) {
		const result = PersistedSelectedAgentSchema.safeParse(entry);
		if (result.success) {
			parsed.push(result.data);
		}
	}

	return {
		version: row.version,
		selectedAgents: parsed,
	};
}

/**
 * Upsert (idempotent) the persisted Nexus agent selection for
 * (userId, organizationId).
 *
 * The caller MUST have already validated the input shape via
 * `PersistedSelectionSchema` at the procedure boundary. This function
 * trusts its input.
 *
 * Re-sending the same array is a no-op at the value level — only
 * `updatedAt` ticks. Rapid double-sends are safe.
 *
 * @param userId         The user ID
 * @param payload        The selection to persist
 * @param organizationId Organization ID (null/undefined for personal account)
 */
export async function upsertChatAgentSelection(
	userId: string,
	payload: { selectedAgents: PersistedSelectedAgent[] },
	organizationId?: string | null,
): Promise<void> {
	const orgId = normalizeOrgId(organizationId);
	await db.userChatAgentSelection.upsert({
		where: {
			userId_organizationId: {
				userId,
				organizationId: orgId,
			},
		},
		create: {
			userId,
			organizationId: orgId,
			version: CURRENT_CHAT_AGENT_SELECTION_VERSION,
			selectedAgents: payload.selectedAgents,
		},
		update: {
			version: CURRENT_CHAT_AGENT_SELECTION_VERSION,
			selectedAgents: payload.selectedAgents,
		},
	});
}

/**
 * Delete the persisted selection for a specific (user × org) context.
 *
 * TENANT ISOLATION (XOR Pattern):
 *   - Pass organizationId: null  for personal context
 *   - Pass organizationId: "..." for organization context
 *
 * Required when the server-side validator drops every entry — clearing the
 * row makes the next load take the first-run (empty picker) path
 * (Decision 7 / spec §5.2).
 *
 * Errors are swallowed (matches `deleteOrchestratorPreferences`) so the
 * fire-and-forget cleanup path can never break a working read.
 */
export async function deleteChatAgentSelection(
	userId: string,
	organizationId: string | null,
): Promise<void> {
	await db.userChatAgentSelection
		.delete({
			where: {
				userId_organizationId: {
					userId,
					organizationId: normalizeOrgId(organizationId),
				},
			},
		})
		.catch(() => {
			// Ignore if row does not exist (idempotent delete).
		});
}
