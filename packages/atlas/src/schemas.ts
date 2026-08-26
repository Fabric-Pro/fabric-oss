/**
 * Zod schemas shared between the API procedures and the facade. Kept separate
 * from `service.ts` so the (pure) input contracts can be reused without
 * importing server-only code.
 */
import { z } from "zod";

export const graphModeSchema = z.enum(["TECHNICAL", "BUSINESS"]);

/** `null` = explicit personal/legacy-repo context; `undefined` = session fallback. */
const tenantInput = {
	organizationId: z.string().nullable().optional(),
};

/** Identifies which connected repo a request targets; null = project's legacy/default repo. */
const repoSelector = {
	repositoryIntegrationId: z.string().nullable().optional(),
};

export const listRepositoriesInputSchema = z.object({
	projectId: z.string().min(1),
	...tenantInput,
});

export const atlasStatusInputSchema = z.object({
	projectId: z.string().min(1),
	...repoSelector,
	...tenantInput,
});

export const atlasGraphInputSchema = z.object({
	projectId: z.string().min(1),
	mode: graphModeSchema.default("BUSINESS"),
	/** Include soft-deleted (user-removed) edges — for an edited-connections review. */
	includeDeleted: z.boolean().optional().default(false),
	...repoSelector,
	...tenantInput,
});

export const atlasNodeInputSchema = z.object({
	projectId: z.string().min(1),
	analysisId: z.string().min(1),
	mode: graphModeSchema.default("BUSINESS"),
	key: z.string().min(1),
	...tenantInput,
});

export const analyzeInputSchema = z.object({
	projectId: z.string().min(1),
	/**
	 * "From fresh" (B5): re-derive descriptions/categories independently of any
	 * saved user overrides (they are not fed to the AI and are not overlaid on
	 * the result). Default false — the standard run respects user overrides.
	 */
	fresh: z.boolean().optional().default(false),
	...repoSelector,
	...tenantInput,
});

// ── Node overrides (stable user edits) + branch switcher ─────────────────────

const NODE_DESCRIPTION_MAX = 20_000;
const NODE_CATEGORY_MAX = 60;
const MAX_PINNED_BRANCHES = 50;
const BRANCH_NAME_MAX = 255;

/**
 * Edit a node's stable user override (T6 `updateNode`). At least one of
 * `userDescription` / `userCategory` must be present; `null` clears that field.
 */
export const updateNodeInputSchema = z
	.object({
		projectId: z.string().min(1),
		analysisId: z.string().min(1),
		mode: graphModeSchema.default("BUSINESS"),
		key: z.string().min(1),
		userDescription: z
			.string()
			.max(NODE_DESCRIPTION_MAX)
			.nullable()
			.optional(),
		userCategory: z
			.string()
			.trim()
			.max(NODE_CATEGORY_MAX)
			.nullable()
			.optional(),
		...tenantInput,
	})
	.refine(
		(v) => v.userDescription !== undefined || v.userCategory !== undefined,
		{ message: "Provide a description and/or a category to save." },
	);

/** Read a node's override edit history (T6 `getNodeHistory`). */
export const getNodeHistoryInputSchema = z.object({
	projectId: z.string().min(1),
	analysisId: z.string().min(1),
	mode: graphModeSchema.default("BUSINESS"),
	key: z.string().min(1),
	...tenantInput,
});

/** List the connected repo's branches (T6 `listBranches`). */
export const listBranchesInputSchema = z.object({
	projectId: z.string().min(1),
	...repoSelector,
	...tenantInput,
});

/** Replace the pinned-branches set for a repo (T6 `setPinnedBranches`). */
export const setPinnedBranchesInputSchema = z.object({
	projectId: z.string().min(1),
	repositoryIntegrationId: z.string().min(1),
	branches: z
		.array(z.string().trim().min(1).max(BRANCH_NAME_MAX))
		.max(MAX_PINNED_BRANCHES),
	...tenantInput,
});

/** Cancel the in-flight analysis for a project's (optionally specific) repo. */
export const cancelAnalysisInputSchema = z.object({
	projectId: z.string().min(1),
	...repoSelector,
	...tenantInput,
});

/** On-demand "Describe with AI" — node schema + optional live instructions. */
export const describeNodeInputSchema = atlasNodeInputSchema.extend({
	instructions: z.string().optional(),
});

export const atlasChatMessageSchema = z.object({
	role: z.enum(["user", "assistant", "system"]),
	content: z.string(),
});

export const atlasChatInputSchema = z.object({
	projectId: z.string().min(1),
	messages: z.array(atlasChatMessageSchema).min(1),
	mode: graphModeSchema.default("BUSINESS"),
	focusNodeKey: z.string().optional(),
	conversationId: z.string().optional(),
	model: z.string().optional(),
	...repoSelector,
	...tenantInput,
});

// ── Analysis history ─────────────────────────────────────────────────────────

export const atlasHistoryInputSchema = z.object({
	projectId: z.string().min(1),
	limit: z.number().int().min(1).max(100).default(20),
	// Offset-based pagination: the panel loads a small first page and fetches
	// further pages on demand ("Show more"), so a long-lived project's older
	// runs stay reachable instead of being truncated at the first `limit`.
	offset: z.number().int().min(0).default(0),
	...repoSelector,
	...tenantInput,
});

// ── Persistent chat conversations ────────────────────────────────────────────

export const chatVisibilitySchema = z.enum(["PRIVATE", "SHARED"]);

/**
 * Conversations are mode-independent: one shared history per project+repo
 * (zod strips a stale client's `mode` key, so old payloads stay harmless).
 */
export const listConversationsInputSchema = z.object({
	projectId: z.string().min(1),
	// Offset-based pagination for the conversation history view (newest first).
	// The default page is small so the chat panel never loads a long-lived
	// project's entire history up front.
	limit: z.number().int().min(1).max(100).default(20),
	offset: z.number().int().min(0).default(0),
	// System-map conversations (project-wide, spanning the selected repos). When
	// true, repositoryIntegrationId is ignored and only isSystemScope rows list.
	isSystemScope: z.boolean().optional(),
	...repoSelector,
	...tenantInput,
});

export const createConversationInputSchema = z.object({
	projectId: z.string().min(1),
	title: z.string().min(1).max(200).optional(),
	visibility: chatVisibilitySchema.optional(),
	/** Create a System-map (multi-repo) conversation instead of a per-repo one. */
	isSystemScope: z.boolean().optional(),
	...repoSelector,
	...tenantInput,
});

export const getConversationInputSchema = z.object({
	projectId: z.string().min(1),
	conversationId: z.string().min(1),
	...tenantInput,
});

export const updateConversationInputSchema = z
	.object({
		projectId: z.string().min(1),
		conversationId: z.string().min(1),
		title: z.string().min(1).max(200).optional(),
		visibility: chatVisibilitySchema.optional(),
		...tenantInput,
	})
	.refine((v) => v.title !== undefined || v.visibility !== undefined, {
		message: "Provide a new title and/or visibility.",
	});

export const deleteConversationInputSchema = z.object({
	projectId: z.string().min(1),
	conversationId: z.string().min(1),
	...tenantInput,
});

// ── Shared node positions (draggable layout) ─────────────────────────────────

export const nodeLayoutPositionSchema = z.object({
	key: z.string().min(1),
	x: z.number(),
	y: z.number(),
});

export const saveLayoutInputSchema = z.object({
	projectId: z.string().min(1),
	mode: graphModeSchema.default("BUSINESS"),
	positions: z.array(nodeLayoutPositionSchema).min(1).max(5000),
	...repoSelector,
	...tenantInput,
});

// ── Multi-repo "System map" ──────────────────────────────────────────────────

/** One or more connected repos to combine in the System map (≥1). */
const MAX_SYSTEM_REPOS = 25;
const systemRepoSelector = {
	repositoryIntegrationIds: z
		.array(z.string().min(1))
		.min(1)
		.max(MAX_SYSTEM_REPOS),
};

/** The merged multi-repo graph for a lens. */
export const systemGraphInputSchema = z.object({
	projectId: z.string().min(1),
	mode: graphModeSchema.default("BUSINESS"),
	/** Include soft-deleted (user-removed) cross/intra edges — for review. */
	includeDeleted: z.boolean().optional().default(false),
	...systemRepoSelector,
	...tenantInput,
});

// ── System-map shared node positions (multi-repo draggable layout) ───────────

/** One saved System-map node position (the RF node id + its coordinates). */
export const systemLayoutPositionSchema = z.object({
	id: z.string().min(1),
	x: z.number(),
	y: z.number(),
});

/** Persist shared System-map node positions for a (project, mode). */
export const saveSystemLayoutInputSchema = z.object({
	projectId: z.string().min(1),
	mode: graphModeSchema.default("BUSINESS"),
	positions: z.array(systemLayoutPositionSchema).min(1).max(5000),
	...tenantInput,
});

// ── Edge overrides (editable / manual / soft-deletable connections) ──────────

/**
 * Identifies one endpoint of an edge: the owning repository integration (null =
 * the project's legacy/default repo) plus the node key within that repo.
 */
const edgeEndpointSelector = {
	sourceRepositoryIntegrationId: z.string().nullable().optional(),
	sourceKey: z.string().min(1),
	targetRepositoryIntegrationId: z.string().nullable().optional(),
	targetKey: z.string().min(1),
};

const EDGE_DESCRIPTION_MAX = 20_000;
const EDGE_KIND_MAX = 60;

/** Edit an edge's stable user description override (solo or cross-repo). */
export const updateEdgeInputSchema = z.object({
	projectId: z.string().min(1),
	mode: graphModeSchema.default("BUSINESS"),
	...edgeEndpointSelector,
	kind: z.string().trim().min(1).max(EDGE_KIND_MAX).optional(),
	userDescription: z.string().max(EDGE_DESCRIPTION_MAX).nullable().optional(),
	/** true = the user RE-TYPED the connection (apply `kind` over the detected one). */
	isUserKind: z.boolean().optional(),
	...tenantInput,
});

/** Create a MANUAL edge (user-drawn). Restores a soft-deleted one if present. */
export const createEdgeInputSchema = z.object({
	projectId: z.string().min(1),
	mode: graphModeSchema.default("BUSINESS"),
	...edgeEndpointSelector,
	kind: z.string().trim().min(1).max(EDGE_KIND_MAX).optional(),
	userDescription: z.string().max(EDGE_DESCRIPTION_MAX).nullable().optional(),
	...tenantInput,
});

/** Soft-delete an edge (solo or cross-repo). */
export const deleteEdgeInputSchema = z.object({
	projectId: z.string().min(1),
	mode: graphModeSchema.default("BUSINESS"),
	...edgeEndpointSelector,
	...tenantInput,
});

/** Restore a soft-deleted edge. */
export const restoreEdgeInputSchema = z.object({
	projectId: z.string().min(1),
	mode: graphModeSchema.default("BUSINESS"),
	...edgeEndpointSelector,
	...tenantInput,
});

/** Read an edge override's edit history. */
export const edgeHistoryInputSchema = z.object({
	projectId: z.string().min(1),
	mode: graphModeSchema.default("BUSINESS"),
	...edgeEndpointSelector,
	...tenantInput,
});

/**
 * Compute/refresh cross-repo edges for a project. `repositoryIntegrationIds`
 * omitted = all connected repos. Idempotent (signature-guarded server-side).
 */
export const linkRepositoriesInputSchema = z.object({
	projectId: z.string().min(1),
	repositoryIntegrationIds: z
		.array(z.string().min(1))
		.max(MAX_SYSTEM_REPOS)
		.optional(),
	...tenantInput,
});

/**
 * Force a re-map of the System map's cross-repo relationships (the "re-map
 * relationships" action). `fresh` first wipes the user's cross-repo edge edits
 * (both lenses); otherwise they are preserved and overlay the fresh edges. A
 * WRITE action — gated at the editor permission, unlike the idempotent
 * viewer-triggerable `linkRepositories` auto-recompute.
 */
export const remapSystemInputSchema = z.object({
	projectId: z.string().min(1),
	repositoryIntegrationIds: z
		.array(z.string().min(1))
		.max(MAX_SYSTEM_REPOS)
		.optional(),
	fresh: z.boolean().default(false),
	...tenantInput,
});

/**
 * Re-map a SOLO repo's relationships via the AI intra-repo reference pass.
 * `fresh` wipes this repo's edge edits (both lenses) first; otherwise only the
 * prior AI-generated references are replaced and the user's edits are kept.
 */
export const remapSoloInputSchema = z.object({
	projectId: z.string().min(1),
	fresh: z.boolean().default(false),
	...repoSelector,
	...tenantInput,
});

/** System-map relationship history — cross-link recompute (re-map) runs. */
export const systemRemapHistoryInputSchema = z.object({
	projectId: z.string().min(1),
	limit: z.number().int().min(1).max(100).default(20),
	offset: z.number().int().min(0).default(0),
	...tenantInput,
});

/** Streamed multi-repo Q&A grounded on the selected repos + cross-repo edges. */
export const systemChatInputSchema = z.object({
	projectId: z.string().min(1),
	messages: z.array(atlasChatMessageSchema).min(1),
	mode: graphModeSchema.default("BUSINESS"),
	focusNodeKey: z.string().optional(),
	conversationId: z.string().optional(),
	model: z.string().optional(),
	...systemRepoSelector,
	...tenantInput,
});

export type ListRepositoriesInput = z.infer<typeof listRepositoriesInputSchema>;
export type AtlasStatusInput = z.infer<typeof atlasStatusInputSchema>;
export type AtlasGraphInput = z.infer<typeof atlasGraphInputSchema>;
export type AtlasNodeInput = z.infer<typeof atlasNodeInputSchema>;
export type DescribeNodeInput = z.infer<typeof describeNodeInputSchema>;
export type AnalyzeInput = z.infer<typeof analyzeInputSchema>;
export type CancelAnalysisInput = z.infer<typeof cancelAnalysisInputSchema>;
export type AtlasChatInput = z.infer<typeof atlasChatInputSchema>;
export type AtlasHistoryInput = z.infer<typeof atlasHistoryInputSchema>;
export type ListConversationsInput = z.infer<
	typeof listConversationsInputSchema
>;
export type CreateConversationInput = z.infer<
	typeof createConversationInputSchema
>;
export type GetConversationInput = z.infer<typeof getConversationInputSchema>;
export type UpdateConversationInput = z.infer<
	typeof updateConversationInputSchema
>;
export type DeleteConversationInput = z.infer<
	typeof deleteConversationInputSchema
>;
export type SaveLayoutInput = z.infer<typeof saveLayoutInputSchema>;
export type UpdateNodeInput = z.infer<typeof updateNodeInputSchema>;
export type GetNodeHistoryInput = z.infer<typeof getNodeHistoryInputSchema>;
export type ListBranchesInput = z.infer<typeof listBranchesInputSchema>;
export type SetPinnedBranchesInput = z.infer<
	typeof setPinnedBranchesInputSchema
>;
export type SystemGraphInput = z.infer<typeof systemGraphInputSchema>;
export type LinkRepositoriesInput = z.infer<typeof linkRepositoriesInputSchema>;
export type SystemChatInput = z.infer<typeof systemChatInputSchema>;
export type SaveSystemLayoutInput = z.infer<typeof saveSystemLayoutInputSchema>;
export type UpdateEdgeInput = z.infer<typeof updateEdgeInputSchema>;
export type CreateEdgeInput = z.infer<typeof createEdgeInputSchema>;
export type DeleteEdgeInput = z.infer<typeof deleteEdgeInputSchema>;
export type RestoreEdgeInput = z.infer<typeof restoreEdgeInputSchema>;
export type EdgeHistoryInput = z.infer<typeof edgeHistoryInputSchema>;
