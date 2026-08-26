/**
 * PM State Poll Activities
 *
 * Activities for polling PM tool work item states and reconciling
 * terminal state changes back into Fabric via PendingPmStateChange entries.
 */

import {
	autoDismissReappearedFlagMissing,
	createPmSyncConflictNotifications,
	db,
	findFabricItemByExternalId,
	findFabricItemsByExternalId,
	getLinkedExternalIds,
	incrementMissingStreak,
	pendingFlagMissingExists,
	recordAudit,
	resetMissingStreaks,
	upsertPendingChange,
} from "@repo/database";
import { logger } from "@repo/logs";
import { Context } from "@temporalio/activity";
import {
	PMSourceNotFound,
	resolvePmServerKey,
	resolvePmSource,
} from "../pm-source";
import {
	type NormalizedPmState,
	normalizePolledState,
} from "./extract-pm-item-state";
import { stripAttachmentBlock } from "./gitlab-attachment-block";
import { isFetchComplete } from "./pm-fetch-complete";
import { PM_MISSING_SENTINEL } from "./pm-missing-constants";
import { computePmHash } from "./pm-sync-hash";
import { hashTerminalStatuses, resolveTerminalSet } from "./pm-terminal-config";
import {
	classifyPmItem,
	type FabricItemRef,
	type PmWorkItemState,
	reconcileStoryTerminalStatus,
} from "./reconcile-story-terminal-status";
import { recordPmSyncLog } from "./record-pm-sync-log";
import {
	fetchPMItemsByIds,
	type GetWorkItemsByIdsResult,
	getWorkItemsByIdsFromPM,
	type PMWorkItemSummary,
} from "./story-sync";

// Re-export the work-item / Fabric-ref types from the leaf module so existing
// importers of these symbols from `pm-state-poll` keep working (#1360 Task 1).
export type {
	FabricItemRef,
	PmWorkItemState,
} from "./reconcile-story-terminal-status";

// =============================================================================
// Constants
// =============================================================================

/** Consecutive missing-poll cycles before a story's dead link is flagged. */
export const STREAK_THRESHOLD = 3;
/** Fraction of linked tickets failing that signals a provider/network outage. */
export const OUTAGE_FRACTION = 0.5;
/** Minimum linked sample below which the outage guard never trips (too noisy). */
export const OUTAGE_MIN_SAMPLE = 3;
/** Sentinel newState stamped on a FLAG_MISSING review row (no real PM state).
 * Defined in `./pm-missing-constants` (standalone) and re-exported here for the
 * poll's existing consumers; also shared with the on-demand `hierarchy-sync`
 * push path so both producers stamp the identical value. */
export { PM_MISSING_SENTINEL };
/** Max NET-NEW FLAG_MISSING proposals created per project per poll cycle. Caps the
 *  one-time ADO-activation backlog into a steady drip; over-cap NEW ids hold their
 *  streak (incrementMissingStreak caps it) and create on a subsequent cycle.
 *  Existing PENDING rows still refresh and do NOT consume this budget. */
export const MAX_NEW_FLAGS_PER_PROJECT_PER_CYCLE = 10;
/** Opt-in hard cap for a single Fizzy/PM MCP call during the poll (ms).
 *  A healthy get is <2s; 20s is an unambiguous "hung call" threshold. */
export const PM_POLL_CALL_TIMEOUT_MS = 20_000;
/** Soft budget for the whole per-project fetch (ms). Kept comfortably below the
 *  child workflow's 5-minute `startToCloseTimeout` so the activity self-returns
 *  (with partial results) before Temporal kills it. NOTE: a partial/incomplete
 *  fetch does NOT advance `lastAdoStatePollAt` — that is gated on
 *  `fetched.complete` (DEC-6). */
export const PM_POLL_BUDGET_MS = 4 * 60_000;

/** Emit an activity heartbeat at least once every N items processed by the
 *  post-fetch content-drift loops (#1741). The drift work (upsertPendingChange /
 *  recordPmSyncLog / notification fan-out) runs sequentially per passthrough item
 *  AFTER all MCP calls return, so it emits no heartbeat on its own; on a large
 *  first-post-freeze backlog this could otherwise exceed the fetch proxy's 60s
 *  `heartbeatTimeout` and re-freeze the watermark. 20 keeps the cadence well
 *  under 60s even at pathological per-item DB latency while staying cheap. */
const DRIFT_HEARTBEAT_EVERY_N_ITEMS = 20;

/** Emit an activity heartbeat if running inside a Temporal activity; no-op
 *  otherwise (e.g. unit tests that call the fetch directly, where there is no
 *  activity context and `Context.current()` throws). The Temporal SDK throttles
 *  the actual network heartbeat, so calling this frequently is safe. */
function safeHeartbeat(): void {
	try {
		Context.current().heartbeat();
	} catch {
		// Not inside a Temporal activity — no-op.
	}
}

/** Map a PM server key to a human-readable label for notification copy. */
function pmToolLabel(serverKey: string | null): string {
	switch (serverKey) {
		case "azure-devops":
			return "Azure DevOps";
		case "fizzy":
			return "Fizzy";
		case "jira":
			return "Jira";
		case "github":
			return "GitHub";
		case "gitlab":
		case "gitlab-official":
			return "GitLab";
		case "linear":
			return "Linear";
		default:
			return "the connected PM tool";
	}
}

/** Normalize a PM server key to the slug stored on `PmSyncLog.pmTool`. */
function pmToolSlug(serverKey: string | null): string {
	if (serverKey === "gitlab-official") {
		return "gitlab";
	}
	return serverKey ?? "unknown";
}

// =============================================================================
// Types
// =============================================================================

export interface PmActiveProject {
	id: string;
	mcpConfigId: string | null;
	mcpServerId: string;
	sourceKind: "mcp" | "rest-gitlab";
	/** PM server key (e.g. "azure-devops", "fizzy", "gitlab-official") for labels. */
	pmTool: string | null;
	containerId: string;
	containerName: string | null;
	lastAdoStatePollAt: Date | null;
	userId: string;
	organizationId: string | null;
}

/**
 * The full result of a poll fetch: the changed items reconcileAdoStates
 * consumes, plus the raw success/failure sets the FLAG_MISSING producer
 * (#1360) needs — `seenExternalIds` (successfully fetched, used to reset
 * streaks), `notFoundIds` (DEFINITE not-found, the only set that may feed the
 * missing-streak — review Fix A), `failedIds` (all failures, kept for logging
 * only), and `totalLinked` (denominator for the outage guard).
 */
export interface FetchAdoWorkItemStatesResult {
	items: PmWorkItemState[];
	seenExternalIds: string[];
	/** Definite not-found ids (404 / "does not exist"). Drives FLAG_MISSING. */
	notFoundIds: string[];
	/** All failed ids (transient + auth + not-found). Logging only. */
	failedIds: string[];
	totalLinked: number;
	/** True only when every linked card was observed this cycle (fetched or
	 *  confirmed not-found). Gates the watermark advance (DEC-6). */
	complete: boolean;
	/** Fingerprint of the terminal-status config fetch classified against
	 *  (#1741 DEC-6). Reconcile re-derives its own and applies nothing on a
	 *  mismatch, so a mid-run settings change never applies stale verdicts. */
	terminalStatusesHash: string;
}

// NOTE (Codex Fix 2 + 3): `mcpServerId`/`sourceKind`/`pmTool` are OPTIONAL on
// the activity inputs so every intermediate commit stays type-check clean —
// the consuming workflow is updated in Task 8, and `tsc` checks the whole
// package, so a *required* new field would leave the workflow red between
// Task 5 and Task 8. They are always supplied by the real caller (the child
// workflow, Task 8); the bodies (Tasks 6/7) read them with safe defaults
// (`sourceKind ?? "mcp"`, `pmTool ?? null`). `PmActiveProject` keeps them
// required because getAdoActiveProjects (its producer) always sets them.
export interface FetchAdoWorkItemStatesInput {
	projectId: string;
	mcpConfigId: string | null;
	mcpServerId?: string;
	/** PM server key (e.g. "azure-devops"); selects the structural batch branch. */
	pmTool?: string | null;
	sourceKind?: "mcp" | "rest-gitlab";
	containerId: string;
	containerName: string | null;
	lastAdoStatePollAt: Date | null;
	userId: string;
	organizationId?: string;
}

export interface ReconcileAdoStatesInput {
	projectId: string;
	items: PmWorkItemState[];
	/** PM server key for the tool label in notification copy / sync-log rows. */
	pmTool?: string | null;
	/** The config hash fetch classified against (#1741 DEC-6). Reconcile applies
	 *  nothing when it no longer matches the live config. Required — the
	 *  consuming workflow (`pm-state-poll-project-workflow.ts`) always supplies
	 *  `fetched.terminalStatusesHash`. */
	terminalStatusesHash: string;
}

export interface ReconcileAdoStatesResult {
	pendingChangesCreated: number;
	storiesAutoHidden: number;
	/** False when terminal-status settings changed between fetch and reconcile;
	 *  the workflow then holds the watermark so the next poll re-classifies. */
	settingsStable: boolean;
}

/**
 * Snapshot a drifted Fabric entity's title for the pull-drift `PmSyncLog` row.
 * `entityType` is already in `EPIC | FEATURE | STORY` form (the log shape).
 * Stories are the only work-item rows (folder tables dropped); legacy
 * EPIC/FEATURE rows resolve to an empty title.
 */
async function getDriftEntityTitle(
	entityType: "EPIC" | "FEATURE" | "STORY",
	entityId: string,
): Promise<string> {
	if (entityType !== "STORY") {
		return "";
	}
	const row = await db.userStory.findUnique({
		where: { id: entityId },
		select: { title: true },
	});
	return row?.title ?? "";
}

/**
 * Resolve the best-effort recipient list for a pull-drift notification:
 * project owner + (for STORY only) the story assignee. Caller filters
 * out the (absent) acting user inside `createPmSyncConflictNotifications`.
 */
async function resolveDriftNotificationRecipients(
	entityType: "EPIC" | "FEATURE" | "STORY",
	entityId: string,
	projectUserId: string | null,
): Promise<string[]> {
	const ids: Array<string | null> = [projectUserId];
	if (entityType === "STORY") {
		const story = await db.userStory.findUnique({
			where: { id: entityId },
			select: { assigneeId: true },
		});
		ids.push(story?.assigneeId ?? null);
	}
	return ids.filter((id): id is string => Boolean(id));
}

interface DetectContentDriftInput {
	projectId: string;
	item: {
		externalId: string;
		title: string | null;
		description: string | null;
	};
	fabricItem: FabricItemRef;
	tenant: { organizationId: string | null; userId: string | null };
	pmToolLabel: string;
	pmToolSlug: string;
}

/**
 * Content-drift pass for a single NON-terminal polled item.
 *
 * Terminal precedence (Q11) is enforced structurally by the caller — this only
 * runs for items NOT in a terminal transition this cycle. Applies the remaining
 * skip rules in order: null baseline (Q3) → push-time CONFLICT (Q7) → hash
 * compare. On genuine drift, raises a `CONTENT_DRIFT` review row (NEVER
 * overwrites Fabric — confirmation-before-overwrite), and on FIRST detection
 * only (`upsert.action === "created"`) emits the audit log + notification.
 *
 * Returns true when a `CONTENT_DRIFT` row was created or updated (so the caller
 * can bump its counter), false when skipped/no-drift.
 *
 * NOTE (Q7): this NEVER touches the entity's `lastPmSyncStatus` — push-time
 * sync state is left exactly as-is.
 */
async function detectContentDrift(
	input: DetectContentDriftInput,
): Promise<boolean> {
	const { projectId, item, fabricItem, tenant, pmToolLabel, pmToolSlug } =
		input;

	// Skip rule: no baseline → no honest drift claim (Q3 — a null baseline would
	// flag every change as drift).
	if (fabricItem.lastSyncedPmHash == null) {
		return false;
	}

	// Skip rule: a push-time conflict already owns this item (Q7) — do not
	// double-surface it in the pull-drift group.
	if (fabricItem.lastPmSyncStatus === "CONFLICT") {
		return false;
	}

	// Drift = the current polled content hash differs from the stamped
	// baseline. Equal → state-only/noise (the ChangedDate pre-gate already
	// let it through). Despite the name history here, this function is
	// reached by every poll source — ADO, Jira, Fizzy AND the GitLab REST
	// fallback (`sourceKind: "rest-gitlab"`) — not just ADO; `polledHash`
	// (renamed from `adoHash`, Fizzy #1745) reflects that.
	//
	// Strip the Fabric-owned GitLab attachment block (Fizzy #1745) before
	// hashing: `lastSyncedPmHash` is stamped block-free by
	// `gitlab-rest-story-sync.ts`'s push/pull, so an unstripped polled
	// description would mismatch on the block's mere presence and raise a
	// false CONTENT_DRIFT for every GitLab story that has ever pushed
	// attachments. `stripAttachmentBlock` is a no-op on ADO/Jira/Fizzy
	// descriptions (they never contain the fence markers), so this is safe
	// on the shared path. Scoped to this call site deliberately, not
	// `pm-sync-hash.ts` itself, which is shared by every PM tool.
	const polledHash = computePmHash(
		item.title,
		item.description
			? stripAttachmentBlock(item.description)
			: item.description,
	);
	if (polledHash === fabricItem.lastSyncedPmHash) {
		return false;
	}

	// Raise a review row. The action-aware upsert dedups on `proposedAction` +
	// `detectedPmHash`: an open CONTENT_DRIFT row at this exact hash → "skipped";
	// a newer PM-side edit advances it → "updated"; first detection → "created".
	// Sentinel "CONTENT"/"CONTENT" — a CONTENT_DRIFT row has no state transition.
	const result = await upsertPendingChange({
		projectId,
		entityType: fabricItem.entityType,
		entityId: fabricItem.entityId,
		externalId: item.externalId,
		previousState: "CONTENT",
		newState: "CONTENT",
		proposedAction: "CONTENT_DRIFT",
		detectedPmHash: polledHash,
	});

	// First-detection-only audit + notification (Q9 — parallels terminal-drift
	// gating). "updated"/"skipped" re-observations write nothing.
	if (result.action === "created") {
		const entityTitle = await getDriftEntityTitle(
			fabricItem.entityType,
			fabricItem.entityId,
		);

		await recordPmSyncLog({
			direction: "pull",
			entityType: fabricItem.entityType,
			entityId: fabricItem.entityId,
			title: entityTitle,
			pmTool: pmToolSlug,
			status: "CONFLICT",
			errorPayload: {
				// Kept as the historical literal value (persisted in
				// PmSyncLog.errorPayload) even though this path is reached by
				// every PM tool, not just ADO — not renaming a stored value
				// out of scope for this fix.
				reason: "ado-content-drift",
				detectedPmHash: polledHash,
			},
			actorUserId: null,
			externalId: item.externalId,
			externalUrl: null,
			organizationId: tenant.organizationId,
			userId: tenant.organizationId ? null : tenant.userId,
			projectId,
		});

		if (result.pendingId) {
			try {
				const recipients = await resolveDriftNotificationRecipients(
					fabricItem.entityType,
					fabricItem.entityId,
					tenant.userId,
				);
				await createPmSyncConflictNotifications({
					entityType: fabricItem.entityType,
					entityId: fabricItem.entityId,
					entityTitle,
					proposedAction: "CONTENT_DRIFT",
					pmToolLabel,
					projectId,
					organizationId: tenant.organizationId,
					actorUserId: null, // background polling — no acting user
					pendingStateChangeId: result.pendingId,
					recipientUserIds: recipients,
					link: `projects/${projectId}/stories/${fabricItem.entityId}?review=conflict`,
				});
			} catch (error) {
				logger.warn(
					{ err: error, projectId, entityId: fabricItem.entityId },
					"[PM Poll] content-drift notification fan-out failed",
				);
			}
		}
	}

	return result.action === "created" || result.action === "updated";
}

// =============================================================================
// Activities
// =============================================================================

/**
 * Query the database for all projects with active ADO polling enabled.
 *
 * Returns projects where:
 * - adoStatePollActive = true
 * - projectManagementMcpConfigId is not null
 * - status is not ARCHIVED
 */
export async function getAdoActiveProjects(): Promise<PmActiveProject[]> {
	const projects = await db.project.findMany({
		where: {
			adoStatePollActive: true,
			projectManagementMcpServerId: { not: null },
			status: { not: "ARCHIVED" },
		},
		select: {
			id: true,
			projectManagementMcpServerId: true,
			projectManagementMcpConfigId: true,
			projectManagementContainerId: true,
			projectManagementContainerName: true,
			lastAdoStatePollAt: true,
			userId: true,
			organizationId: true,
		},
	});

	const active: PmActiveProject[] = [];
	for (const p of projects) {
		if (
			!p.projectManagementMcpServerId ||
			!p.projectManagementContainerId
		) {
			continue;
		}

		// Classify the project's PM source AS ITS OWNER (XOR tenant isolation).
		// `resolvePmSource` THROWS `PMSourceNotFound` on every unusable path
		// (misconfig / no integration / token failure) — that is EXPECTED, and we
		// skip just that project. Any OTHER error (DB failure, bug) must NOT be
		// swallowed: rethrow so the poll activity fails visibly and Temporal
		// retries, rather than silently truncating the project set (review finding).
		// The resolved source may carry a GitLab token; we keep only `.kind` and
		// discard it.
		let sourceKind: "mcp" | "rest-gitlab";
		let pmTool: string | null;
		try {
			const source = await resolvePmSource({
				mcpServerId: p.projectManagementMcpServerId,
				mcpConfigId: p.projectManagementMcpConfigId,
				userId: p.userId,
				organizationId: p.organizationId,
				containerId: p.projectManagementContainerId,
			});
			sourceKind = source.kind;
			pmTool = await resolvePmServerKey(p.projectManagementMcpServerId);
		} catch (err) {
			if (err instanceof PMSourceNotFound) {
				logger.info(
					"[PM Poll] Skipping project — PM source not resolvable",
					{
						projectId: p.id,
						reason: err.reason,
					},
				);
				continue;
			}
			logger.error("[PM Poll] Unexpected error resolving PM source", {
				projectId: p.id,
				error: err instanceof Error ? err.message : String(err),
			});
			throw err;
		}

		active.push({
			id: p.id,
			mcpConfigId: p.projectManagementMcpConfigId,
			mcpServerId: p.projectManagementMcpServerId,
			sourceKind,
			pmTool,
			containerId: p.projectManagementContainerId,
			containerName: p.projectManagementContainerName,
			lastAdoStatePollAt: p.lastAdoStatePollAt,
			userId: p.userId,
			organizationId: p.organizationId,
		});
	}

	return active;
}

/** ADO batch chunk size (wit_get_work_items_batch_by_ids caps at 200). */
const ADO_BATCH_CHUNK = 200;
/** Fields the poll's normalizePolledState needs from the ADO batch. */
const ADO_BATCH_FIELDS = [
	"System.Id",
	"System.Title",
	"System.WorkItemType",
	"System.State",
	"System.TeamProject",
	"System.ChangedDate",
	"System.Description",
];

type LinkedStory = Awaited<ReturnType<typeof getLinkedExternalIds>>[number];

interface PollClassifyContext {
	projectId: string;
	terminalLc: Set<string>;
	terminalStatusesHash: string;
	linkedByExternalId: Map<string, LinkedStory>;
	tenant: { organizationId: string | null; userId: string | null };
	pmToolLabel: string;
	pmToolSlug: string;
}

/** One SLIM verdict plus whether this item raised/advanced a `CONTENT_DRIFT` row. */
interface PollVerdictResult {
	verdict: PmWorkItemState;
	/** `detectContentDrift` created/updated a review row (drift-count diagnostic). */
	driftCreated: boolean;
}

/**
 * Build one SLIM verdict from a normalized item, running the content-drift pass
 * in-place for passthrough items (the full card `title`/`description` is in
 * hand here and must NOT cross the activity boundary). Terminal/reopen items
 * skip drift, because terminal takes precedence. Returns a verdict with NO
 * title/description, plus the drift outcome so the fetch path can surface a
 * drift-row count in its diagnostics (the count reconcile used to log before the
 * pass moved here, #1741).
 */
async function buildPollVerdict(
	externalId: string,
	n: NormalizedPmState,
	ctx: PollClassifyContext,
): Promise<PollVerdictResult> {
	const verdict: PmWorkItemState = {
		externalId,
		state: n.statusString ?? "",
		stateChangedDate: n.changedDate ? n.changedDate.toISOString() : null,
		isClosed: n.isClosed,
		labels: n.labels,
	};

	let driftCreated = false;
	const linked = ctx.linkedByExternalId.get(externalId);
	if (linked) {
		const fabricItem: FabricItemRef = {
			entityType: linked.entityType as "EPIC" | "FEATURE" | "STORY",
			entityId: linked.entityId,
			draftingStage: linked.draftingStage,
			lastSyncedPmHash: linked.lastSyncedPmHash,
			lastPmSyncStatus: linked.lastPmSyncStatus,
			pmAutoHidden: linked.pmAutoHidden,
		};
		const { classification } = classifyPmItem(
			verdict,
			fabricItem,
			ctx.terminalLc,
		);
		// Carry the fetch-time classification so reconcile can detect a mid-cycle
		// story-state change (Codex round-1). NOT applied by reconcile.
		verdict.classification = classification;
		if (classification === "passthrough") {
			driftCreated = await detectContentDrift({
				projectId: ctx.projectId,
				item: {
					externalId,
					title: n.title,
					description: n.description,
				},
				fabricItem,
				tenant: ctx.tenant,
				pmToolLabel: ctx.pmToolLabel,
				pmToolSlug: ctx.pmToolSlug,
			});
		}
	}

	return { verdict, driftCreated };
}

/**
 * Structural ADO not-found via batch silent-drop. notFoundIds = requested −
 * returned over VALIDATED (strict-mode) batch responses. A batch call failure or
 * strict-malformed payload → those chunk ids become `failedIds`, never
 * `notFoundIds`. NO per-chunk 100%-missing veto — a recognized (even empty)
 * payload yields real structural not-found (the streak/outage/cap/human-Accept
 * layers govern magnitude). wrongBoard items exist → counted as seen. All output
 * ids are mapped back to the original stored externalId form.
 */
async function fetchViaAdoBatch(
	input: FetchAdoWorkItemStatesInput,
	linkedItems: Array<{ externalId: string }>,
	ctx: PollClassifyContext,
): Promise<FetchAdoWorkItemStatesResult> {
	const {
		mcpConfigId,
		containerId,
		containerName,
		lastAdoStatePollAt,
		userId,
		organizationId,
	} = input;
	const failedIds: string[] = [];
	const seenExternalIds: string[] = [];
	const notFoundIds: string[] = [];
	const summaries: PMWorkItemSummary[] = [];

	const numericIds: number[] = [];
	const toOriginal = new Map<number, string>();
	for (const li of linkedItems) {
		const n = Number(li.externalId);
		if (!Number.isFinite(n)) {
			failedIds.push(li.externalId);
			continue;
		}
		numericIds.push(n);
		toOriginal.set(n, li.externalId);
	}
	const orig = (n: number): string => toOriginal.get(n) ?? String(n);

	for (let i = 0; i < numericIds.length; i += ADO_BATCH_CHUNK) {
		const chunk = numericIds.slice(i, i + ADO_BATCH_CHUNK);
		let res: GetWorkItemsByIdsResult;
		try {
			res = await getWorkItemsByIdsFromPM({
				mcpConfigId: mcpConfigId as string,
				containerId,
				containerName: containerName ?? undefined,
				additionalContext: containerName
					? { project: containerName }
					: undefined,
				userId,
				organizationId,
				ids: chunk,
				strict: true,
				fields: ADO_BATCH_FIELDS,
			});
		} catch (err) {
			// Capability-absent bubbles up so the caller falls back to per-ID.
			if (
				err instanceof Error &&
				/does not expose wit_get_work_items_batch_by_ids/.test(
					err.message,
				)
			) {
				throw err;
			}
			// Any other throw (transient / auth / strict-malformed) → this chunk is
			// transient, NOT deletion.
			for (const n of chunk) {
				failedIds.push(orig(n));
			}
			continue;
		}
		for (const n of res.wrongBoardIds) {
			seenExternalIds.push(orig(n)); // exists elsewhere → seen
		}
		for (const it of res.items) {
			seenExternalIds.push(orig(Number(it.id)));
			summaries.push(it);
		}
		for (const n of res.notFoundIds) {
			notFoundIds.push(orig(n));
		}
	}

	const allItems: PmWorkItemState[] = [];
	let contentDriftRows = 0;
	// Heartbeat the post-fetch drift loop (#1741): buildPollVerdict runs the
	// content-drift DB work per passthrough item after all MCP calls returned, so
	// without this a large backlog could exceed the 60s heartbeatTimeout.
	let driftHeartbeatCounter = 0;
	for (const pmItem of summaries) {
		if (driftHeartbeatCounter++ % DRIFT_HEARTBEAT_EVERY_N_ITEMS === 0) {
			safeHeartbeat();
		}
		const n = normalizePolledState(pmItem, { kind: "mcp" });
		if (
			lastAdoStatePollAt &&
			n.changedDate &&
			n.changedDate <= lastAdoStatePollAt
		) {
			continue;
		}
		const { verdict, driftCreated } = await buildPollVerdict(
			orig(Number(pmItem.id)),
			n,
			ctx,
		);
		if (driftCreated) {
			contentDriftRows++;
		}
		allItems.push(verdict);
	}

	const nullChangedDateCount = allItems.filter(
		(i) => i.stateChangedDate === null,
	).length;
	const out: FetchAdoWorkItemStatesResult = {
		items: allItems,
		seenExternalIds,
		notFoundIds,
		failedIds,
		totalLinked: linkedItems.length,
		complete: isFetchComplete({
			seenExternalIds,
			notFoundIds,
			totalLinked: linkedItems.length,
		}),
		terminalStatusesHash: ctx.terminalStatusesHash,
	};

	logger.info("[PM Poll] Fetched ADO work item states (batch)", {
		projectId: input.projectId,
		totalLinked: linkedItems.length,
		seen: seenExternalIds.length,
		notFound: notFoundIds.length,
		failed: failedIds.length,
		changedItems: allItems.length,
		contentDriftRows, // drift-row count (moved from reconcile, #1741)
		nullChangedDateCount, // DEC-2 diagnostic: inert-filter probe
		serializedBytes: JSON.stringify(out).length, // DEC-1 diagnostic: payload guard
	});

	return out;
}

export async function fetchAdoWorkItemStates(
	input: FetchAdoWorkItemStatesInput,
): Promise<FetchAdoWorkItemStatesResult> {
	const {
		projectId,
		mcpConfigId,
		mcpServerId,
		containerId,
		containerName,
		lastAdoStatePollAt,
		userId,
		organizationId,
	} = input;
	const kind = input.sourceKind ?? "mcp";

	const linkedItems = await getLinkedExternalIds(projectId);

	const project = await db.project.findUnique({
		where: { id: projectId },
		select: {
			organizationId: true,
			userId: true,
			pmTerminalStatuses: true,
		},
	});
	const terminalStatuses = resolveTerminalSet(project?.pmTerminalStatuses);
	const terminalStatusesHash = hashTerminalStatuses(terminalStatuses);

	if (linkedItems.length === 0) {
		logger.info("[PM Poll] No linked items for project", { projectId });
		return {
			items: [],
			seenExternalIds: [],
			notFoundIds: [],
			failedIds: [],
			totalLinked: 0,
			complete: true,
			terminalStatusesHash,
		};
	}

	const ctx: PollClassifyContext = {
		projectId,
		terminalLc: new Set(terminalStatuses.map((s) => s.toLowerCase())),
		terminalStatusesHash,
		linkedByExternalId: new Map(
			linkedItems.map((li) => [li.externalId, li]),
		),
		tenant: {
			organizationId: project?.organizationId ?? null,
			userId: project?.userId ?? null,
		},
		pmToolLabel: pmToolLabel(input.pmTool ?? null),
		pmToolSlug: pmToolSlug(input.pmTool ?? null),
	};

	if (input.pmTool === "azure-devops" && mcpConfigId) {
		try {
			return await fetchViaAdoBatch(input, linkedItems, ctx);
		} catch (err) {
			if (
				err instanceof Error &&
				/does not expose wit_get_work_items_batch_by_ids/.test(
					err.message,
				)
			) {
				logger.warn(
					"[PM Poll] ADO batch tool absent — falling back to per-ID",
					{
						projectId,
					},
				);
			} else {
				throw err;
			}
		}
	}

	const result = await fetchPMItemsByIds({
		mcpConfigId,
		mcpServerId,
		containerId,
		externalIds: linkedItems.map((i) => i.externalId),
		additionalContext: containerName
			? { project: containerName }
			: undefined,
		userId,
		organizationId,
		concurrency: 8,
		callTimeoutMs: PM_POLL_CALL_TIMEOUT_MS,
		budgetMs: PM_POLL_BUDGET_MS,
	});

	const allItems: PmWorkItemState[] = [];
	let contentDriftRows = 0;
	// Heartbeat the post-fetch drift loop (#1741): buildPollVerdict runs the
	// content-drift DB work per passthrough item after all MCP calls returned, so
	// without this a large backlog could exceed the 60s heartbeatTimeout.
	let driftHeartbeatCounter = 0;
	for (const pmItem of result.items) {
		if (driftHeartbeatCounter++ % DRIFT_HEARTBEAT_EVERY_N_ITEMS === 0) {
			safeHeartbeat();
		}
		const n = normalizePolledState(pmItem, {
			kind,
			pmTool: input.pmTool ?? undefined,
		});

		// Incremental skip: only when we have BOTH a prior poll anchor and a
		// changed-date. Tools without a changed-date (null) are always
		// evaluated — idempotent, since reconcile dedups via upsertPendingChange.
		if (lastAdoStatePollAt && n.changedDate) {
			if (n.changedDate <= lastAdoStatePollAt) {
				continue;
			}
		}

		const { verdict, driftCreated } = await buildPollVerdict(
			pmItem.id,
			n,
			ctx,
		);
		if (driftCreated) {
			contentDriftRows++;
		}
		allItems.push(verdict);
	}

	const nullChangedDateCount = allItems.filter(
		(i) => i.stateChangedDate === null,
	).length;
	const out: FetchAdoWorkItemStatesResult = {
		items: allItems,
		seenExternalIds: result.items.map((i) => i.id),
		// Only DEFINITE not-found ids feed missing-detection (review Fix A).
		notFoundIds: result.notFoundIds ?? [],
		failedIds: result.failedIds ?? [],
		totalLinked: linkedItems.length,
		complete: isFetchComplete({
			seenExternalIds: result.items.map((i) => i.id),
			notFoundIds: result.notFoundIds ?? [],
			totalLinked: linkedItems.length,
		}),
		terminalStatusesHash: ctx.terminalStatusesHash,
	};

	logger.info("[PM Poll] Fetched work item states", {
		projectId,
		sourceKind: kind,
		totalLinked: linkedItems.length,
		fetched: result.items.length,
		failed: result.failedIds?.length ?? 0,
		notFound: result.notFoundIds?.length ?? 0,
		changedItems: allItems.length,
		contentDriftRows, // drift-row count (moved from reconcile, #1741)
		nullChangedDateCount, // DEC-2 diagnostic: inert-filter probe
		serializedBytes: JSON.stringify(out).length, // DEC-1 diagnostic: payload guard
		isBackfill: !lastAdoStatePollAt,
	});

	return out;
}

/**
 * Reconcile ADO states against Fabric entities.
 *
 * Applies the SLIM verdicts produced by `fetchAdoWorkItemStates`. Content drift
 * is NOT handled here — it moved into the fetch activity (`buildPollVerdict`),
 * the only place the full card `title`/`description` is in hand, so those fields
 * never cross the activity boundary (#1741). Do NOT reintroduce a drift pass or
 * read title/description here.
 *
 * Per changed item: resolve the Fabric story, run the story-state divergence
 * gate, then hand it to `reconcileStoryTerminalStatus` — a terminal transition
 * (Closed/Done/Removed, per hashed config) auto-hides the story (or raises an
 * `UNHIDE` proposal on reopen) and clears any pending `CONTENT_DRIFT` row.
 *
 * Two gates hold the workflow watermark instead of applying stale work:
 * - Settings-change gate: if `pmTerminalStatuses` changed between fetch and
 *   reconcile (hash mismatch), apply nothing and return `settingsStable: false`.
 * - Divergence gate: if a story's fresh classification now needs drift that
 *   fetch skipped (non-passthrough → passthrough), return `settingsStable: false`
 *   so the next poll re-fetches + re-classifies under the current state.
 */
export async function reconcileAdoStates(
	input: ReconcileAdoStatesInput,
): Promise<ReconcileAdoStatesResult> {
	const { projectId, items } = input;
	let pendingChangesCreated = 0;
	let storiesAutoHidden = 0;

	const project = await db.project.findUnique({
		where: { id: projectId },
		select: {
			organizationId: true,
			userId: true,
			pmTerminalStatuses: true,
			pmAutoCloseEnabled: true,
		},
	});
	const tenant = {
		organizationId: project?.organizationId ?? null,
		userId: project?.userId ?? null,
	};
	const terminalStatuses = resolveTerminalSet(project?.pmTerminalStatuses);
	const currentHash = hashTerminalStatuses(terminalStatuses);

	// DEC-6 settings-change gate: fetch classified (and ran drift) against a
	// snapshot of pmTerminalStatuses. If it changed since, do NOT apply stale
	// verdicts — report settingsStable:false so the workflow holds the watermark
	// and the next poll re-fetches + re-classifies every card under the new config.
	if (currentHash !== input.terminalStatusesHash) {
		logger.info(
			"[PM Poll] Terminal-status settings changed between fetch and reconcile — applying nothing, holding watermark",
			{ projectId, fetchHash: input.terminalStatusesHash, currentHash },
		);
		return {
			pendingChangesCreated: 0,
			storiesAutoHidden: 0,
			settingsStable: false,
		};
	}

	const terminalLc = new Set(terminalStatuses.map((s) => s.toLowerCase()));
	const autoCloseEnabled = project?.pmAutoCloseEnabled ?? false;

	// Story-state divergence gate (Codex round-1 + round-2): flips true when an
	// item's fresh classification would need drift that fetch did not run.
	let storyStateDiverged = false;

	for (const item of items) {
		const fabricItem = await findFabricItemByExternalId(
			projectId,
			item.externalId,
		);

		if (!fabricItem) {
			logger.debug("[PM Poll] No Fabric item found for external ID", {
				projectId,
				externalId: item.externalId,
			});
			continue;
		}

		// STORY entities are the only work-item rows (the Epic/Feature folder
		// tables were dropped — `findFabricItemByExternalId` can only resolve a
		// story). Snapshot the terminal flag for the checkmark, and auto-hide
		// when the toggle is ON. The PENDING-HIDE review flow is retired for
		// STORY (spec D3). Delegated to the shared leaf helper (#1360 Task 1)
		// so the per-item Pull paths reuse it without a static import cycle.
		if (fabricItem.entityType !== "STORY") {
			// Defensive: cannot occur post-drop; kept for wire-shape safety.
			logger.warn(
				"[PM Poll] Skipping legacy non-STORY entity (folder tables removed)",
				{
					projectId,
					entityType: fabricItem.entityType,
					entityId: fabricItem.entityId,
				},
			);
			continue;
		}
		// Post-folder-drop this resolves STORY rows only; the widened
		// `PmStateChangeEntityType` enum (Test Cases) makes the type wider than
		// runtime reality, so re-affirm STORY for the STORY-only reconcilers
		// below (the `!== "STORY"` guard above narrows the property but not the
		// object when it is passed whole).
		const storyFabricItem: FabricItemRef = {
			...fabricItem,
			entityType: "STORY",
		};

		// Story-state divergence gate (Codex round-1 + round-2). Fetch classified
		// this item against the story state it read at fetch time and, for the
		// PASSTHROUGH case only, ran drift there. The only harmful divergence is
		// when fetch did NOT run drift (non-passthrough) but the fresh row now needs
		// it (passthrough) — reconcile cannot run drift (no title/description), so
		// hold the watermark and let the next poll re-classify + re-run drift.
		// Other directions are safe: passthrough→reopen/terminal already ran drift
		// in fetch (terminal clears it on hide); terminal never flips (it depends
		// only on the immutable fetched PM state + hashed config).
		if (item.classification == null) {
			// Fail closed (round-2 F1): a slim item without a fetch-time
			// classification (e.g. an old fetch result during a deploy) means we
			// cannot know whether drift ran — hold rather than advance blindly.
			storyStateDiverged = true;
		} else if (item.classification !== "passthrough") {
			const { classification: fresh } = classifyPmItem(
				item,
				storyFabricItem,
				terminalLc,
			);
			if (fresh === "passthrough") {
				storyStateDiverged = true;
			}
		}

		const r = await reconcileStoryTerminalStatus({
			projectId,
			item,
			fabricItem: storyFabricItem,
			terminalLc,
			autoCloseEnabled,
			tenant,
		});
		pendingChangesCreated += r.pendingChangesCreated;
		if (r.action === "auto-hidden") {
			storiesAutoHidden++;
		}
	}

	logger.info("[PM Poll] Reconciliation complete", {
		projectId,
		itemsProcessed: items.length,
		pendingChangesCreated,
		storiesAutoHidden,
		settingsStable: !storyStateDiverged,
	});

	return {
		pendingChangesCreated,
		storiesAutoHidden,
		settingsStable: !storyStateDiverged,
	};
}

/**
 * Update the project's lastAdoStatePollAt timestamp after a successful poll.
 */
export async function updateProjectPollTimestamp(
	projectId: string,
	advanceWatermark: boolean,
): Promise<void> {
	// DEC-6: advance the changed-date watermark ONLY when the fetch fully
	// observed the board. A partial/empty cycle must not advance it, or a later
	// fetch of a skipped Done card would be filtered out by `changedDate <= anchor`.
	if (!advanceWatermark) {
		return;
	}
	await db.project.update({
		where: { id: projectId },
		data: { lastAdoStatePollAt: new Date() },
	});
}

/**
 * FLAG_MISSING producer (#1360). Consumes the raw success/failure sets the poll
 * fetch now returns and proposes a reviewable FLAG_MISSING when a story's linked
 * ticket is confirmed deleted on its OWN PM tool.
 *
 * Four guards keep this honest:
 * - Classified input (review Fix A): only `notFoundIds` (DEFINITE not-found —
 *   404 / "does not exist") feed this pass. Transient/auth/config failures are
 *   absent from `notFoundIds`, so the streak neither increments nor resets for
 *   them — it is held across a blip; only a successful fetch (`seenExternalIds`)
 *   resets it.
 * - Reset-on-success ("seen → forget"): any ticket fetched this cycle clears its
 *   streak, so a transient miss never accumulates toward a flag.
 * - Outage guard: a provider/network outage (or a provider that erroneously
 *   404s en masse) makes many tickets look missing at once; when the not-found
 *   fraction crosses OUTAGE_FRACTION over a sample of at least OUTAGE_MIN_SAMPLE
 *   linked tickets, skip incrementing this cycle.
 * - Source scope: a story is eligible only on a POSITIVE active-server match —
 *   a cross-tool link merely 404s against the active server, and a null
 *   provenance is unknown; treating either as missing would unlink a valid link
 *   on Accept.
 *
 * Idempotent per poll cycle (review Fix C): each increment is gated by
 * `pollRunId` (the child poll workflow's runId — a fresh execution per
 * scheduled tick), so a Temporal activity retry or concurrent run advances a
 * given (entity, externalId) at most once per cycle.
 *
 * Multi-entity (#1360 D7): a notFoundId is resolved to EVERY Fabric entity
 * sharing it (epic/feature/story) via the plural lookup, and each is flagged
 * independently so a co-linked entity cannot mask another. A notFoundId that
 * resolves to no entity (orphan) is skipped. Returns the number of FLAG_MISSING
 * review rows created/updated.
 */
export async function reconcileMissingTickets(input: {
	projectId: string;
	activeServerId: string;
	/** Per-cycle idempotency token (the poll child workflow's runId). */
	pollRunId: string;
	seenExternalIds: string[];
	/** DEFINITE not-found ids only — transient/auth failures are excluded. */
	notFoundIds: string[];
	totalLinked: number;
}): Promise<number> {
	const {
		projectId,
		activeServerId,
		pollRunId,
		seenExternalIds,
		notFoundIds,
		totalLinked,
	} = input;

	// 1. Reset on success ("seen → forget"), keyed by externalId.
	await resetMissingStreaks(projectId, seenExternalIds);

	// 1b. Auto-dismiss stale FLAG_MISSING proposals for tickets that reappeared
	// (#1360). Runs before the outage guard so seen items clear even mid-outage.
	if (seenExternalIds.length > 0) {
		const dismissed = await autoDismissReappearedFlagMissing({
			projectId,
			externalIds: seenExternalIds,
			activeServerId,
		});
		if (dismissed.length > 0) {
			const proj = await db.project.findUnique({
				where: { id: projectId },
				select: { organizationId: true },
			});
			for (const row of dismissed) {
				recordAudit({
					action: "story.pm_flag_missing_auto_dismissed",
					category: "story",
					actor: { type: "system" },
					organizationId: proj?.organizationId ?? null,
					projectId,
					resource: {
						type: row.entityType.toLowerCase(),
						id: row.entityId,
					},
					metadata: {
						externalId: row.externalId,
						entityType: row.entityType,
						reason: "ticket_reappeared",
						pollRunId,
					},
				});
			}
			logger.info(
				"[PM Poll] Auto-dismissed stale FLAG_MISSING on reappear",
				{ projectId, count: dismissed.length },
			);
		}
	}

	// 2. Outage guard — a provider/network outage (or a provider erroneously
	// 404ing en masse) makes many tickets look missing at once; do not increment
	// streaks this cycle. Computed on the not-found ratio, not all failures.
	if (
		totalLinked >= OUTAGE_MIN_SAMPLE &&
		notFoundIds.length / totalLinked >= OUTAGE_FRACTION
	) {
		logger.info("[PM Poll] Missing-detection skipped — outage guard", {
			projectId,
			notFound: notFoundIds.length,
			totalLinked,
		});
		return 0;
	}

	// 3. Increment + flag, de-duplicated, source-scoped to the active server.
	let flagged = 0;
	let created = 0;
	const seen = new Set<string>();
	for (const externalId of notFoundIds) {
		if (seen.has(externalId)) {
			continue;
		}
		seen.add(externalId);

		// Resolve ALL entities sharing this externalId (epic/feature/story) so a
		// co-linked entity cannot mask another (#1360 D7). Flag each independently.
		const fabricItems = await findFabricItemsByExternalId(
			projectId,
			externalId,
		);
		for (const fabricItem of fabricItems) {
			// Source scope: require a POSITIVE active-server match. null (unknown
			// provenance) and a different server are NOT eligible.
			if (fabricItem.externalMcpServerId !== activeServerId) {
				continue;
			}

			const streak = await incrementMissingStreak({
				projectId,
				entityType: fabricItem.entityType,
				entityId: fabricItem.entityId,
				externalId,
				cap: STREAK_THRESHOLD,
				pollRunId,
			});

			if (streak >= STREAK_THRESHOLD) {
				const alreadyPending = await pendingFlagMissingExists({
					projectId,
					// Story-only queries post-folder-drop; narrow away the widened
					// `PmStateChangeEntityType` (Test Cases) member this consumer
					// does not accept. Safe by the runtime invariant.
					entityType: fabricItem.entityType as
						| "EPIC"
						| "FEATURE"
						| "STORY",
					entityId: fabricItem.entityId,
					externalId,
				});
				// Shared cap (D4): NET-NEW creates only; existing rows refresh free.
				if (
					!alreadyPending &&
					created >= MAX_NEW_FLAGS_PER_PROJECT_PER_CYCLE
				) {
					continue;
				}
				const result = await upsertPendingChange({
					projectId,
					entityType: fabricItem.entityType,
					entityId: fabricItem.entityId,
					externalId,
					previousState: fabricItem.draftingStage,
					newState: PM_MISSING_SENTINEL,
					proposedAction: "FLAG_MISSING",
					expectedExternalMcpServerId: activeServerId,
				});
				if (result.action === "created") {
					created++;
					flagged++;
				} else if (result.action === "updated") {
					flagged++;
				}
			}
		}
	}

	logger.info("[PM Poll] Missing-detection cycle summary", {
		projectId,
		notFoundCount: notFoundIds.length,
		newFlags: created,
		refreshed: flagged - created,
		capped: created >= MAX_NEW_FLAGS_PER_PROJECT_PER_CYCLE,
	});
	return flagged;
}
