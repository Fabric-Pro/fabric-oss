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
	mergePmStatusSyncLastRun,
	pendingFlagMissingExists,
	recordAudit,
	resetMissingStreaks,
	upsertPendingChange,
} from "@repo/database";
import {
	type LabelStatusMap,
	readLabelStatusMap,
	STATUS_SYNC_OUTCOMES,
	type StatusSyncOutcome,
} from "@repo/integrations/pm";
import { logger } from "@repo/logs";
// Fizzy #2304 — a failed fetch's message is shown to users, so it is scrubbed.
import { scrubSecrets } from "@repo/utils/scrub-secrets";
import { Context } from "@temporalio/activity";
// Fizzy #2304 D2.3 — the switch-on fetch result is measured against the
// per-payload limit (`PM_POLL_RESULT_BUDGET_BYTES`).
import { measureSerializedBytes } from "../../lib/payload-size-guard";
import {
	JOB_STEPS,
	jobComplete,
	jobEnsure,
	jobFail,
	jobStep,
	seedJobSteps,
} from "../lib/job-progress";
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
import { isFetchComplete, isNotAttemptedError } from "./pm-fetch-complete";
import { PM_MISSING_SENTINEL } from "./pm-missing-constants";
import { resolveTrusted } from "./pm-server-provenance";
import {
	mapKeyToPatternType,
	type TrustedKey,
} from "./pm-server-provenance-match";
import { computePmHash } from "./pm-sync-hash";
import { hashTerminalStatuses, resolveTerminalSet } from "./pm-terminal-config";
import {
	createStampToolTypeResolver,
	linkBelongsToActiveTool,
} from "./poll-link-scope";
import {
	reconcileStoryMappedStatus,
	recordTerminalObservation,
	STATUS_SYNC_STORY_SELECT,
	statusSyncLinkKey,
} from "./reconcile-story-mapped-status";
import {
	classifyPmItem,
	type FabricItemRef,
	type PmWorkItemState,
	type ReconcileStoryTerminalResult,
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
	/** Saved PM-tool inputs, carried through the poll and filtered before use. */
	projectManagementAdditionalContext: unknown;
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
	/** Optional for compatibility with poll workflows already in Temporal history. */
	projectManagementAdditionalContext?: unknown;
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
			projectManagementAdditionalContext: true,
			lastAdoStatePollAt: true,
			userId: true,
			organizationId: true,
			// Fizzy #2304 D2.6 — read for projects this activity SKIPS, so the
			// skip shows as a failed run in the status-sync summary. Not
			// returned on PmActiveProject (the workflow reads that shape).
			pmStatusSyncEnabled: true,
			pmStatusSyncSessionAt: true,
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
				// Fizzy #2304 follow-up — a dead token that cannot be refreshed
				// skips the project with its reason, rather than failing every
				// ticket read one by one.
				requireFreshToken: true,
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
						detail: err.detail,
					},
				);
				if (p.pmStatusSyncEnabled && p.pmStatusSyncSessionAt) {
					await mergePmStatusSyncLastRun({
						projectId: p.id,
						sessionAt: p.pmStatusSyncSessionAt,
						patch: {
							failure: {
								at: new Date().toISOString(),
								kind: "source-not-found",
								error: err.detail
									? `${err.reason}: ${err.detail}`
									: err.reason,
							},
						},
					});
				}
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
			projectManagementAdditionalContext:
				p.projectManagementAdditionalContext,
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
	/** Fizzy #2304 — the fetch-time read of the project's status-sync switch. */
	statusSyncEnabled: boolean;
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
	// Fizzy #2304 D2.3 — the fetched issue's own URL, for the status-sync leaf's
	// linked-issue check. Only while the switch is on, so a switch-off verdict
	// stays byte-identical to today's.
	if (ctx.statusSyncEnabled) {
		verdict.itemUrl = n.itemUrl;
	}

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
	/** The resolved changed-date anchor (Fizzy #2304 D2.1) — null = read everything. */
	watermark: Date | null,
): Promise<FetchAdoWorkItemStatesResult> {
	const { mcpConfigId, containerId, containerName, userId, organizationId } =
		input;
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
		if (watermark && n.changedDate && n.changedDate <= watermark) {
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

/**
 * Fizzy #2304 D2.2 — where a status-sync fetch starts in the linked list. A
 * fresh random offset every cycle, so a fetch budget that runs out leaves a
 * DIFFERENT tail unread each time instead of starving the same one. An object
 * property (not a bare function) so tests can pin it with `vi.spyOn`.
 */
export const statusSyncFetchOrder = {
	startOffset(linkedCount: number): number {
		return linkedCount > 0 ? Math.floor(Math.random() * linkedCount) : 0;
	},
};

/** `items` rotated to start at `offset` (taken modulo the length). Pure. */
function rotateFrom<T>(items: readonly T[], offset: number): T[] {
	if (items.length === 0) {
		return [];
	}
	const start = ((offset % items.length) + items.length) % items.length;
	return [...items.slice(start), ...items.slice(0, start)];
}

/**
 * Temporal refuses a SINGLE payload above 2 MiB (`BlobSizeLimitError`; the
 * same ceiling `packages/api/modules/workflows/lib/execution-input-bounds.ts`
 * sizes against). That is the limit that binds a fetch result.
 */
const TEMPORAL_PAYLOAD_LIMIT_BYTES = 2 * 1024 * 1024;

/**
 * Fizzy #2304 D2.3 — serialized-size budget for one switch-on fetch result.
 *
 * Two Temporal limits apply, and the smaller one binds:
 * - 2 MiB per PAYLOAD (`TEMPORAL_PAYLOAD_LIMIT_BYTES`). The fetch result is
 *   one payload (the activity's return value), and the reconcile input the
 *   workflow builds from the same `items` is another. Reconcile's input is a
 *   subset of this result, so capping the result caps both.
 * - 4 MiB per gRPC MESSAGE (`TEMPORAL_MAX_MESSAGE_BYTES`), which the shared
 *   guard's `PAYLOAD_HARD_LIMIT_BYTES` enforces. A result sized to that frame
 *   could still be up to twice the payload limit and be refused, so it is not
 *   the budget here.
 *
 * The budget keeps 128 KiB below the payload limit for the envelope
 * arithmetic in `capFetchResultToPayloadBudget` and the payload's own metadata.
 */
export const PM_POLL_RESULT_BUDGET_BYTES =
	TEMPORAL_PAYLOAD_LIMIT_BYTES - 128 * 1024;

/**
 * Fizzy #2304 D2.3 — keep a switch-on fetch result inside the payload budget.
 *
 * With status sync on, every linked item is read every cycle (D2.1) and each
 * REST verdict carries its full label list and `itemUrl`, so a large project
 * can outgrow the frame. Verdicts are kept in fetch order while they fit; the
 * first verdict that does not fit, and every verdict after it, is reported
 * exactly like a budget-skipped read: removed from `items` and
 * `seenExternalIds`, added to `failedIds`, and `complete` recomputed (false),
 * so the watermark does not advance (DEC-6). The rotation (D2.2) moves that
 * tail every cycle.
 *
 * The envelope is measured once as an upper bound — every verdict id already
 * counted in BOTH `seenExternalIds` and `failedIds` — so the capped result can
 * only be smaller than `used`, never larger.
 */
function capFetchResultToPayloadBudget(
	out: FetchAdoWorkItemStatesResult,
	budgetBytes: number,
): { out: FetchAdoWorkItemStatesResult; overflowIds: string[] } {
	if (measureSerializedBytes(out) <= budgetBytes) {
		return { out, overflowIds: [] };
	}
	let used = measureSerializedBytes({
		...out,
		items: [],
		failedIds: [
			...out.failedIds,
			...out.items.map((item) => item.externalId),
		],
	});
	const kept: PmWorkItemState[] = [];
	const overflowIds: string[] = [];
	for (const item of out.items) {
		// +1 for the comma that separates array elements.
		const size = measureSerializedBytes(item) + 1;
		if (overflowIds.length === 0 && used + size <= budgetBytes) {
			kept.push(item);
			used += size;
		} else {
			overflowIds.push(item.externalId);
		}
	}
	const overflow = new Set(overflowIds);
	const seenExternalIds = out.seenExternalIds.filter(
		(id) => !overflow.has(id),
	);
	return {
		out: {
			...out,
			items: kept,
			seenExternalIds,
			failedIds: [...out.failedIds, ...overflowIds],
			complete: isFetchComplete({
				seenExternalIds,
				notFoundIds: out.notFoundIds,
				totalLinked: out.totalLinked,
			}),
		},
		overflowIds,
	};
}

/**
 * Fizzy #2304 D2.3 — the second half of the cap: the identifier lists.
 *
 * `capFetchResultToPayloadBudget` evicts verdicts but keeps every id, and the
 * id lists alone can outgrow the budget: every id the read pool never started
 * before its deadline is in `failedIds`, so a project with a few hundred
 * thousand linked tickets overflows with no verdict at all. This runs after
 * the verdict pass and trims until the result fits:
 * - `failedIds` first, from the tail. It is kept for logging only — nothing
 *   downstream reads it — so a trimmed id is simply not observed this cycle,
 *   exactly like a budget-skipped read;
 * - `notFoundIds` only when it does not fit even with `failedIds` empty, and
 *   then WHOLE. It feeds the FLAG_MISSING producer, whose outage guard reads
 *   the not-found share of `totalLinked`: a partial list would lower that
 *   share and could let a mass-404 cycle increment streaks it must hold. An
 *   empty list holds every streak for a cycle — a delay, never a write;
 * - never `seenExternalIds`. When this trims anything, the verdict pass has
 *   already evicted every verdict (its envelope alone was over the budget),
 *   so no kept verdict loses its seen id.
 *
 * `complete` is forced false: an id that is no longer reported was not
 * observed, so the watermark must hold (DEC-6). The caller writes the run
 * summary from the untrimmed lists, so the counts users see stay true.
 */
function trimIdListsToPayloadBudget(
	out: FetchAdoWorkItemStatesResult,
	budgetBytes: number,
): {
	out: FetchAdoWorkItemStatesResult;
	droppedFailed: number;
	droppedNotFound: number;
} {
	if (measureSerializedBytes(out) <= budgetBytes) {
		return { out, droppedFailed: 0, droppedNotFound: 0 };
	}
	const notFoundIds =
		measureSerializedBytes({
			...out,
			failedIds: [],
			complete: false,
		}) > budgetBytes
			? []
			: out.notFoundIds;
	// Removing an element removes its own bytes plus at most one comma, so
	// subtracting only its own bytes keeps `used` an upper bound on the size.
	let used = measureSerializedBytes({ ...out, notFoundIds, complete: false });
	let failedKept = out.failedIds.length;
	while (failedKept > 0 && used > budgetBytes) {
		failedKept--;
		used -= measureSerializedBytes(out.failedIds[failedKept]);
	}
	if (used > budgetBytes) {
		// Unreachable from the poll: with both lists emptied only the seen ids
		// of non-verdict observations (ADO wrong-board ids) and scalars remain.
		logger.error(
			"[PM Poll] Status-sync fetch result still over the payload budget after trimming its id lists",
			{ usedBytes: used, budgetBytes },
		);
	}
	return {
		out: {
			...out,
			failedIds: out.failedIds.slice(0, failedKept),
			notFoundIds,
			complete: false,
		},
		droppedFailed: out.failedIds.length - failedKept,
		droppedNotFound: out.notFoundIds.length - notFoundIds.length,
	};
}

/**
 * Fizzy #2304 D2.6 — the run summary's fetch counts, from the UNTRIMMED
 * result (after the verdict pass, before `trimIdListsToPayloadBudget`).
 * `failed` counts only reads that were attempted and failed: an id the pool
 * never started, or a fetched verdict the payload cap deferred, is in
 * `failedIds` but lands in "not fetched" (linked − fetched − failed −
 * notFound), which is what it is.
 */
function fetchSummaryCounts(
	out: FetchAdoWorkItemStatesResult,
	deferredIds: ReadonlySet<string>,
) {
	const notFound = new Set(out.notFoundIds);
	return {
		linked: out.totalLinked,
		fetched: out.seenExternalIds.length,
		// Disjoint buckets: `failedIds` also carries every definite not-found
		// id, which is counted separately, and every deferred id.
		failed: new Set(
			out.failedIds.filter(
				(id) => !notFound.has(id) && !deferredIds.has(id),
			),
		).size,
		notFound: notFound.size,
		complete: out.complete,
	};
}

/**
 * Fetch's own project read: tenant + terminal config (#1741), plus the
 * status-sync switch and session (Fizzy #2304 D2.1 / D2.6).
 */
function readFetchProject(projectId: string) {
	return db.project.findUnique({
		where: { id: projectId },
		select: {
			organizationId: true,
			userId: true,
			pmTerminalStatuses: true,
			pmStatusSyncEnabled: true,
			pmStatusSyncSessionAt: true,
		},
	});
}

type FetchProjectRow = Awaited<ReturnType<typeof readFetchProject>>;

export async function fetchAdoWorkItemStates(
	input: FetchAdoWorkItemStatesInput,
): Promise<FetchAdoWorkItemStatesResult> {
	const project = await readFetchProject(input.projectId);
	// Fizzy #2304 D2.6 — the session is read ONCE, here. Every last-run write
	// below is conditioned on it still being current, so a switch toggled while
	// this fetch runs cannot let it write into the new session's summary.
	const sessionAt =
		project?.pmStatusSyncEnabled === true
			? project.pmStatusSyncSessionAt
			: null;

	let fetched: LinkedItemStatesFetch;
	try {
		fetched = await fetchLinkedItemStates(input, project);
	} catch (err) {
		// A failed fetch must read as a failed run, never as a quiet one. The
		// message is a provider's error text, which the settings card shows
		// to users, so credentials it may echo are scrubbed before it is stored
		// (the writer's length cap runs after, so it cannot cut a secret in half).
		// A `PMSourceNotFound` (e.g. the strict token resolution inside
		// `fetchPMItemsByIds` failing) already carries a fixed-vocabulary
		// reason/detail — record that directly, in the SAME `reason: detail`
		// shape the enumeration path (`getAdoActiveProjects`) uses, rather than
		// its generic `Error.message` (which would read as raw provider text).
		if (sessionAt !== null) {
			await mergePmStatusSyncLastRun({
				projectId: input.projectId,
				sessionAt,
				patch: {
					failure: {
						at: new Date().toISOString(),
						kind: "fetch-failed",
						error:
							err instanceof PMSourceNotFound
								? err.detail
									? `${err.reason}: ${err.detail}`
									: err.reason
								: scrubSecrets(
										err instanceof Error
											? err.message
											: String(err),
									),
					},
				},
			});
		}
		throw err;
	}

	let out = fetched.out;
	// Ids in `failedIds` that were deferred rather than failed: never started
	// by the read pool, or (below) fetched but left out by the payload cap.
	const deferredIds = new Set(fetched.notAttemptedIds);
	let result = out;
	// D2.3 — switch on only, so a switch-off result stays byte-identical.
	if (project?.pmStatusSyncEnabled === true) {
		const capped = capFetchResultToPayloadBudget(
			out,
			PM_POLL_RESULT_BUDGET_BYTES,
		);
		if (capped.overflowIds.length > 0) {
			logger.warn(
				"[PM Poll] Status-sync fetch result over the payload budget; the tail is left for the next cycle",
				{
					projectId: input.projectId,
					kept: capped.out.items.length,
					overflow: capped.overflowIds.length,
					budgetBytes: PM_POLL_RESULT_BUDGET_BYTES,
				},
			);
		}
		for (const id of capped.overflowIds) {
			deferredIds.add(id);
		}
		out = capped.out;
		const trimmed = trimIdListsToPayloadBudget(
			out,
			PM_POLL_RESULT_BUDGET_BYTES,
		);
		if (trimmed.droppedFailed + trimmed.droppedNotFound > 0) {
			logger.warn(
				"[PM Poll] Status-sync fetch result's id lists over the payload budget; trimmed ids are left for the next cycle",
				{
					projectId: input.projectId,
					droppedFailed: trimmed.droppedFailed,
					droppedNotFound: trimmed.droppedNotFound,
					budgetBytes: PM_POLL_RESULT_BUDGET_BYTES,
				},
			);
		}
		result = trimmed.out;
	}

	if (sessionAt !== null) {
		await mergePmStatusSyncLastRun({
			projectId: input.projectId,
			sessionAt,
			patch: {
				fetch: {
					at: new Date().toISOString(),
					// The untrimmed lists: the true totals, not what fit.
					...fetchSummaryCounts(out, deferredIds),
				},
			},
		});
	}
	return result;
}

/**
 * One fetch, plus what only the run summary needs. `notAttemptedIds` never
 * crosses the activity boundary: the workflow reads `out` alone.
 */
interface LinkedItemStatesFetch {
	out: FetchAdoWorkItemStatesResult;
	/** Ids in `out.failedIds` the read pool never started (Fizzy #2304). */
	notAttemptedIds: string[];
}

async function fetchLinkedItemStates(
	input: FetchAdoWorkItemStatesInput,
	project: FetchProjectRow,
): Promise<LinkedItemStatesFetch> {
	const {
		projectId,
		mcpConfigId,
		mcpServerId,
		containerId,
		containerName,
		lastAdoStatePollAt,
		userId,
		organizationId,
		projectManagementAdditionalContext,
	} = input;
	const kind = input.sourceKind ?? "mcp";
	const statusSyncEnabled = project?.pmStatusSyncEnabled === true;
	// Fizzy #2304 D2.1 — ONE resolved anchor for both fetch paths. With status
	// sync on, every linked item is read every cycle: an item skipped as
	// "unchanged since the watermark" would never have its mapped status
	// compared at all.
	const watermark = statusSyncEnabled ? null : lastAdoStatePollAt;

	// Fizzy #2304 follow-up — read only stories linked to the ACTIVE PM tool.
	// A story linked to a previously used tool keeps its externalId, and asking
	// the new tool for that id either fails every cycle (the fetch never
	// completes, the watermark never advances) or reads an unrelated ticket.
	// Scoped from this input's snapshot (`pmTool`, else its `mcpServerId` for
	// inputs recorded before `pmTool` existed) — never from a fresh project read.
	const activeToolType = mapKeyToPatternType(
		input.pmTool ??
			(input.mcpServerId
				? await resolvePmServerKey(input.mcpServerId)
				: null),
	);
	const resolveStamp = createStampToolTypeResolver();
	const allLinked = await getLinkedExternalIds(projectId);
	const linked: typeof allLinked = [];
	for (const link of allLinked) {
		if (await linkBelongsToActiveTool(link, activeToolType, resolveStamp)) {
			linked.push(link);
		}
	}
	if (linked.length < allLinked.length) {
		logger.info("[PM Poll] Skipped stories linked to a different PM tool", {
			projectId,
			skipped: allLinked.length - linked.length,
			activeToolType,
		});
	}

	// Fizzy #2304 D2.2 — with status sync on, start at a fresh random offset
	// each cycle, so a fetch budget that runs out leaves a different tail
	// unread each time. Switch off: the stored order, unchanged.
	const linkedItems = statusSyncEnabled
		? rotateFrom(linked, statusSyncFetchOrder.startOffset(linked.length))
		: linked;

	const terminalStatuses = resolveTerminalSet(project?.pmTerminalStatuses);
	const terminalStatusesHash = hashTerminalStatuses(terminalStatuses);

	if (linkedItems.length === 0) {
		logger.info("[PM Poll] No linked items for project", { projectId });
		return {
			out: {
				items: [],
				seenExternalIds: [],
				notFoundIds: [],
				failedIds: [],
				totalLinked: 0,
				complete: true,
				terminalStatusesHash,
			},
			notAttemptedIds: [],
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
		statusSyncEnabled,
	};

	if (input.pmTool === "azure-devops" && mcpConfigId) {
		try {
			// Every batch chunk is attempted: nothing is deferred.
			return {
				out: await fetchViaAdoBatch(input, linkedItems, ctx, watermark),
				notAttemptedIds: [],
			};
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

	const savedAdditionalContext: Record<string, string> = {};
	if (
		projectManagementAdditionalContext &&
		typeof projectManagementAdditionalContext === "object" &&
		!Array.isArray(projectManagementAdditionalContext)
	) {
		for (const [key, value] of Object.entries(
			projectManagementAdditionalContext,
		)) {
			if (typeof value === "string") {
				savedAdditionalContext[key] = value;
			}
		}
	}
	const additionalContext = {
		...(containerName ? { project: containerName } : {}),
		...savedAdditionalContext,
	};

	const result = await fetchPMItemsByIds({
		mcpConfigId,
		mcpServerId,
		containerId,
		externalIds: linkedItems.map((i) => i.externalId),
		additionalContext:
			Object.keys(additionalContext).length > 0
				? additionalContext
				: undefined,
		userId,
		organizationId,
		concurrency: 8,
		callTimeoutMs: PM_POLL_CALL_TIMEOUT_MS,
		budgetMs: PM_POLL_BUDGET_MS,
		requireFreshToken: true,
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

		// Incremental skip: only when we have BOTH a resolved anchor and a
		// changed-date. Tools without a changed-date (null) are always
		// evaluated — idempotent, since reconcile dedups via upsertPendingChange.
		// Status sync resolves the anchor to null (D2.1): nothing is skipped.
		if (watermark && n.changedDate) {
			if (n.changedDate <= watermark) {
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
		isBackfill: !watermark,
		statusSyncEnabled,
	});

	return {
		out,
		notAttemptedIds: out.failedIds.filter((id) =>
			isNotAttemptedError(result.failedIdErrors?.[id]),
		),
	};
}

// =============================================================================
// Mapped-status sync wiring (Fizzy #2304, spec §4.3–§4.4)
// =============================================================================

/** The reconcile project fields status sync reads (spec D2.4). */
interface StatusSyncProjectFields {
	pmStatusSyncEnabled: boolean;
	pmStatusSyncSessionAt: Date | null;
	projectManagementAdditionalContext: unknown;
	projectManagementMcpServerId: string | null;
	projectManagementMcpConfigId: string | null;
}

/** Everything one reconcile run needs for status sync, resolved once per run. */
interface StatusSyncRun {
	/** D2.6 guard — the session this run belongs to; null = never stamped, so no summary. */
	sessionAt: Date | null;
	config: {
		labelStatusMap: LabelStatusMap;
		statusColumnMap: Record<string, string>;
		projectStatuses: Array<{ id: string; name: string }>;
	};
	source: {
		isRest: boolean;
		activeServerId: string;
		pmToolKey: string | null;
		pmToolLabel: string;
	};
	/** AC8 fallback for never-stamped MCP stories — resolved lazily, at most once per run. */
	activeOrg: () => Promise<TrustedKey | null>;
}

/** `statusColumnMap` (Fabric status id → PM column id) from the saved PM context; string values only. */
function readStatusColumnMap(
	additionalContext: unknown,
): Record<string, string> {
	if (
		!additionalContext ||
		typeof additionalContext !== "object" ||
		Array.isArray(additionalContext)
	) {
		return {};
	}
	const raw = (additionalContext as Record<string, unknown>).statusColumnMap;
	if (!raw || typeof raw !== "object" || Array.isArray(raw)) {
		return {};
	}
	const map: Record<string, string> = {};
	for (const [statusId, columnId] of Object.entries(raw)) {
		if (typeof columnId === "string" && columnId.length > 0) {
			map[statusId] = columnId;
		}
	}
	return map;
}

/**
 * Null when the switch is off (or the project has no PM server) — then the
 * reconcile loop reads and writes nothing for status sync (AC14).
 */
async function loadStatusSyncRun(
	projectId: string,
	project: StatusSyncProjectFields | null,
	pmTool: string | null,
): Promise<StatusSyncRun | null> {
	const activeServerId = project?.projectManagementMcpServerId ?? null;
	if (project?.pmStatusSyncEnabled !== true || activeServerId === null) {
		return null;
	}
	// D2.4 — REST-ness is a null config id on THIS row.
	const configId = project.projectManagementMcpConfigId;
	let activeOrg: Promise<TrustedKey | null> | undefined;
	return {
		sessionAt: project.pmStatusSyncSessionAt,
		config: {
			labelStatusMap: readLabelStatusMap(
				project.projectManagementAdditionalContext,
			),
			statusColumnMap: readStatusColumnMap(
				project.projectManagementAdditionalContext,
			),
			projectStatuses: await db.projectStoryStatus.findMany({
				where: { projectId },
				select: { id: true, name: true },
			}),
		},
		source: {
			isRest: configId === null,
			activeServerId,
			pmToolKey: pmTool,
			pmToolLabel: pmToolLabel(pmTool),
		},
		activeOrg: () => {
			activeOrg ??= resolveTrusted(db, {
				id: projectId,
				projectManagementMcpServerId: activeServerId,
				projectManagementMcpConfigId: configId,
			}).then((res) => (res.ok ? res.trusted : null));
			return activeOrg;
		},
	};
}

function emptyOutcomeCounts(): Record<StatusSyncOutcome, number> {
	return Object.fromEntries(
		STATUS_SYNC_OUTCOMES.map((outcome) => [outcome, 0]),
	) as Record<StatusSyncOutcome, number>;
}

/** A verdict's ISO `stateChangedDate` (it crossed Temporal JSON) as a Date. */
function parseVerdictDate(iso: string | null): Date | null {
	if (!iso) {
		return null;
	}
	const date = new Date(iso);
	return Number.isNaN(date.getTime()) ? null : date;
}

/**
 * Spec §4.4 rows 1–2 for one verdict, AFTER terminal handling. Returns the
 * outcome to tally, or null when the verdict produces none (terminal, an
 * UNHIDE proposal, a story that no longer exists, or a REST verdict fetched
 * with the switch off, which the leaf reports as not observed).
 */
async function syncMappedStatus(args: {
	projectId: string;
	tenant: { organizationId: string | null; userId: string | null };
	item: PmWorkItemState;
	storyId: string;
	terminal: ReconcileStoryTerminalResult;
	run: StatusSyncRun;
}): Promise<StatusSyncOutcome | null> {
	const { projectId, tenant, item, storyId, terminal, run } = args;
	const syncsStatus =
		terminal.action === "non-terminal-passthrough" ||
		terminal.action === "auto-unhid";
	// Row 2 — an UNHIDE proposal (or anything else terminal handling kept for review).
	if (!terminal.terminalApplied && !syncsStatus) {
		return null;
	}
	// D2.5 — read after terminal handling, so it sees what that wrote.
	const story = await db.userStory.findUnique({
		where: { id: storyId, projectId },
		select: STATUS_SYNC_STORY_SELECT,
	});
	if (!story) {
		return null;
	}
	const stateChangedDate = parseVerdictDate(item.stateChangedDate);

	if (terminal.terminalApplied) {
		// Row 1 — record the terminal observation so the reopen counts (AC6).
		const linkKey = statusSyncLinkKey(story, run.source.isRest);
		if (linkKey !== null) {
			await recordTerminalObservation({
				projectId,
				story,
				linkKey,
				stateChangedDate,
			});
		}
		return null;
	}

	const needsOrg = !run.source.isRest && story.externalMcpServerId === null;
	const { outcome } = await reconcileStoryMappedStatus({
		projectId,
		tenant: {
			organizationId: tenant.organizationId,
			ownerUserId: tenant.userId,
		},
		item: {
			externalId: item.externalId,
			state: item.state,
			labels: item.labels ?? [],
			stateChangedDate,
			// Passed through UNCHANGED (D2.3): an absent key means this verdict
			// was fetched with the switch off, which the leaf reports as not
			// observed (outcome null); null means the issue had no URL. So the
			// key is copied only when present — `?? null` would turn an absent
			// key into an "unverified" CONFLICT row.
			...("itemUrl" in item ? { itemUrl: item.itemUrl } : {}),
		},
		story,
		config: run.config,
		source: {
			...run.source,
			activeOrg: needsOrg ? await run.activeOrg() : null,
		},
	});
	// null = not observed: the caller tallies nothing.
	return outcome;
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
 * With the project's status sync on (Fizzy #2304), each item then goes through
 * `syncMappedStatus` — after terminal handling, never instead of it — and the
 * run's outcome counts are recorded in the last-run summary.
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
			// Fizzy #2304 D2.4 — mapped-status sync.
			pmStatusSyncEnabled: true,
			pmStatusSyncSessionAt: true,
			projectManagementAdditionalContext: true,
			projectManagementMcpServerId: true,
			projectManagementMcpConfigId: true,
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

	// Fizzy #2304 — resolved ONCE per run, never per item. Null = switch off:
	// nothing below reads or writes anything for status sync.
	const statusSync = await loadStatusSyncRun(
		projectId,
		project,
		input.pmTool ?? null,
	);
	const outcomeCounts = statusSync ? emptyOutcomeCounts() : null;

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

		// Fizzy #2304 — spec §4.4, AFTER terminal handling: terminal keeps
		// absolute precedence, and the story read sees what it wrote.
		if (statusSync && outcomeCounts) {
			// Isolated per story: a status-sync failure on one story must never
			// stop terminal handling for the stories after it, nor the outcome
			// summary below. The failed story is logged and not counted; the
			// next poll decides it again from fresh state.
			try {
				const outcome = await syncMappedStatus({
					projectId,
					tenant,
					item,
					storyId: storyFabricItem.entityId,
					terminal: r,
					run: statusSync,
				});
				if (outcome !== null) {
					outcomeCounts[outcome]++;
				}
			} catch (error) {
				logger.error(
					"[PM Poll] Status sync failed for a story; continuing with the next",
					{
						projectId,
						storyId: storyFabricItem.entityId,
						// The message only — never the stack — and scrubbed.
						error: scrubSecrets(
							error instanceof Error
								? error.message
								: String(error),
						),
					},
				);
			}
		}
	}

	// Fizzy #2304 D2.6 — the outcome half of the last-run summary, against the
	// session read at the START of this run (never re-read here).
	if (statusSync?.sessionAt && outcomeCounts) {
		await mergePmStatusSyncLastRun({
			projectId,
			sessionAt: statusSync.sessionAt,
			patch: {
				outcome: {
					at: new Date().toISOString(),
					counts: outcomeCounts,
				},
			},
		});
	}

	logger.info("[PM Poll] Reconciliation complete", {
		projectId,
		itemsProcessed: items.length,
		pendingChangesCreated,
		storiesAutoHidden,
		// Logged only — NOT on ReconcileAdoStatesResult: a result field the
		// workflow read would break Temporal replay.
		statusSyncOutcomes: outcomeCounts,
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

// =============================================================================
// Generation-queue visibility (Fizzy #2199, FR29)
// =============================================================================

/**
 * Open and close this poll's Job Hub row, so the generation queue can see that
 * a project-management scan is in flight.
 *
 * The PM sync log cannot answer that question. Its status vocabulary is
 * SUCCESS, FAILURE and CONFLICT — all outcomes — and a row is written when an
 * attempt finishes, so while a scan runs there is nothing in the database to
 * read. Document generation could therefore start against a backlog it was
 * about to receive, which hurts most on exactly the projects where the backlog
 * is the best documentation there is.
 *
 * A background job carries `heartbeatAt`, which is the column the queue's
 * outstanding arms already read and the background-job watchdog already sweeps.
 * Using it means a generation stops waiting on a dead poll at the same moment
 * the watchdog gives up on it, rather than on a second timer of its own.
 *
 * Failures are swallowed here, deliberately. This row exists to make a wait
 * visible; a poll that cannot write it should still poll, and turning a
 * bookkeeping failure into a retried activity would put the real work through
 * its retry budget for the sake of a caption.
 */
export async function reportPmScanJobOpened(params: {
	projectId: string;
	userId: string;
	organizationId?: string | null;
	containerName?: string | null;
}): Promise<void> {
	const container = params.containerName?.trim();
	await jobEnsure({
		kind: "PM_STATE_POLL",
		title: container
			? `Project management scan · ${container}`
			: "Project management scan",
		projectId: params.projectId,
		userId: params.userId,
		organizationId: params.organizationId,
		// One poll per project at a time, so the project is identity enough —
		// unlike document generation, where two documents can run at once.
		sourceId: params.projectId,
		steps: seedJobSteps([...JOB_STEPS.pmStatePoll]),
	});
}

export async function reportPmScanJobClosed(params: {
	projectId: string;
	error?: string;
}): Promise<void> {
	const sourceId = params.projectId;
	if (params.error) {
		await jobStep("reconcile", "failed", { sourceId, error: params.error });
		await jobFail(params.error, { sourceId });
		return;
	}
	await jobStep("reconcile", "completed", { sourceId });
	await jobComplete({ sourceId });
}
