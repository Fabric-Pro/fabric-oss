/**
 * Review a pull request end to end, with nobody present.
 *
 * The lenses have always been person-triggered: somebody opens a review and
 * presses Run. This is the same work driven by GitHub's own `pull_request`
 * event, for projects that asked for it, and it exists because the people who
 * need a review are on the pull request rather than in Fabric.
 *
 * Three properties hold it together:
 *
 *  - **It never throws at its caller.** A webhook that fails loudly teaches
 *    GitHub to retry and eventually to stop delivering. Every failure is caught,
 *    named in the returned summary, and logged.
 *  - **It spends nothing a project did not ask for.** Auto-review is off by
 *    default, and each lens still obeys its own switch. A project with the QA
 *    lens off gets the architecture lens alone, computed and free.
 *  - **It reads and posts through the connection somebody already connected**,
 *    attributed to whoever configured it. No ambient credential exists here.
 */

import { getProjectQaSettings, recordAudit } from "@repo/database";
import { logger } from "@repo/logs";
import {
	type PrReviewLensUnavailable,
	postReviewCommentForReview,
} from "./pr-review-comment";
import { runArchitectureLens, runQaLens } from "./pr-review-lenses";
import { readPullRequestIntoReview } from "./pr-review-read";
import { assertTestCasesFeatureEnabled } from "./test-cases-feature";

/** What one automatic run did, for the log line and the webhook's response. */
export interface AutoReviewOutcome {
	ran: boolean;
	/** Why it did not run, when it did not. Never a stack trace. */
	skipped?:
		| "feature-off"
		| "auto-review-off"
		| "no-lens-enabled"
		| "no-acting-user"
		| "settings-unavailable"
		| "read-failed"
		| "no-diff"
		| "already-reviewed";
	reviewId?: string;
	qaFindings?: number;
	architectureFindings?: number;
	commented?: boolean;
	/** The lenses had already run for this commit; only the comment was retried. */
	lensesSkipped?: boolean;
	error?: string;
}

export async function runAutomaticPrReview(input: {
	projectId: string;
	repositoryIntegrationId: string;
	prNumber: number;
	/** Whoever connected the repository. Null when nobody is recorded. */
	actingUserId: string | null;
	organizationId: string | null;
}): Promise<AutoReviewOutcome> {
	try {
		assertTestCasesFeatureEnabled();
	} catch {
		// The deployment does not run the QA surface at all. Not an error worth a
		// log line on every pull request in every repository it can see.
		return { ran: false, skipped: "feature-off" };
	}
	if (!input.actingUserId) {
		// Reading needs a credential, and a credential needs somebody it belongs
		// to. An integration with no configuring user recorded cannot be used
		// unattended, and guessing an owner would attribute a customer's API calls
		// to a person who never agreed to it.
		return { ran: false, skipped: "no-acting-user" };
	}

	let settings: Awaited<ReturnType<typeof getProjectQaSettings>>;
	try {
		settings = await getProjectQaSettings(input.projectId);
	} catch (error) {
		// The file claims this never throws at its caller, and that claim was
		// false here: the settings read sat outside every try, so a database blip
		// became an unhandled rejection in background work nobody is awaiting.
		logger.warn("[pr-review] automatic review could not read settings", {
			projectId: input.projectId,
			error: error instanceof Error ? error.message : String(error),
		});
		return {
			ran: false,
			skipped: "settings-unavailable",
			error: error instanceof Error ? error.message : String(error),
		};
	}
	if (!settings.prReviewAutoReviewEnabled) {
		return { ran: false, skipped: "auto-review-off" };
	}

	// Both lenses off is not "a review that found nothing", it is no review.
	// Without this the run fell through to the comment and posted "nothing
	// outstanding" onto a customer's pull request having checked precisely
	// nothing — the worst version of the bug, because it is indistinguishable
	// from a clean pass and it happens on every single push.
	if (
		!settings.prReviewQaLensEnabled &&
		!settings.prReviewArchitectureLensEnabled
	) {
		return { ran: false, skipped: "no-lens-enabled" };
	}

	let reviewId: string;
	let lensesAlreadyRan = false;
	// Per lens, because the GATES below need them individually. Sharing one
	// combined flag re-ran a lens that had already finished — see there.
	let qaOutstanding = false;
	let architectureOutstanding = false;
	try {
		const { review } = await readPullRequestIntoReview({
			projectId: input.projectId,
			repositoryIntegrationId: input.repositoryIntegrationId,
			prNumber: input.prNumber,
			actingUserId: input.actingUserId,
		});
		reviewId = review.id;
		if (review.status !== "READ") {
			return { ran: false, skipped: "no-diff", reviewId };
		}

		// This exact commit has already been reviewed by everything the project
		// switched on, so there is nothing new to say and a QA run would bill for
		// repeating itself.
		//
		// The review row is keyed by head commit, so a new push is a different row
		// and reviews normally — this only catches a repeat of the SAME commit.
		// That happens more than it sounds: GitHub retries a delivery it thinks
		// timed out, an operator replays one from the deliveries tab, and a
		// `synchronize` can arrive twice for one push. Without this, each of those
		// spent another generation.
		//
		// Phrased as "nothing outstanding" rather than "every lens has run",
		// because a DISABLED lens is not a lens that ran. The previous form
		// (`!enabled || analysedAt !== null` per lens) read true when both were
		// off, which is how a project with no lenses enabled reached the comment
		// step at all. The guard above now makes that state unreachable; this
		// stays exact so it cannot come back through another route.
		qaOutstanding =
			settings.prReviewQaLensEnabled && review.qaAnalysedAt === null;
		architectureOutstanding =
			settings.prReviewArchitectureLensEnabled &&
			review.architectureAnalysedAt === null;
		lensesAlreadyRan = !qaOutstanding && !architectureOutstanding;

		// Reviewed AND posted: there is nothing left to do for this commit.
		//
		// Reviewed but NOT posted is a different state, and skipping it was a
		// wedge: the comment fails for its own reasons — a credential without
		// write access is the one that actually happens — and the lens timestamps
		// are already set, so every later delivery would skip and the pull request
		// would keep a completed review that never reached anybody. So the lenses
		// are skipped (nothing is re-billed) and the comment is still attempted.
		if (lensesAlreadyRan && review.postedCommentId !== null) {
			return { ran: false, skipped: "already-reviewed", reviewId };
		}
	} catch (error) {
		logger.warn("[pr-review] automatic read failed", {
			projectId: input.projectId,
			prNumber: input.prNumber,
			error: error instanceof Error ? error.message : String(error),
		});
		return {
			ran: false,
			skipped: "read-failed",
			error: error instanceof Error ? error.message : String(error),
		};
	}

	const outcome: AutoReviewOutcome = { ran: true, reviewId };
	if (lensesAlreadyRan) {
		// Only the comment is outstanding. Recorded so a reader of the log can
		// tell this from a full run that found nothing.
		outcome.lensesSkipped = true;
	}

	// Why a lens produced nothing, observed here because only this run saw it: a
	// stored timestamp cannot say "it threw" or "there is no AI provider", and
	// without that the comment reported all of them as a clean pass.
	const lensOutcomes: Partial<Record<string, PrReviewLensUnavailable>> = {};

	// Each lens is attempted independently. One failing must not cost the other
	// its result: a model outage should still leave the computed architecture
	// findings on the pull request.

	// `qaOutstanding`, NOT `!lensesAlreadyRan`. The combined flag is
	// `qaOutstanding || architectureOutstanding`, so when one lens still had
	// work the OTHER one re-ran too: a QA generation billed again, and
	// `replaceLensFindings` wiping findings already stored for this commit.
	// Redeliveries are ordinary — GitHub retries, an operator replays one, a
	// push can produce two events — so this fired in normal use.
	if (qaOutstanding) {
		try {
			const qa = await runQaLens({
				projectId: input.projectId,
				reviewId,
				userId: input.actingUserId,
				organizationId: input.organizationId,
			});
			outcome.qaFindings = qa.findings.length;
			if (!qa.configured) {
				lensOutcomes.QA = "no-ai-provider";
			}
		} catch (error) {
			lensOutcomes.QA = "failed";
			outcome.error =
				error instanceof Error ? error.message : String(error);
			logger.warn("[pr-review] automatic QA lens failed", {
				projectId: input.projectId,
				reviewId,
				error: outcome.error,
			});
		}
	}

	if (architectureOutstanding) {
		try {
			const arch = await runArchitectureLens({
				projectId: input.projectId,
				reviewId,
			});
			outcome.architectureFindings = arch.findings.length;
			if (!arch.indexed) {
				lensOutcomes.ARCHITECTURE = "not-indexed";
			}
		} catch (error) {
			lensOutcomes.ARCHITECTURE = "failed";
			outcome.error =
				error instanceof Error ? error.message : String(error);
			logger.warn("[pr-review] automatic architecture lens failed", {
				projectId: input.projectId,
				reviewId,
				error: outcome.error,
			});
		}
	}

	// The comment is the point of the whole path: a review nobody opens Fabric to
	// read has not reached anybody.
	try {
		const posted = await postReviewCommentForReview({
			projectId: input.projectId,
			reviewId,
			actingUserId: input.actingUserId,
			reviewUrl: null,
			lensOutcomes,
		});
		outcome.commented = true;

		// The automatic path wrote into somebody's repository with nobody
		// present, and until now left no audit row at all — only a log line. The
		// button-driven equivalent has always been audited, so the ONE case
		// where no human witnessed it was the one case with no record. It
		// matters more here than there: the delivery that triggered this was
		// authenticated by a shared secret, so the audit row is what says which
		// project's credential actually wrote.
		recordAudit({
			action: "project.pull_request.comment_posted",
			category: "project",
			severity: "info",
			outcome: "success",
			// The person whose credential was used, recorded as the actor
			// because it is their token GitHub saw — but flagged automatic in
			// the metadata, since they did not press anything.
			actor: { type: "system", userId: input.actingUserId },
			organizationId: input.organizationId,
			projectId: input.projectId,
			resource: { type: "pull_request_review", id: reviewId },
			metadata: {
				trigger: "webhook",
				mode: posted.updated ? "updated" : "created",
				findings: posted.findings,
				prNumber: input.prNumber,
			},
		});
	} catch (error) {
		outcome.commented = false;
		outcome.error = error instanceof Error ? error.message : String(error);
		logger.warn("[pr-review] automatic comment failed", {
			projectId: input.projectId,
			reviewId,
			error: outcome.error,
		});
	}

	return outcome;
}
