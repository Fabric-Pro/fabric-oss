/**
 * Keeping a test case honest as its feature changes.
 *
 * A case drafted from an acceptance criterion goes stale the moment that
 * criterion is rewritten, and nothing said so. The suite kept asserting a flow
 * the product no longer had — which is worse than having no coverage, because
 * it reads AS coverage and nobody goes looking.
 *
 * The shape here is deliberately the smallest thing that closes that:
 *
 *  - record WHAT a case was drafted from, as a hash of the feature text;
 *  - compare it to the feature's text now, to find cases that may have drifted;
 *  - hold one AI-proposed replacement per case, which a human accepts or
 *    rejects — the same posture as PROPOSED cases, and for the same reason: an
 *    AI may propose a change to the suite, never make one.
 */

import { createHash } from "node:crypto";
import { db, Prisma } from "../../client";
import type { TestCaseProposalSource } from "../../generated/enums";
import { updateTestCase } from "./test-cases";

/**
 * Fingerprint of the feature text a case was drafted from.
 *
 * A hash rather than a timestamp, because a feature saved twice with no textual
 * change must not make every case it covers look stale — a staleness signal that
 * cries wolf is one people learn to dismiss, which is exactly the failure this
 * is meant to prevent.
 *
 * Whitespace is normalised so a reflow or an indentation change is not a
 * rewrite. Exported for its own tests: what counts as "the same text" is the
 * whole behaviour.
 */
export function fingerprintSpecText(input: {
	title: string;
	description?: string | null;
	acceptanceCriteria?: string | null;
}): string {
	const normalised = [
		input.title,
		input.description ?? "",
		input.acceptanceCriteria ?? "",
	]
		.join("\n")
		.replace(/\s+/g, " ")
		.trim()
		.toLowerCase();
	return createHash("sha256").update(normalised).digest("hex").slice(0, 32);
}

export interface DriftedCase {
	id: string;
	identifier: string;
	title: string;
	/** The hash the case carries, for the caller to report against. */
	draftedFromSpecHash: string | null;
	hasProposal: boolean;
	/**
	 * The case was drafted from feature text that has since changed.
	 *
	 * False for a case that is listed only because it carries an outstanding
	 * proposal — a hand-authored one revised against the implementation, say.
	 * The caller uses this to avoid offering "revise against the spec" for a
	 * case that never had a spec fingerprint to drift from.
	 */
	isSpecDrifted: boolean;
}

/**
 * Cases on this feature that are waiting for somebody: drifted from the feature
 * text, or carrying an AI proposal nobody has accepted or rejected yet.
 *
 * The second half is not a convenience. A proposal is only reachable through
 * this list, so a case that can hold one but never appears here is a case whose
 * Accept and Reject buttons do not exist — the proposal would be written, billed
 * and then stranded. Revising against the IMPLEMENTATION can be asked of any
 * case, including a hand-authored one, so the list has to be able to show a case
 * that never drifted.
 *
 * A case with no hash and no proposal is still excluded: it was never derived
 * from the feature text, so it cannot have drifted from it, and flagging it
 * would be telling somebody their own work is out of date.
 */
export async function listDriftedTestCases(input: {
	projectId: string;
	storyId: string;
	currentSpecHash: string;
}): Promise<DriftedCase[]> {
	const rows = await db.testCase.findMany({
		where: {
			projectId: input.projectId,
			deletedAt: null,
			// A CLOSED case is retired; re-proposing steps for it would be work
			// nobody asked for on something already decided.
			state: { notIn: ["CLOSED"] },
			workItemLinks: { some: { userStoryId: input.storyId } },
			OR: [
				{
					draftedFromSpecHash: { not: null },
					NOT: { draftedFromSpecHash: input.currentSpecHash },
				},
				{ proposedSteps: { not: Prisma.DbNull } },
			],
		},
		select: {
			id: true,
			identifier: true,
			title: true,
			draftedFromSpecHash: true,
			proposedSteps: true,
		},
		orderBy: { identifier: "asc" },
	});
	return rows.map((r) => ({
		id: r.id,
		identifier: r.identifier,
		title: r.title,
		draftedFromSpecHash: r.draftedFromSpecHash,
		hasProposal: r.proposedSteps !== null,
		isSpecDrifted:
			r.draftedFromSpecHash !== null &&
			r.draftedFromSpecHash !== input.currentSpecHash,
	}));
}

/**
 * Store an AI-proposed replacement for a case's steps, pending review.
 *
 * `source` records what the proposal was checked against, and is read back by
 * {@link acceptTestCaseStepProposal} to decide whether accepting it also clears
 * the case's spec-drift flag. It is written here rather than passed to accept
 * because only the code that generated the proposal knows the answer.
 */
export async function proposeTestCaseSteps(input: {
	projectId: string;
	testCaseId: string;
	steps: unknown;
	source: TestCaseProposalSource;
	proposedAt?: Date;
}): Promise<boolean> {
	const { count } = await db.testCase.updateMany({
		// projectId in the WHERE is the tenant guard: an id from another project
		// matches nothing rather than being written across the boundary.
		where: { id: input.testCaseId, projectId: input.projectId },
		data: {
			proposedSteps: input.steps as never,
			proposedAt: input.proposedAt ?? new Date(),
			proposedFrom: input.source,
		},
	});
	return count > 0;
}

/**
 * Reject a proposal — clear it and leave the case exactly as it was.
 *
 * Deliberately does NOT re-stamp `draftedFromSpecHash`. Rejecting says "this
 * suggestion was wrong", not "this case is now up to date", and silently
 * marking it current would hide the drift until the next edit.
 */
export async function rejectTestCaseStepProposal(input: {
	projectId: string;
	testCaseId: string;
}): Promise<boolean> {
	const { count } = await db.testCase.updateMany({
		where: { id: input.testCaseId, projectId: input.projectId },
		// `Prisma.DbNull` writes SQL NULL into a Json column; a bare `null`
		// is a type error here, and `JsonNull` would store the JSON value
		// `null` — a proposal consisting of the word "null".
		data: { proposedSteps: Prisma.DbNull, proposedAt: null },
	});
	return count > 0;
}

/** One proposed step, as the drafter produces them. */
export interface ProposedStep {
	action: string;
	expected: string;
}

/** The pull request a coding run opened for a feature. */
export interface ImplementationPullRequest {
	prNumber: number;
	repositoryOwner: string;
	repositoryName: string;
	pullRequestUrl: string | null;
}

/**
 * The pull request that implemented a feature, if a coding run recorded one.
 *
 * `CodingRun.storyId → pullRequestNumber` is the only place Fabric knows which
 * pull request corresponds to which feature. Nothing else links the two: a
 * repository's PR list has no feature id on it, and the code index describes the
 * whole repository rather than one story's change.
 *
 * The MOST RECENT qualifying run wins. A feature reworked after review has more
 * than one, and the newest is the one whose diff describes what the product does
 * now — which is the entire question a revision-from-implementation asks.
 *
 * Runs missing owner or name are skipped rather than returned partial: the
 * caller needs all three to address the GitHub endpoint, and a row carrying a
 * number but no repository would fail later as "PR not found" and send somebody
 * looking in the wrong place. Run STATUS is deliberately not filtered on — a
 * recorded PR number means a pull request exists, and a run whose own status
 * later went to failed or cancelled still opened it.
 */
export async function findImplementationPullRequest(input: {
	projectId: string;
	storyId: string;
}): Promise<ImplementationPullRequest | null> {
	const run = await db.codingRun.findFirst({
		where: {
			projectId: input.projectId,
			storyId: input.storyId,
			pullRequestNumber: { not: null },
			repositoryOwner: { not: null },
			repositoryName: { not: null },
		},
		orderBy: { createdAt: "desc" },
		select: {
			pullRequestNumber: true,
			pullRequestUrl: true,
			repositoryOwner: true,
			repositoryName: true,
		},
	});
	if (
		!run?.pullRequestNumber ||
		!run.repositoryOwner ||
		!run.repositoryName
	) {
		return null;
	}
	return {
		prNumber: run.pullRequestNumber,
		repositoryOwner: run.repositoryOwner,
		repositoryName: run.repositoryName,
		pullRequestUrl: run.pullRequestUrl,
	};
}

/**
 * Accept a proposal: apply the steps, clear the proposal, and stamp the case as
 * current only when the proposal was checked against the spec.
 *
 * Goes through {@link updateTestCase} rather than writing steps here, so an
 * accepted proposal lands on exactly the same path as a human edit — the same
 * ordering, the same activity trail. A second step-writer would be a second set
 * of rules to keep in step with the first.
 *
 * `currentSpecHash` is stamped for a SPEC proposal: the case now matches the
 * feature text the proposal was generated from, so it is no longer drifted. It
 * is NOT stamped for an IMPLEMENTATION proposal — that revision read a pull
 * request and never looked at the spec, so a case revised from what shipped can
 * still be behind what was specified, and saying otherwise would clear a flag on
 * evidence nobody gathered. A REJECT stamps nothing either — see
 * {@link rejectTestCaseStepProposal}.
 *
 * The decision reads the stored `proposedFrom` rather than a caller flag, so the
 * one path that must not stamp cannot be made to stamp by a caller that forgot.
 * NULL means a proposal written before that column existed; all of those were
 * spec-derived.
 */
export async function acceptTestCaseStepProposal(input: {
	projectId: string;
	testCaseId: string;
	/** Recorded on the case's activity timeline, like any human edit. */
	actorUserId?: string | null;
	currentSpecHash: string;
}): Promise<{ applied: boolean; reason?: "NO_PROPOSAL" | "NOT_FOUND" }> {
	const existing = await db.testCase.findFirst({
		where: {
			id: input.testCaseId,
			projectId: input.projectId,
			deletedAt: null,
		},
		select: { proposedSteps: true, proposedFrom: true },
	});
	if (!existing) {
		return { applied: false, reason: "NOT_FOUND" };
	}
	const steps = existing.proposedSteps;
	if (!Array.isArray(steps) || steps.length === 0) {
		// Nothing to apply. Reported rather than treated as success, so a stale
		// button cannot silently blank a case's steps.
		return { applied: false, reason: "NO_PROPOSAL" };
	}

	const updated = await updateTestCase({
		id: input.testCaseId,
		projectId: input.projectId,
		actorUserId: input.actorUserId ?? null,
		data: {
			// Coerced field by field rather than cast: these came back as JSON,
			// so a malformed row must become an empty string, not a runtime
			// surprise inside the step writer.
			steps: (steps as unknown as ProposedStep[]).map((step) => ({
				action: String(step?.action ?? ""),
				expected: String(step?.expected ?? ""),
			})),
		},
	});
	if (!updated) {
		return { applied: false, reason: "NOT_FOUND" };
	}

	await db.testCase.updateMany({
		where: { id: input.testCaseId, projectId: input.projectId },
		data: {
			proposedSteps: Prisma.DbNull,
			proposedAt: null,
			proposedFrom: null,
			// Spread rather than a ternary yielding `undefined`: omitting the key
			// entirely is what leaves the column alone, and an explicit
			// `draftedFromSpecHash: undefined` reads to a future editor like a
			// value being cleared.
			...(existing.proposedFrom === "IMPLEMENTATION"
				? {}
				: { draftedFromSpecHash: input.currentSpecHash }),
		},
	});
	return { applied: true };
}
