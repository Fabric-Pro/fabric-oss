/**
 * Queries for BacklogProposalDraft — the server-persisted, per-kind AI draft of
 * a pending proposal's body.
 *
 * The in-review "draft this proposal through the project's prompt" step is a
 * ~minute-long LLM call. Persisting it here means a draft runs ONCE per
 * (proposal, kind) across all users / tabs / sessions, instead of re-running on
 * every open. The `(proposalId, kind)` unique key is the atomic claim that makes
 * concurrent triggers race-safe; `startedAt` is the shared clock for the live
 * "drafting" counter.
 */

import { db } from "../../client";
import type { BacklogProposalDraft } from "../../generated/client";
import { Prisma } from "../../generated/client";
import type { StoryKind } from "../../generated/enums";

function isUniqueViolation(err: unknown): boolean {
	return (
		err instanceof Prisma.PrismaClientKnownRequestError &&
		err.code === "P2002"
	);
}

const ACTIVE_OR_DONE = ["RUNNING", "COMPLETED"] as const;

/**
 * Atomically claim the draft slot for (proposalId, kind).
 *
 * Returns `{ draft, claimed }`. `claimed` is true ONLY for the single caller
 * that actually started (or restarted) the draft — that caller is responsible
 * for kicking off the draft workflow. Every concurrent caller (other tabs /
 * users) gets `claimed: false` and the existing row, so we never start a
 * duplicate draft or double-spend.
 *
 * - No row yet → insert RUNNING (first caller wins; the unique key turns a
 *   concurrent insert into a P2002 we recover from by reading the winner's row).
 * - RUNNING / COMPLETED row → reuse it (claimed: false).
 * - FAILED / CANCELLED row → compare-and-set back to RUNNING so exactly one
 *   caller restarts it.
 */
export async function claimProposalDraft(params: {
	proposalId: string;
	kind: StoryKind;
	createdBy?: string;
}): Promise<{ draft: BacklogProposalDraft; claimed: boolean }> {
	const where = {
		proposalId_kind: {
			proposalId: params.proposalId,
			kind: params.kind,
		},
	};

	const existing = await db.backlogProposalDraft.findUnique({ where });
	if (
		existing &&
		(ACTIVE_OR_DONE as readonly string[]).includes(existing.status)
	) {
		return { draft: existing, claimed: false };
	}

	if (!existing) {
		try {
			const created = await db.backlogProposalDraft.create({
				data: {
					proposalId: params.proposalId,
					kind: params.kind,
					status: "RUNNING",
					createdBy: params.createdBy,
				},
			});
			return { draft: created, claimed: true };
		} catch (err) {
			if (!isUniqueViolation(err)) {
				throw err;
			}
			// Lost the insert race — fall through to inspect the winner's row.
			const raced = await db.backlogProposalDraft.findUnique({ where });
			if (
				raced &&
				(ACTIVE_OR_DONE as readonly string[]).includes(raced.status)
			) {
				return { draft: raced, claimed: false };
			}
			// Winner left a terminal row — re-claim below.
		}
	}

	// Re-claim a terminal (FAILED / CANCELLED) row. Compare-and-set on the
	// terminal status so only one concurrent re-claimer flips it to RUNNING.
	const reset = await db.backlogProposalDraft.updateMany({
		where: {
			proposalId: params.proposalId,
			kind: params.kind,
			status: { in: ["FAILED", "CANCELLED"] },
		},
		data: {
			status: "RUNNING",
			startedAt: new Date(),
			completedAt: null,
			description: null,
			acceptanceCriteria: null,
			needsMoreInfo: null,
			workflowId: null,
			error: null,
			createdBy: params.createdBy,
		},
	});
	const draft = await db.backlogProposalDraft.findUniqueOrThrow({ where });
	return { draft, claimed: reset.count === 1 };
}

/** All draft rows for a proposal (both kinds), for the inbox poll. */
export async function getProposalDrafts(
	proposalId: string,
): Promise<BacklogProposalDraft[]> {
	return await db.backlogProposalDraft.findMany({
		where: { proposalId },
	});
}

export async function getProposalDraft(params: {
	proposalId: string;
	kind: StoryKind;
}): Promise<BacklogProposalDraft | null> {
	return await db.backlogProposalDraft.findUnique({
		where: {
			proposalId_kind: {
				proposalId: params.proposalId,
				kind: params.kind,
			},
		},
	});
}

/** Stamp the Temporal workflow id once it's started (for later cancellation). */
export async function setProposalDraftWorkflowId(params: {
	proposalId: string;
	kind: StoryKind;
	workflowId: string;
}): Promise<void> {
	// Scope to RUNNING so a late stamp can't resurrect a cancelled/finished row.
	await db.backlogProposalDraft.updateMany({
		where: {
			proposalId: params.proposalId,
			kind: params.kind,
			status: "RUNNING",
		},
		data: { workflowId: params.workflowId },
	});
}

/**
 * Persist a finished draft. Compare-and-set on RUNNING so a result that arrives
 * after the draft was cancelled (race) is dropped rather than overwriting the
 * CANCELLED state. Returns true when the COMPLETED write actually landed.
 */
export async function completeProposalDraft(params: {
	proposalId: string;
	kind: StoryKind;
	description: string;
	acceptanceCriteria?: string | null;
	needsMoreInfo?: boolean | null;
}): Promise<boolean> {
	const res = await db.backlogProposalDraft.updateMany({
		where: {
			proposalId: params.proposalId,
			kind: params.kind,
			status: "RUNNING",
		},
		data: {
			status: "COMPLETED",
			description: params.description,
			acceptanceCriteria: params.acceptanceCriteria ?? null,
			needsMoreInfo: params.needsMoreInfo ?? null,
			completedAt: new Date(),
		},
	});
	return res.count === 1;
}

export async function failProposalDraft(params: {
	proposalId: string;
	kind: StoryKind;
	error: string;
}): Promise<void> {
	await db.backlogProposalDraft.updateMany({
		where: {
			proposalId: params.proposalId,
			kind: params.kind,
			status: "RUNNING",
		},
		data: {
			status: "FAILED",
			error: params.error.slice(0, 4000),
			completedAt: new Date(),
		},
	});
}

/**
 * Mark a RUNNING draft CANCELLED and return its workflowId so the caller can
 * cancel the Temporal workflow (best-effort abort of the in-flight LLM call).
 * Returns null when there was no RUNNING draft to cancel.
 */
export async function cancelProposalDraft(params: {
	proposalId: string;
	kind: StoryKind;
}): Promise<{ workflowId: string | null } | null> {
	const running = await db.backlogProposalDraft.findUnique({
		where: {
			proposalId_kind: {
				proposalId: params.proposalId,
				kind: params.kind,
			},
		},
	});
	if (!running || running.status !== "RUNNING") {
		return null;
	}
	const res = await db.backlogProposalDraft.updateMany({
		where: {
			proposalId: params.proposalId,
			kind: params.kind,
			status: "RUNNING",
		},
		data: { status: "CANCELLED", completedAt: new Date() },
	});
	if (res.count !== 1) {
		return null; // lost the race to another terminal transition
	}
	return { workflowId: running.workflowId };
}
