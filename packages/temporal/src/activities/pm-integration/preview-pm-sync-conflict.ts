import { getStoryById, resolvePMConfigForUser } from "@repo/database";
import { logger } from "@repo/logs";
import { ApplicationFailure, Context } from "@temporalio/activity";
import { PMSourceNotFound, resolvePmSource } from "../pm-source";
import { callPmToolWithFallback } from "../pm-tool-fallback";
import { fetchPmTicket } from "./fetch-pm-ticket";
import { stripAttachmentBlock } from "./gitlab-attachment-block";
import { computePmHash } from "./pm-sync-hash";
import { discoverPMToolCapabilitiesResult } from "./story-sync";

/**
 * Why the PM side of a conflict could not be loaded. Surfaced to the UI so it
 * can show an actionable message ("connect your account" / "reconnect") rather
 * than a silent blank diff. Mirrored as a `z.enum` in the
 * `checkPmSyncConflicts` procedure output and as a TS union on the client.
 */
export type PmSyncErrorKind =
	| "MISSING"
	| "EXPIRED"
	| "INVALID"
	| "DISABLED"
	| "NO_ACCESS"
	| "TRANSIENT"
	| "NOT_CONFIGURED";

/** Map an `McpClientError.code` (from the MCP path) to a UI-facing kind. */
function mcpErrorCodeToKind(code: string): PmSyncErrorKind {
	switch (code) {
		case "CONFIG_NOT_FOUND":
			return "MISSING";
		case "CONFIG_DISABLED":
			return "DISABLED";
		case "NO_SERVER_URL":
		case "INVALID_URL":
			return "INVALID";
		case "OAUTH_AUTH_REQUIRED":
		case "AUTH_FAILED":
		case "OAUTH_ERROR":
			return "EXPIRED";
		case "CONNECTION_ERROR":
		case "CONNECTION_TIMEOUT":
		case "RATE_LIMIT":
			return "TRANSIENT";
		default:
			// Any other / future McpClientError code (e.g. OAUTH_CONNECTION_ERROR,
			// API_KEY_MISSING) degrades to TRANSIENT. The raw code is logged
			// server-side at the discovery call site for observability.
			return "TRANSIENT";
	}
}

/** Map a `PMSourceNotFound.reason` (from the GitLab REST path) to a UI kind. */
function restReasonToKind(
	reason: "no-config" | "no-integration" | "token-failed",
): PmSyncErrorKind {
	switch (reason) {
		case "no-config":
			return "MISSING";
		case "no-integration":
			return "NOT_CONFIGURED";
		case "token-failed":
			return "EXPIRED";
	}
}

/**
 * Best-effort classification of a fetch-time failure (capabilities resolved, so
 * credentials were valid, but reading the specific ticket threw). In the
 * per-user model the most common cause is the caller's account lacking access
 * to this project's container.
 */
function fetchErrorToKind(error: unknown): PmSyncErrorKind {
	const msg = (
		error instanceof Error ? error.message : String(error)
	).toLowerCase();
	if (/403|forbidden|permission|not authorized|access deni/.test(msg)) {
		return "NO_ACCESS";
	}
	if (/401|unauthor|expired|invalid.?token/.test(msg)) {
		return "EXPIRED";
	}
	return "TRANSIENT";
}

export type PreviewPmSyncItemType = "epic" | "feature" | "story" | "bug";

export interface PreviewPmSyncConflictInput {
	itemId: string;
	itemType: PreviewPmSyncItemType;
	projectId: string;
	/**
	 * `null` only on the GitLab REST fallback path — the activity then routes
	 * through `resolvePmSource` + `callPmToolWithFallback({tool: "fetchItem"})`
	 * instead of the MCP capabilities/fetch pipeline.
	 */
	mcpConfigId: string | null;
	/**
	 * REQUIRED when `mcpConfigId` is null so the REST source resolver can
	 * identify the integration (`key:gitlab-official`). Optional for MCP.
	 */
	mcpServerId?: string;
	containerId: string;
	containerName?: string;
	additionalContext?: Record<string, string>;
	userId: string;
	organizationId?: string;
}

/** REST GitLab fetch adapter return shape (mirrors gitlab-rest-story-sync). */
type RestFetchResult = {
	title: string;
	description: string | null;
	externalUrl: string | null;
	labels: string[];
};

export interface PreviewPmSyncConflictResult {
	hasConflict: boolean;
	pmCurrent?: {
		title: string;
		description: string;
		lastChangedBy: string | null;
		lastChangedAt: string | null;
	};
	pmUrl?: string;
	/**
	 * Set when the PM side could not be read. `hasConflict` is `false` and
	 * `pmCurrent` is absent; the UI renders an actionable error instead of a
	 * blank diff.
	 */
	pmError?: { kind: PmSyncErrorKind; code?: string };
}

async function loadHashAndExternalId(
	itemType: PreviewPmSyncItemType,
	itemId: string,
	projectId: string,
): Promise<{
	externalId: string | null;
	lastSyncedPmHash: string | null;
} | null> {
	// Stories are the only work-item rows since the Epic/Feature folder tables
	// were dropped; legacy epic/feature item types resolve to "not found" →
	// the preview short-circuits to { hasConflict: false }.
	if (itemType !== "story" && itemType !== "bug") {
		return null;
	}
	const row = await getStoryById(itemId, projectId);
	return row
		? {
				externalId: row.externalId,
				lastSyncedPmHash: row.lastSyncedPmHash,
			}
		: null;
}

/**
 * Read-only sibling of `syncWorkItemToPM`: fetch PM ticket, hash, compare to
 * `lastSyncedPmHash` on the hierarchy row. Performs no DB writes. Used by the
 * `checkPmSyncConflicts` API procedure to power the AI-Update conflict badge.
 *
 * Adapter without `taskGet` returns `{ hasConflict: false }` (forward-compat
 * with adapters that don't yet support reads).
 */
export async function previewPmSyncConflict(
	input: PreviewPmSyncConflictInput,
): Promise<PreviewPmSyncConflictResult> {
	const {
		itemId,
		itemType,
		projectId,
		mcpConfigId,
		mcpServerId,
		containerId,
		containerName,
		additionalContext,
		userId,
		organizationId,
	} = input;

	const item = await loadHashAndExternalId(itemType, itemId, projectId);
	if (!item || !item.externalId) {
		return { hasConflict: false };
	}

	// GitLab REST fallback branch: when `mcpConfigId` is null the project uses
	// the REST routine (no per-user MCPConfig). Skip the MCP capabilities and
	// `fetchPmTicket` MCP path entirely; resolve the REST source and fetch the
	// issue via the provider-agnostic `callPmToolWithFallback`. Without this,
	// the procedure's caller short-circuited to `hasConflict: false`, leaving
	// the resolve modal with no PM-side content to render (the existing
	// `lastPmSyncStatus = CONFLICT` is stamped, but the dialog opens empty).
	// Stories/bugs are the only itemTypes that sync via GitLab REST today —
	// schema-Epic/Feature have no REST hierarchy routine, so for those we
	// short-circuit to "no conflict" (matches the pre-fix behavior for them).
	if (mcpConfigId === null) {
		if (itemType !== "story" && itemType !== "bug") {
			return { hasConflict: false };
		}
		if (!mcpServerId) {
			throw ApplicationFailure.nonRetryable(
				"previewPmSyncConflict: mcpServerId is required when mcpConfigId is null",
				"PmCapabilitiesError",
			);
		}
		Context.current().heartbeat("resolve-rest-source");
		let source: Awaited<ReturnType<typeof resolvePmSource>>;
		try {
			source = await resolvePmSource({
				mcpServerId,
				mcpConfigId: null,
				userId,
				organizationId: organizationId ?? null,
				containerId,
			});
		} catch (error) {
			if (error instanceof PMSourceNotFound) {
				logger.warn("pm.sync.conflict.preview.rest_source_failed", {
					itemId,
					itemType,
					reason: error.reason,
				});
				return {
					hasConflict: false,
					pmError: { kind: restReasonToKind(error.reason) },
				};
			}
			throw error;
		}
		if (source.kind !== "rest-gitlab") {
			throw ApplicationFailure.nonRetryable(
				`previewPmSyncConflict: expected rest-gitlab source, got ${source.kind}`,
				"PmCapabilitiesError",
			);
		}
		Context.current().heartbeat("fetch-pm-rest");
		let restSnapshot: RestFetchResult;
		try {
			restSnapshot = (await callPmToolWithFallback({
				source,
				userId,
				organizationId: organizationId ?? null,
				call: { tool: "fetchItem", externalId: item.externalId },
			})) as RestFetchResult;
		} catch (error) {
			// On any REST fetch failure (transient / auth / not-found) we return
			// `hasConflict: false` rather than throw — the procedure batches many
			// items in parallel, and a single PM-side outage shouldn't blank out
			// the whole list. The conflict row stays stamped (the original
			// detection wrote it); only the modal preview is degraded.
			logger.warn("pm.sync.conflict.preview.rest_fetch_failed", {
				itemId,
				externalId: item.externalId,
				error: error instanceof Error ? error.message : String(error),
			});
			return {
				hasConflict: false,
				pmError: { kind: fetchErrorToKind(error) },
			};
		}

		// Strip the Fabric-owned attachment block (Fizzy #1745) before both
		// hashing and handing the description out to the caller. Unstripped,
		// two things go wrong: the baseline (block-free since
		// gitlab-rest-story-sync.ts's push/pull stamps) never matches a
		// block-containing live hash, so every GitLab story with attachments
		// shows a phantom conflict; and `pmCurrent.description` — which flows
		// into `proposeAiMerge` and can be written back to Fabric via
		// `resolveConflict` LOCAL — would carry the block into the story
		// description, where the next push appends a second copy. Scoped to
		// this GitLab call site deliberately, not `pm-sync-hash.ts` itself,
		// which is shared by ADO, Jira and Fizzy.
		const restDescription = stripAttachmentBlock(
			restSnapshot.description ?? "",
		);
		const currentHash = computePmHash(restSnapshot.title, restDescription);
		const baseline = item.lastSyncedPmHash;
		const pmCurrent = {
			title: restSnapshot.title,
			description: restDescription,
			// GitLab REST `getGitLabIssueForPM` doesn't surface author / updated
			// timestamps in the abbreviated shape returned to PM consumers.
			// Leaving null is benign — the modal renders them as "—".
			lastChangedBy: null,
			lastChangedAt: null,
		};
		if (!baseline || baseline === currentHash) {
			return {
				hasConflict: false,
				pmCurrent,
				pmUrl: restSnapshot.externalUrl ?? undefined,
			};
		}
		logger.info("pm.sync.conflict.preview", {
			itemId,
			itemType,
			source: "rest-gitlab",
		});
		return {
			hasConflict: true,
			pmCurrent,
			pmUrl: restSnapshot.externalUrl ?? undefined,
		};
	}

	// Per-user model: the project pins ONE config id owned by whoever set up
	// the integration. Resolve the CURRENT caller's OWN config for the same PM
	// server so a non-creator who has connected their account sees the diff.
	// `resolvePMConfigForUser` can only ever return a config the caller owns —
	// a `null` result means the caller simply hasn't connected (MISSING), never
	// another user's credentials.
	const resolvedConfig = await resolvePMConfigForUser({
		configId: mcpConfigId,
		mcpServerId,
		userId,
		organizationId,
	});

	if (!resolvedConfig) {
		return { hasConflict: false, pmError: { kind: "MISSING" } };
	}
	if (!resolvedConfig.enabled) {
		return { hasConflict: false, pmError: { kind: "DISABLED" } };
	}

	const resolvedConfigId = resolvedConfig.id;

	const capabilitiesResult = await discoverPMToolCapabilitiesResult({
		mcpConfigId: resolvedConfigId,
		mcpServerId,
		userId,
		organizationId,
	});

	if (!capabilitiesResult.ok) {
		return {
			hasConflict: false,
			pmError: {
				kind: mcpErrorCodeToKind(capabilitiesResult.error.code),
				code: capabilitiesResult.error.code,
			},
		};
	}

	const capabilities = capabilitiesResult.capabilities;

	if (!capabilities.taskGet) {
		// Adapter genuinely exposes no read capability (forward-compat with
		// push-only adapters) — not a credential error.
		return { hasConflict: false };
	}

	Context.current().heartbeat("fetch-pm");

	let snapshot: Awaited<ReturnType<typeof fetchPmTicket>>;
	try {
		snapshot = await fetchPmTicket({
			mcpConfigId: resolvedConfigId,
			userId,
			organizationId,
			capabilities,
			externalId: item.externalId,
			containerId,
			containerName,
			additionalContext,
		});
	} catch (error) {
		// Capabilities resolved (credentials are valid) but reading this ticket
		// failed. In the per-user model the usual cause is the caller's account
		// lacking access to this project's container; surface a typed error
		// instead of mistaking it for "no conflict".
		//
		// Fail-fast: we catch ALL fetch errors here — including transient ones
		// (5xx / timeout / rate-limit, classified TRANSIENT) — rather than
		// re-throwing to Temporal's retry. This preview is interactive (the API
		// procedure awaits the workflow result while the dialog is open and
		// batches many items), so blocking on up-to-3 server-side retries would
		// stall the whole batch; the UI surfaces a "try again" affordance for
		// TRANSIENT instead.
		logger.warn("pm.sync.conflict.preview.fetch_failed", {
			itemId,
			itemType,
			mcpConfigId: resolvedConfigId,
			error: error instanceof Error ? error.message : String(error),
		});
		return {
			hasConflict: false,
			pmError: { kind: fetchErrorToKind(error) },
		};
	}

	if (!snapshot) {
		return { hasConflict: false };
	}

	const currentHash = computePmHash(snapshot.title, snapshot.description);
	const baseline = item.lastSyncedPmHash;

	if (!baseline || baseline === currentHash) {
		return {
			hasConflict: false,
			pmCurrent: {
				title: snapshot.title,
				description: snapshot.description,
				lastChangedBy: snapshot.lastChangedBy,
				lastChangedAt: snapshot.lastChangedAt,
			},
			pmUrl: snapshot.url,
		};
	}

	logger.info("pm.sync.conflict.preview", {
		itemId,
		itemType,
		mcpConfigId,
	});

	return {
		hasConflict: true,
		pmCurrent: {
			title: snapshot.title,
			description: snapshot.description,
			lastChangedBy: snapshot.lastChangedBy,
			lastChangedAt: snapshot.lastChangedAt,
		},
		pmUrl: snapshot.url,
	};
}
