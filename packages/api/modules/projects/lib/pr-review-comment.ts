/**
 * Put the lenses' findings back on the pull request they came from.
 *
 * The composition and the GitHub round trip live here so the procedure and the
 * automatic webhook run post the SAME comment. What stays with each caller is
 * what only it has: a request-scoped audit record, or a log line.
 *
 * Until now a review lived only in Fabric: somebody had to be in the app, on the
 * right project, on the right review, to learn that their change had an untested
 * branch. The people who need it are on the pull request.
 *
 * Three decisions worth stating, because each is the difference between a useful
 * comment and one a team mutes:
 *
 *  - **One comment, edited in place.** Keyed by a marker in the body, the same
 *    shape the repository's own CI checker uses. Re-running a lens after a new
 *    commit updates that comment; it never adds a second.
 *  - **Nobody is surprised by it.** A comment appearing on someone's pull
 *    request that nobody asked for is the failure mode that gets a bot muted, so
 *    posting happens either because a person pressed the button or because the
 *    project switched automatic review on, per project and off by default.
 *  - **Posted through the connection the review was read through.** The caller
 *    names a review, never a credential — so this cannot be pointed at a
 *    repository the project did not connect.
 *
 * Advisory, like everything else here: a comment blocks no merge, and GitHub has
 * no notion of a required check for it.
 */

import { ORPCError } from "@orpc/client";
import {
	findPostedCommentForPullRequest,
	getProjectQaSettings,
	getPullRequestReviewForPosting,
	type PullRequestReviewFindingRow,
	setPullRequestReviewPostedComment,
} from "@repo/database";
import { db } from "@repo/database/prisma/client";
import { resolveFreshRepoToken } from "@repo/integrations";
import { logger } from "@repo/logs";
import { providerFor } from "./pr-review-hosts";

/**
 * How the comment is recognised on a later run. An HTML comment: invisible in
 * the rendered body, and stable across every wording change below it.
 */
export const PR_REVIEW_COMMENT_MARKER = "<!-- fabric-pr-review -->";

const LENS_HEADING: Record<string, string> = {
	QA: "Test coverage",
	ARCHITECTURE: "Architecture",
};

function lensHeading(lens: string): string {
	return LENS_HEADING[lens] ?? lens;
}

/** `path:line`, or the path alone when no line was verified against the diff. */
function location(finding: PullRequestReviewFindingRow): string | null {
	if (!finding.filePath) {
		return null;
	}
	return finding.line != null
		? `${finding.filePath}:${finding.line}`
		: finding.filePath;
}

/**
 * Why a lens produced nothing, when the reason is not "it looked and found
 * nothing". Each maps to a state the lens runners already return as data.
 */
export type PrReviewLensUnavailable =
	| "no-ai-provider"
	| "not-indexed"
	| "failed";

/**
 * What one lens did on this run.
 *
 * This exists because the comment could not tell "ran and found nothing" from
 * "never ran". Four different states — a clean pass, a crashed lens, a project
 * with no AI provider, and both lenses switched off — all produced the same
 * sentence: "The lenses that ran on this pull request reported nothing
 * outstanding." Read on a pull request, that is a clean bill of health, and in
 * three of those four states nothing had been checked at all.
 */
export interface PrReviewLensReport {
	lens: string;
	/** The project's switch for this lens. */
	enabled: boolean;
	/** When it last completed. Null means it never has. */
	analysedAt: Date | null;
	/** Set when it produced nothing for a reason other than finding nothing. */
	unavailable: PrReviewLensUnavailable | null;
}

/** True only when this lens actually looked at this pull request. */
function lensRan(report: PrReviewLensReport): boolean {
	return (
		report.enabled &&
		report.unavailable === null &&
		report.analysedAt !== null
	);
}

function lensStatusLine(report: PrReviewLensReport): string {
	const name = lensHeading(report.lens);
	if (!report.enabled) {
		// A lens can be switched off AFTER it ran: `enabled` is read from current
		// settings while `analysedAt` comes from the stored review, and a comment
		// gets retried when its first attempt failed to reach the host. Claiming
		// "nothing was checked" then contradicts this same comment's own findings
		// list a few lines above it.
		return report.analysedAt === null
			? `- **${name}** — switched off for this project. Nothing was checked.`
			: `- **${name}** — ran earlier, and has since been switched off for this project.`;
	}
	switch (report.unavailable) {
		case "no-ai-provider":
			return `- **${name}** — did not run: no AI provider is configured for this project.`;
		case "not-indexed":
			return `- **${name}** — did not run: this repository has not been indexed yet.`;
		case "failed":
			return `- **${name}** — did not complete on this run. Fabric will try again on the next push.`;
		default:
			return report.analysedAt === null
				? `- **${name}** — did not run.`
				: `- **${name}** — ran, nothing outstanding.`;
	}
}

/**
 * The comment body.
 *
 * Pure, so what gets posted is testable without a network call — and it needs to
 * be, because this is the one part of Fabric that writes into somebody else's
 * repository.
 *
 * Dismissed findings are left out. Somebody in the project already judged them
 * wrong, and republishing them onto the pull request would put a verdict back in
 * front of the team that a reviewer had explicitly withdrawn.
 *
 * `lenses` is REQUIRED rather than optional on purpose: the defect this fixes was
 * a comment composed without any idea of what had run, and an optional argument
 * would let exactly that caller exist again.
 */
export function composePrReviewComment(input: {
	findings: PullRequestReviewFindingRow[];
	reviewUrl: string | null;
	lenses: PrReviewLensReport[];
}): string {
	const live = input.findings.filter((f) => f.status !== "DISMISSED");
	const lines: string[] = [PR_REVIEW_COMMENT_MARKER, "## Fabric review", ""];

	if (live.length === 0) {
		const ran = input.lenses.filter(lensRan).length;
		if (input.lenses.length > 0 && ran === input.lenses.length) {
			lines.push(
				"No open findings. Every lens ran on this pull request and reported nothing outstanding.",
			);
		} else if (ran === 0) {
			lines.push(
				"**No lens ran on this pull request**, so this is not a clean bill of health — nothing was checked. See below.",
			);
		} else {
			lines.push(
				"No open findings from the lenses that ran — but **not every lens ran**, so this is not a clean bill of health. See below.",
			);
		}
	} else {
		for (const lens of [...new Set(live.map((f) => f.lens))]) {
			const forLens = live.filter((f) => f.lens === lens);
			lines.push(`### ${lensHeading(lens)}`, "");
			for (const finding of forLens) {
				const where = location(finding);
				lines.push(
					`- **${finding.severity}** — ${finding.title}${where ? ` (\`${where}\`)` : ""}`,
				);
				lines.push(`  ${finding.detail.replace(/\n+/g, " ")}`);
				if (finding.recommendation) {
					lines.push(`  _Recommendation:_ ${finding.recommendation}`);
				}
			}
			lines.push("");
		}
	}

	// Always present, findings or not. A reader deciding how much this comment is
	// worth needs to know what was actually looked at, and the case where that
	// matters most — nothing found — is exactly the case where a findings list
	// says nothing at all.
	if (input.lenses.length > 0) {
		lines.push("", "### What ran", "");
		for (const report of input.lenses) {
			lines.push(lensStatusLine(report));
		}
	}

	lines.push(
		"",
		input.reviewUrl
			? `Advisory only — this comment blocks nothing. [Open the full review in Fabric](${input.reviewUrl})`
			: "Advisory only — this comment blocks nothing.",
	);
	return lines.join("\n");
}

export async function postReviewCommentForReview(input: {
	projectId: string;
	reviewId: string;
	actingUserId: string;
	reviewUrl: string | null;
	/**
	 * Why a lens produced nothing on THIS run, where the run itself observed it.
	 * A stored timestamp cannot express "the lens threw a minute ago", so the
	 * caller that watched it happen passes it in.
	 */
	lensOutcomes?: Partial<Record<string, PrReviewLensUnavailable>>;
}): Promise<{ url: string | null; updated: boolean; findings: number }> {
	const review = await getPullRequestReviewForPosting({
		id: input.reviewId,
		projectId: input.projectId,
	});
	if (!review) {
		throw new ORPCError("NOT_FOUND", {
			message: "That pull-request review was not found.",
		});
	}
	const host = providerFor(review.provider);
	if (!host) {
		throw new ORPCError("BAD_REQUEST", {
			message: `Posting a review comment is not supported for ${review.provider} repositories.`,
		});
	}

	// The review keeps only the integration's id, deliberately, so it survives a
	// disconnection. The URL and Azure organization live on the integration, and
	// posting needs both, so they are read here rather than stored twice.
	const integration = await db.projectRepositoryIntegration.findFirst({
		where: { id: review.integrationId, projectId: input.projectId },
		select: { repositoryUrl: true, azureOrganization: true },
	});
	if (!integration) {
		throw new ORPCError("BAD_REQUEST", {
			message:
				"The repository this review was read through is no longer connected, so Fabric cannot comment on it.",
		});
	}

	const { token } = await resolveFreshRepoToken({
		integrationId: review.integrationId,
		projectId: input.projectId,
		userId: input.actingUserId,
		organizationId: review.organizationId,
	});
	if (!token) {
		throw new ORPCError("BAD_REQUEST", {
			message:
				"No usable credential for this repository — reconnect it in Settings ▸ Repositories and try again.",
		});
	}

	// The project's switches, so the comment can say "switched off" rather than
	// implying a lens looked and found nothing.
	const settings = await getProjectQaSettings(input.projectId);
	const body = composePrReviewComment({
		findings: review.findings,
		reviewUrl: input.reviewUrl,
		lenses: [
			{
				lens: "QA",
				enabled: settings.prReviewQaLensEnabled,
				analysedAt: review.qaAnalysedAt,
				unavailable: input.lensOutcomes?.QA ?? null,
			},
			{
				lens: "ARCHITECTURE",
				enabled: settings.prReviewArchitectureLensEnabled,
				analysedAt: review.architectureAnalysedAt,
				unavailable: input.lensOutcomes?.ARCHITECTURE ?? null,
			},
		],
	});

	const target = {
		token,
		repositoryUrl: integration.repositoryUrl,
		repositoryOwner: review.repoOwner,
		repositoryName: review.repoName,
		azureOrganization: integration.azureOrganization,
		prNumber: review.prNumber,
	};

	// The id recorded when this review was last posted, if it was.
	//
	// Earlier this searched the pull request for a comment carrying the marker
	// when no id was recorded. That is gone, and deliberately: the search only
	// ever repaired rows written before the id column existed, it read one page
	// so it missed the comment on exactly the busy pull requests where it
	// mattered, and reproducing it across three hosts means three more ways to
	// list comments. A review with no recorded id now creates one comment and
	// records its id, so at worst a pre-column review gains a second comment
	// once and never again. The marker stays in the body, because it is what
	// tells a human which comment is Fabric's.
	//
	// When this review has none, the SAME PULL REQUEST may still have one: a
	// review row is keyed by head commit, so every push creates a fresh row with
	// an empty `postedCommentId`. Editing in place therefore stopped at the
	// first push and each later one added another comment — against
	// `pull-requests.mdx`, `settings.mdx` and the panel's own string, all three
	// of which promise the comment is edited in place on later pushes.
	const recorded =
		review.postedCommentId !== null
			? Number(review.postedCommentId)
			: ((await findPostedCommentForPullRequest({
					projectId: input.projectId,
					provider: review.provider,
					repoOwner: review.repoOwner,
					repoName: review.repoName,
					prNumber: review.prNumber,
					excludeReviewId: review.id,
				})) ?? null);

	let posted =
		recorded === null
			? null
			: await host.editComment({ ...target, commentId: recorded, body });

	// Null means the host says that comment is gone. Somebody tidying a thread
	// has every right to delete it, and without this the id would stay recorded
	// and every later run would retry a comment that no longer exists.
	if (posted === null) {
		if (recorded !== null) {
			logger.info(
				"[pr-review] recorded comment is gone; creating a new one",
				{
					reviewId: review.id,
				},
			);
		}
		posted = await host.createComment({ ...target, body });
	}

	// Record it, so the next run edits by id rather than hunting for the marker.
	// Also repairs a review whose comment predates this column: the fallback
	// search found it, and now it is written down.
	if (posted.id > 0) {
		await setPullRequestReviewPostedComment({
			id: review.id,
			projectId: input.projectId,
			commentId: posted.id,
		});
	}

	return {
		url: posted.webUrl,
		updated: recorded !== null && posted.id === recorded,
		findings: review.findings.filter((f) => f.status !== "DISMISSED")
			.length,
	};
}
