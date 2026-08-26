/**
 * Server-authoritative override logging for the decision pre-check.
 *
 * When a reviewer accepts AI output that contradicts a logged architecture
 * decision, the accept/apply procedure (backlog) or the acknowledge procedure
 * (document) records one immutable `decision.override_accepted` row in the WORM
 * audit ledger PER conflicting decision, so the admin Overrides list maps 1:1 to
 * decisions and every row shares the same `metadata.artifactId`.
 *
 * The write is:
 *  - server-authoritative — driven off the persisted findings, not client input,
 *    so a client cannot suppress it;
 *  - best-effort — routed through `recordAuditFromRequest`, which never throws,
 *    so a failed audit write can never block the accept.
 */

import type {
	DecisionConflictFinding,
	DecisionPrecheckResult,
} from "@repo/agent-types";

// Re-export the canonical narrower (implementation in `@repo/agent-types`,
// shared with the web warning surfaces) so this module stays the single
// API-side import surface for the override-audit path.
export { extractDecisionPrecheck } from "@repo/agent-types";

import {
	type AuditRequestContext,
	recordAuditFromRequest,
} from "../../../lib/audit";

/** Serialized-length ceiling for the per-record output snapshot (keeps WORM rows lean). */
const OUTPUT_SNAPSHOT_MAX_CHARS = 2000;

/**
 * The approved change a finding attributes to. A finding's `changeRef.index` is
 * the position in the FULL analysis-time proposal, but a reviewer can approve
 * only a SUBSET of the proposed changes, so we correlate by the stable change
 * title instead of the index. Returns undefined when the finding's change was
 * deselected (not in `approvedChanges`) or carries no title to match on.
 */
export function findApprovedChangeForFinding<
	T extends { title: { to: string } },
>(finding: DecisionConflictFinding, approvedChanges: T[]): T | undefined {
	const title = finding.changeRef?.title?.trim();
	if (!title) {
		return undefined;
	}
	return approvedChanges.find((change) => change.title.to.trim() === title);
}

/**
 * Keep only the pre-check findings whose change was actually approved+applied,
 * correlating each finding to an approved change by its stable title. Shared by
 * all three override paths (AI-Update apply + Slack/Teams monitor approve) so a
 * reviewer who DESELECTED the conflicting change never logs an override row for
 * it. `findings` is empty when nothing survives — the override write then no-ops.
 */
export function filterFindingsToApprovedChanges(
	precheck: DecisionPrecheckResult,
	approvedChanges: Array<{ title: { to: string } }>,
): DecisionPrecheckResult {
	const findings = precheck.findings.filter(
		(finding) =>
			findApprovedChangeForFinding(finding, approvedChanges) !==
			undefined,
	);
	return { ...precheck, findings };
}

/**
 * Build the decision pre-check artifact items for a set of approved backlog
 * changes — one entry per change, `ref.index` preserving position and `text`
 * flattening the reviewer-facing fields (`to` sides of the diff shapes plus the
 * reasoning). Mirrors the temporal-side `buildBacklogPrecheckItems` (identical
 * field set + join) so the apply-time authoritative re-check judges the SAME
 * inputs as the analysis-time check. Used only when the client relayed no
 * ride-along result (fast apply before the async judge folded, or the chat
 * "skip analysis" path that never analyzed) — otherwise the relayed result is
 * trusted (and re-resolved against the DB) without re-running the judge.
 */
export function buildBacklogPrecheckItems(
	changes: Array<{
		title: { to: string };
		description?: { to: string } | null;
		acceptanceCriteria?: { to: string } | null;
		reasoning?: string | null;
	}>,
): Array<{ ref: { index: number; title?: string }; text: string }> {
	return changes.map((change, index) => ({
		ref: { index, title: change.title.to },
		text: [
			change.title.to,
			change.description?.to,
			change.acceptanceCriteria?.to,
			change.reasoning,
		]
			.filter(
				(value): value is string =>
					typeof value === "string" && value.trim().length > 0,
			)
			.join("\n\n"),
	}));
}

type DecisionOverrideSurface = "backlog_proposal" | "document";

export interface DecisionOverrideAuditParams {
	projectId: string;
	/** Org id in org context; null/undefined in personal context (XOR). */
	organizationId?: string | null;
	surface: DecisionOverrideSurface;
	/** Resource kind of the accepted artifact, e.g. `pending_backlog_proposal` / `project_document`. */
	artifactType: string;
	/** Shared across every per-decision row for this one accept event. */
	artifactId: string;
	/** Persisted findings for the artifact; null/`ok`/empty ⇒ nothing to log. */
	precheck: DecisionPrecheckResult | null | undefined;
	/** Produce the bounded contradicting-text snapshot for a given finding. */
	resolveSnapshot: (finding: DecisionConflictFinding) => string;
}

/**
 * Best-effort text snapshot of a single backlog change, tolerating both the diff
 * (`{ from?, to }`) and legacy plain-string title/description shapes. Returns ""
 * for a missing or non-object change.
 */
export function snapshotBacklogChange(change: unknown): string {
	if (!change || typeof change !== "object") {
		return "";
	}
	const record = change as Record<string, unknown>;
	return [readDiffText(record.title), readDiffText(record.description)]
		.filter((part) => part.length > 0)
		.join("\n\n");
}

/**
 * Snapshot the change a finding applies to by its `changeRef.index` position in
 * the stored FULL proposal changes. Correct for the monitor approve paths, which
 * apply the whole persisted proposal, so `changeRef.index` still indexes the same
 * list. The AI-Update apply path relays only a re-indexed selected subset, so it
 * correlates by change title and snapshots via `snapshotBacklogChange` directly.
 */
export function backlogChangeSnapshot(
	changes: unknown,
	finding: DecisionConflictFinding,
): string {
	if (!Array.isArray(changes)) {
		return "";
	}
	const index = finding.changeRef?.index;
	const change =
		typeof index === "number" ? (changes[index] as unknown) : undefined;
	return snapshotBacklogChange(change);
}

function readDiffText(value: unknown): string {
	if (typeof value === "string") {
		return value.trim();
	}
	if (value && typeof value === "object" && !Array.isArray(value)) {
		const to = (value as { to?: unknown }).to;
		if (typeof to === "string") {
			return to.trim();
		}
	}
	return "";
}

/**
 * Write the immutable override record(s) for an accepted artifact. One row per
 * conflicting decision (grouped by `decisionId`); a decision that conflicts with
 * several changes collapses into a single row whose `metadata.findings[]` holds
 * every occurrence. No-op when there are no unresolved conflicts.
 */
export function recordDecisionOverridesAccepted(
	context: AuditRequestContext,
	params: DecisionOverrideAuditParams,
): void {
	const precheck = params.precheck;
	if (!precheck || precheck.status !== "conflicts") {
		return;
	}
	const findings = precheck.findings ?? [];
	if (findings.length === 0) {
		return;
	}

	const byDecision = new Map<string, DecisionConflictFinding[]>();
	for (const finding of findings) {
		if (!finding.decisionId) {
			continue;
		}
		const existing = byDecision.get(finding.decisionId);
		if (existing) {
			existing.push(finding);
		} else {
			byDecision.set(finding.decisionId, [finding]);
		}
	}

	for (const [decisionId, group] of byDecision) {
		const primary = group[0];
		if (!primary) {
			continue;
		}
		try {
			recordAuditFromRequest(context, {
				action: "decision.override_accepted",
				category: "decision",
				severity: "warning",
				outcome: "success",
				// XOR: attach the org id only in org context; personal context omits it.
				...(params.organizationId
					? { organizationId: params.organizationId }
					: {}),
				projectId: params.projectId,
				resource: {
					type: "architecture_decision",
					id: decisionId,
					name: primary.decisionIdentifier,
				},
				metadata: {
					surface: params.surface,
					artifactType: params.artifactType,
					artifactId: params.artifactId,
					findings: group,
					decisionId,
					decisionIdentifier: primary.decisionIdentifier,
					decisionTitle: primary.decisionTitle,
					natureOfConflict: primary.natureOfConflict,
					conflictType: primary.conflictType,
					confidence: primary.confidence,
					...(primary.changeRef
						? { changeRef: primary.changeRef }
						: {}),
					outputSnapshot: boundSnapshot(
						safeSnapshot(params, primary),
					),
				},
			});
		} catch {
			// `recordAuditFromRequest` is contractually non-throwing; this guard
			// keeps even a pathological failure from blocking the accept and lets
			// the remaining per-decision rows still be attempted (golden rule).
		}
	}
}

function safeSnapshot(
	params: DecisionOverrideAuditParams,
	finding: DecisionConflictFinding,
): string {
	try {
		return params.resolveSnapshot(finding);
	} catch {
		// A snapshot resolver must never break the override write (or the accept).
		return "";
	}
}

function boundSnapshot(text: string): string {
	if (text.length <= OUTPUT_SNAPSHOT_MAX_CHARS) {
		return text;
	}
	return `${text.slice(0, OUTPUT_SNAPSHOT_MAX_CHARS)}…`;
}
