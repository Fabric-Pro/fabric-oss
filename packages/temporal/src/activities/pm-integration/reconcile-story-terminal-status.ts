/**
 * STORY-only terminal-status reconcile (leaf module).
 *
 * Extracted from `pm-state-poll.ts`'s `reconcileAdoStates` so the same logic can
 * be shared by the per-item "Pull from {tool}" sync paths (#1360) WITHOUT a
 * static import cycle: `pm-state-poll.ts` imports `fetchPMItemsByIds` from
 * `story-sync.ts`, and `extract-pm-item-state.ts` imports runtime helpers from
 * `story-sync.ts`, so putting this helper in `pm-state-poll.ts` and importing it
 * back into `story-sync.ts` would close a cycle. This module is a LEAF: it
 * imports ONLY `@repo/database` (`db`, `applyTerminalClose`,
 * `applyTerminalUnhide`, `upsertPendingChange`) + `recordAudit`, and NEVER
 * `./story-sync` — so both `pm-state-poll.ts` and `story-sync.ts` import it
 * cleanly.
 *
 * Behavior-preserving: this is a verbatim lift of the prior STORY branch
 * (snapshot the checkmark → reopen-of-auto-hidden unhide/propose → auto-close),
 * adapted to the guarded `{ applied }` return of `applyTerminalClose` /
 * `applyTerminalUnhide` (the audit + result `action` now reflect whether the
 * lifecycle write actually applied).
 */
import {
	applyTerminalClose,
	applyTerminalUnhide,
	clearPendingContentDrift,
	db,
	recordAudit,
	upsertPendingChange,
} from "@repo/database";

// =============================================================================
// Types (moved from pm-state-poll.ts so this leaf owns them; re-exported there)
// =============================================================================

export interface PmWorkItemState {
	externalId: string;
	/** Normalized status string; "" when the tool has no string status (GitLab). */
	state: string;
	stateChangedDate: string | null;
	/** GitLab native close (null for tools without a binary state). */
	isClosed?: boolean | null;
	/** Labels — kept (small) so reconcile can revalidate label-based terminals. */
	labels?: string[];
	/** Fetch-time classification snapshot (#1741 Codex round-1). Poll-only — the
	 *  per-item Pull path leaves it unset. Reconcile compares it to a fresh
	 *  re-derivation to detect mid-cycle story-state drift; it is NOT applied. */
	classification?: PmItemClassification;
}

/** The Fabric entity a polled ADO item resolves to (from `findFabricItemByExternalId`). */
export interface FabricItemRef {
	entityType: "EPIC" | "FEATURE" | "STORY";
	entityId: string;
	draftingStage: string;
	lastSyncedPmHash: string | null;
	lastPmSyncStatus: string | null;
	/** Auto-hide provenance marker (set on auto-close); drives reopen-unhide. */
	pmAutoHidden?: boolean;
	/**
	 * Current DB values of the terminal-status checkmark, used to skip a no-op
	 * `userStory.update` when the reconciled values would not change anything.
	 * OPTIONAL: sites that build this ref by hand (rather than spreading the
	 * result of `findFabricItemByExternalId`) leave these unset, and the write
	 * is always performed in that case (fail-safe).
	 */
	pmTicketTerminal?: boolean;
	pmTicketTerminalStatus?: string | null;
}

export interface ReconcileStoryTerminalInput {
	projectId: string;
	item: PmWorkItemState;
	fabricItem: FabricItemRef;
	terminalLc: Set<string>;
	autoCloseEnabled: boolean;
	tenant: { organizationId: string | null; userId: string | null };
}

export interface ReconcileStoryTerminalResult {
	terminalApplied: boolean;
	action:
		| "checkmark-only"
		| "auto-hidden"
		| "auto-unhid"
		| "unhide-proposed"
		| "already-applied"
		| "non-terminal-passthrough";
	pendingChangesCreated: number;
	terminalStatusLabel: string | null;
}

export type PmItemClassification = "terminal" | "reopen" | "passthrough";

/**
 * Pure terminal/reopen/passthrough classifier.
 * Single source of truth for the predicate, shared by the poll's fetch
 * classifier (`pm-state-poll.ts`) and `reconcileStoryTerminalStatus` below.
 * Precedence: terminal (status-in-set OR native close OR terminal label) beats
 * reopen (non-terminal + CLOSED + pmAutoHidden) beats passthrough. Case-insensitive.
 */
export function classifyPmItem(
	item: { state: string; isClosed?: boolean | null; labels?: string[] },
	fabricItem: { draftingStage: string; pmAutoHidden?: boolean },
	terminalLc: Set<string>,
): {
	classification: PmItemClassification;
	terminalStatusLabel: string | null;
} {
	const labels = item.labels ?? [];
	const matchedLabel = labels.find((l) => terminalLc.has(l.toLowerCase()));
	const statusMatches =
		item.state.length > 0 && terminalLc.has(item.state.toLowerCase());
	const isTerminal =
		statusMatches || item.isClosed === true || Boolean(matchedLabel);

	if (isTerminal) {
		// Snapshot the value that ACTUALLY made it terminal (precedence: status
		// string → matched label → raw "closed"). NOT hardcoded "Closed".
		const terminalStatusLabel = statusMatches
			? item.state
			: matchedLabel
				? matchedLabel
				: item.isClosed === true
					? "closed"
					: null;
		return { classification: "terminal", terminalStatusLabel };
	}

	if (
		fabricItem.draftingStage === "CLOSED" &&
		fabricItem.pmAutoHidden === true
	) {
		return { classification: "reopen", terminalStatusLabel: null };
	}

	return { classification: "passthrough", terminalStatusLabel: null };
}

/**
 * Reconcile a single STORY's terminal status against its linked PM item.
 *
 * Snapshots `pmTicketTerminal` for the roadmap checkmark, then:
 * - non-terminal + reopen-of-auto-hidden → auto-unhide (autoClose on) or propose
 *   UNHIDE (off);
 * - non-terminal otherwise → `non-terminal-passthrough` (the caller runs the
 *   content-drift pass; the per-item Pull no-ops);
 * - terminal + autoClose on + not already CLOSED → auto-close (hide);
 * - terminal + autoClose off → `checkmark-only`.
 *
 * On any terminal item it also clears the story's pending CONTENT_DRIFT review
 * rows (`clearPendingContentDrift`) so a Done/Closed ticket carries no dangling
 * drift proposal.
 *
 * STORY-only — EPIC/FEATURE keep their inline propose-then-review path in
 * `reconcileAdoStates`.
 */
export async function reconcileStoryTerminalStatus(
	input: ReconcileStoryTerminalInput,
): Promise<ReconcileStoryTerminalResult> {
	const {
		projectId,
		item,
		fabricItem,
		terminalLc,
		autoCloseEnabled,
		tenant,
	} = input;

	// Shared predicate (single source of truth with the poll's fetch classifier).
	const { classification, terminalStatusLabel } = classifyPmItem(
		item,
		fabricItem,
		terminalLc,
	);
	const isTerminal = classification === "terminal";
	const targetTerminalStatus = isTerminal ? terminalStatusLabel : null;

	// Skip the write when the checkmark would not change. The hourly poll runs
	// this for every linked story every cycle regardless of whether the PM
	// state moved, which was rewriting all 1,333 rows in a project every hour
	// (238,993 UPDATEs / 14 days in prod) and bumping `@updatedAt` on stories
	// that never actually changed, making `updatedAt` meaningless for them.
	// Either field `undefined` means the caller built this ref by hand (not
	// from `findFabricItemByExternalId`) — fail safe and always write. Both
	// must be present: a partial snapshot must not be mistaken for a match.
	const isNoOpWrite =
		fabricItem.pmTicketTerminal !== undefined &&
		fabricItem.pmTicketTerminalStatus !== undefined &&
		fabricItem.pmTicketTerminal === isTerminal &&
		fabricItem.pmTicketTerminalStatus === targetTerminalStatus;

	if (!isNoOpWrite) {
		await db.userStory.update({
			where: { id: fabricItem.entityId, projectId },
			data: {
				pmTicketTerminal: isTerminal,
				pmTicketTerminalStatus: targetTerminalStatus,
			},
		});
	}

	if (classification === "terminal") {
		// A Done/Closed ticket must not carry a dangling content-drift review.
		await clearPendingContentDrift({
			projectId,
			entityType: fabricItem.entityType,
			entityId: fabricItem.entityId,
		});

		if (autoCloseEnabled && fabricItem.draftingStage !== "CLOSED") {
			const { applied } = await applyTerminalClose({
				entityType: "STORY",
				entityId: fabricItem.entityId,
				projectId,
				userId: tenant.userId,
				organizationId: tenant.organizationId,
				changeDescription: `Auto-closed: PM ticket reached terminal status "${terminalStatusLabel ?? item.state}"`,
				markAutoHidden: true,
			});
			if (applied) {
				recordAudit({
					action: "story.auto_hidden",
					category: "story",
					actor: { type: "system" },
					organizationId: tenant.organizationId,
					projectId,
					resource: { type: "story", id: fabricItem.entityId },
					metadata: {
						externalId: item.externalId,
						previousStage: fabricItem.draftingStage,
						newStage: "CLOSED",
						terminalStatus: terminalStatusLabel ?? item.state,
					},
				});
			}
			return {
				terminalApplied: true,
				action: applied ? "auto-hidden" : "already-applied",
				pendingChangesCreated: 0,
				terminalStatusLabel,
			};
		}

		return {
			terminalApplied: true,
			action: "checkmark-only",
			pendingChangesCreated: 0,
			terminalStatusLabel,
		};
	}

	if (classification === "reopen") {
		if (autoCloseEnabled) {
			const { applied } = await applyTerminalUnhide({
				entityType: "STORY",
				entityId: fabricItem.entityId,
				projectId,
				userId: tenant.userId,
				organizationId: tenant.organizationId,
				changeDescription: `Auto-unhidden: PM ticket reopened to "${item.state || "open"}"`,
			});
			if (applied) {
				recordAudit({
					action: "story.auto_unhidden",
					category: "story",
					actor: { type: "system" },
					organizationId: tenant.organizationId,
					projectId,
					resource: { type: "story", id: fabricItem.entityId },
					metadata: {
						externalId: item.externalId,
						previousStage: "CLOSED",
						newStage: "DRAFT",
						reopenedStatus: item.state || "open",
					},
				});
			}
			return {
				terminalApplied: false,
				action: applied ? "auto-unhid" : "already-applied",
				pendingChangesCreated: 0,
				terminalStatusLabel: null,
			};
		}
		const result = await upsertPendingChange({
			projectId,
			entityType: fabricItem.entityType,
			entityId: fabricItem.entityId,
			externalId: item.externalId,
			previousState: fabricItem.draftingStage,
			newState: item.state || "open",
			proposedAction: "UNHIDE",
		});
		// Mirror the HIDE path so the reconcile counter the workflow consumes
		// reflects UNHIDE proposals.
		const counted =
			result.action === "created" || result.action === "updated" ? 1 : 0;
		return {
			terminalApplied: false,
			action: "unhide-proposed",
			pendingChangesCreated: counted,
			terminalStatusLabel: null,
		};
	}

	return {
		terminalApplied: false,
		action: "non-terminal-passthrough",
		pendingChangesCreated: 0,
		terminalStatusLabel: null,
	};
}
