/**
 * Orchestrator Preferences Queries
 *
 * Database queries for managing user orchestrator preferences.
 * These preferences control which MCP servers, agents, and workspaces
 * are enabled for the user in the Fabric AI orchestrator.
 *
 * Supports both personal accounts (organizationId = empty string "") and
 * organization-scoped preferences (organizationId set).
 *
 * Note: We use empty string "" instead of null for personal accounts
 * because Prisma compound unique doesn't handle null values well.
 */

import { db } from "../client";

export type AutonomyLevel = "CONSERVATIVE" | "BALANCED" | "AUTONOMOUS";

/**
 * Loom (Fabric Agent) chat mode. Mirrors the three top-level mode tabs in
 * `apps/web/app/(saas)/app/agents/fabric-ai/page.tsx`. Stored as a string
 * (not a Postgres enum) so adding a future mode does not require a coupled
 * migration; the read path validates against this closed set and falls back
 * to "orchestrator" on anything unknown.
 */
export type ChatMode = "direct" | "orchestrator" | "research";

/**
 * Loom (Fabric Agent) reasoning effort. Mirrors the four reasoning-mode
 * pills in the same file. Same forward-compat rationale as `ChatMode`.
 */
export type ReasoningMode = "lite" | "balanced" | "deep" | "planner";

/**
 * How much of the unified agent interface is exposed. A presentation setting,
 * not a capability gate — `ChatMode` still decides which engine runs, and any
 * user can switch to advanced. Same forward-compat rationale as `ChatMode`;
 * defaults to "simple" so a first-time user meets the reduced surface.
 */
export type UiMode = "simple" | "advanced";

const CHAT_MODES: readonly ChatMode[] = ["direct", "orchestrator", "research"];
const REASONING_MODES: readonly ReasoningMode[] = [
	"lite",
	"balanced",
	"deep",
	"planner",
];
const UI_MODES: readonly UiMode[] = ["simple", "advanced"];

function coerceChatMode(value: unknown): ChatMode {
	return typeof value === "string" && CHAT_MODES.includes(value as ChatMode)
		? (value as ChatMode)
		: "orchestrator";
}

function coerceReasoningMode(value: unknown): ReasoningMode {
	return typeof value === "string" &&
		REASONING_MODES.includes(value as ReasoningMode)
		? (value as ReasoningMode)
		: "balanced";
}

function coerceUiMode(value: unknown): UiMode {
	return typeof value === "string" && UI_MODES.includes(value as UiMode)
		? (value as UiMode)
		: "simple";
}

export interface OrchestratorPreferences {
	enabledMcpConfigIds: string[];
	enabledAgentIds: string[];
	enabledWorkspaceIds: string[];
	autonomyLevel: AutonomyLevel;
	chatMode: ChatMode;
	reasoningMode: ReasoningMode;
	uiMode: UiMode;
}

// Helper to normalize organizationId for compound unique queries
// Prisma compound unique doesn't handle null well, so we use empty string for personal accounts
function normalizeOrgId(organizationId?: string | null): string {
	return organizationId || "";
}

/**
 * Get orchestrator preferences for a user × organization context.
 * Returns null if no preferences exist yet.
 *
 * Per-org isolation: each user has independent prefs per org they're in.
 * Personal context maps to `organizationId = ""` (the empty-string sentinel
 * used by `normalizeOrgId`). Mirrors the chat-agent-selection isolation
 * model so the same user can have different Loom mode / reasoning prefs
 * across different orgs.
 *
 * BACKWARD-COMPAT FALLBACK (PR #822): before this PR the procedure layer
 * never passed `organizationId`, so every (user × org) write went into the
 * `organizationId = ""` row. After the cutover, an org-context read for a
 * pre-existing user finds no per-org row and would otherwise reset their
 * prefs. As a transition aid: when a per-org read misses AND the caller is
 * in an org context, fall back to the user's "" row so existing prefs
 * survive the cutover. The next *write* in that org context creates the
 * per-org row, so the fallback is self-healing per (user × org) pair on
 * first interaction. Personal-context reads (organizationId = "") never
 * trigger the fallback because the primary lookup IS the "" row.
 *
 * @param userId - The user ID
 * @param organizationId - Organization ID (null/undefined for personal account)
 */
export async function getOrchestratorPreferences(
	userId: string,
	organizationId?: string | null,
): Promise<OrchestratorPreferences | null> {
	const orgId = normalizeOrgId(organizationId);
	const prefs = await db.userOrchestratorPreferences.findUnique({
		where: {
			userId_organizationId: { userId, organizationId: orgId },
		},
	});

	const target = await (async () => {
		if (prefs) {
			return prefs;
		}
		// One-time transition fallback for the per-org cutover. Skip for
		// personal context (orgId === "") — the primary lookup already
		// hit that row. See block comment above for the rationale.
		if (!orgId) {
			return null;
		}
		return db.userOrchestratorPreferences.findUnique({
			where: {
				userId_organizationId: { userId, organizationId: "" },
			},
		});
	})();

	if (!target) {
		return null;
	}

	return {
		enabledMcpConfigIds: target.enabledMcpConfigIds as string[],
		enabledAgentIds: target.enabledAgentIds as string[],
		enabledWorkspaceIds: target.enabledWorkspaceIds as string[],
		autonomyLevel: (target.autonomyLevel as AutonomyLevel) ?? "BALANCED",
		chatMode: coerceChatMode(target.chatMode),
		reasoningMode: coerceReasoningMode(target.reasoningMode),
		uiMode: coerceUiMode(target.uiMode),
	};
}

/**
 * Upsert orchestrator preferences for a user.
 * Creates new preferences if they don't exist, updates if they do.
 *
 * @param userId - The user ID
 * @param preferences - The preferences to set
 * @param organizationId - Organization ID (null for personal account)
 */
export async function upsertOrchestratorPreferences(
	userId: string,
	preferences: Partial<OrchestratorPreferences>,
	organizationId?: string | null,
): Promise<OrchestratorPreferences> {
	const prefs = await db.userOrchestratorPreferences.upsert({
		where: {
			userId_organizationId: {
				userId,
				organizationId: normalizeOrgId(organizationId),
			},
		},
		create: {
			userId,
			organizationId: normalizeOrgId(organizationId), // "" for personal, orgId for org
			enabledMcpConfigIds: preferences.enabledMcpConfigIds ?? [],
			enabledAgentIds: preferences.enabledAgentIds ?? [],
			enabledWorkspaceIds: preferences.enabledWorkspaceIds ?? [],
			autonomyLevel: preferences.autonomyLevel ?? "BALANCED",
			chatMode: preferences.chatMode ?? "orchestrator",
			reasoningMode: preferences.reasoningMode ?? "balanced",
			uiMode: preferences.uiMode ?? "simple",
		},
		update: {
			...(preferences.enabledMcpConfigIds !== undefined && {
				enabledMcpConfigIds: preferences.enabledMcpConfigIds,
			}),
			...(preferences.enabledAgentIds !== undefined && {
				enabledAgentIds: preferences.enabledAgentIds,
			}),
			...(preferences.enabledWorkspaceIds !== undefined && {
				enabledWorkspaceIds: preferences.enabledWorkspaceIds,
			}),
			...(preferences.autonomyLevel !== undefined && {
				autonomyLevel: preferences.autonomyLevel,
			}),
			...(preferences.chatMode !== undefined && {
				chatMode: preferences.chatMode,
			}),
			...(preferences.uiMode !== undefined && {
				uiMode: preferences.uiMode,
			}),
			...(preferences.reasoningMode !== undefined && {
				reasoningMode: preferences.reasoningMode,
			}),
		},
	});

	return {
		enabledMcpConfigIds: prefs.enabledMcpConfigIds as string[],
		enabledAgentIds: prefs.enabledAgentIds as string[],
		enabledWorkspaceIds: prefs.enabledWorkspaceIds as string[],
		autonomyLevel: prefs.autonomyLevel as AutonomyLevel,
		chatMode: coerceChatMode(prefs.chatMode),
		reasoningMode: coerceReasoningMode(prefs.reasoningMode),
		uiMode: coerceUiMode(prefs.uiMode),
	};
}

/**
 * Update only the enabled MCP config IDs for a user.
 */
export async function updateEnabledMcpConfigs(
	userId: string,
	enabledMcpConfigIds: string[],
	organizationId?: string | null,
): Promise<void> {
	await db.userOrchestratorPreferences.upsert({
		where: {
			userId_organizationId: {
				userId,
				organizationId: normalizeOrgId(organizationId),
			},
		},
		create: {
			userId,
			organizationId: normalizeOrgId(organizationId),
			enabledMcpConfigIds,
		},
		update: {
			enabledMcpConfigIds,
		},
	});
}

/**
 * Update only the enabled agent IDs for a user.
 */
export async function updateEnabledAgents(
	userId: string,
	enabledAgentIds: string[],
	organizationId?: string | null,
): Promise<void> {
	await db.userOrchestratorPreferences.upsert({
		where: {
			userId_organizationId: {
				userId,
				organizationId: normalizeOrgId(organizationId),
			},
		},
		create: {
			userId,
			organizationId: normalizeOrgId(organizationId),
			enabledAgentIds,
		},
		update: {
			enabledAgentIds,
		},
	});
}

/**
 * Update only the enabled workspace IDs for a user.
 */
export async function updateEnabledWorkspaces(
	userId: string,
	enabledWorkspaceIds: string[],
	organizationId?: string | null,
): Promise<void> {
	await db.userOrchestratorPreferences.upsert({
		where: {
			userId_organizationId: {
				userId,
				organizationId: normalizeOrgId(organizationId),
			},
		},
		create: {
			userId,
			organizationId: normalizeOrgId(organizationId),
			enabledWorkspaceIds,
		},
		update: {
			enabledWorkspaceIds,
		},
	});
}

/**
 * Delete orchestrator preferences for a specific context.
 *
 * TENANT ISOLATION (XOR Pattern):
 * - Pass organizationId: null for personal context
 * - Pass organizationId: "org_xxx" for organization context
 *
 * This function REQUIRES explicit context to prevent accidental
 * cross-context deletion. Personal and org preferences are isolated.
 */
export async function deleteOrchestratorPreferences(
	userId: string,
	organizationId: string | null,
): Promise<void> {
	await db.userOrchestratorPreferences
		.delete({
			where: {
				userId_organizationId: {
					userId,
					organizationId: normalizeOrgId(organizationId),
				},
			},
		})
		.catch(() => {
			// Ignore if not found
		});
}
