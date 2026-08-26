/**
 * Read one pull request into a stored review.
 *
 * Extracted from the procedure so a webhook can do the same read. The two
 * callers differ in exactly one way and it is the important one: a procedure has
 * a signed-in person, and a webhook has only the integration somebody connected
 * earlier. So the acting identity is a parameter, and everything else — which
 * repository, whose credential, which tenant — is resolved from the project, as
 * it already was.
 *
 * Deliberately does NO analysis. A person can point Fabric at a real pull
 * request and see exactly what it read before any model draws conclusions.
 */

import { ORPCError } from "@orpc/client";
import {
	type PullRequestReviewSummary,
	recordPullRequestRead,
} from "@repo/database";
import { db } from "@repo/database/prisma/client";
import { resolveFreshRepoToken } from "@repo/integrations";
import { providerFor } from "./pr-review-hosts";

/**
 * How much diff Fabric will hold for one review.
 *
 * A real pull request is occasionally enormous — a lockfile refresh or a
 * generated-client bump runs to megabytes — and storing it whole would put that
 * in a TEXT column and then in every response that reads it. Truncation is
 * recorded on the row (`diffTruncated`) and surfaced in the UI rather than
 * hidden, because a review that saw half the change must not read as if it saw
 * all of it.
 */
export const PR_REVIEW_MAX_DIFF_BYTES = 400_000;

export async function readPullRequestIntoReview(input: {
	projectId: string;
	repositoryIntegrationId: string;
	prNumber: number;
	/**
	 * Who this read is attributed to, and whose session refreshes the credential
	 * if it needs refreshing. A webhook passes the user who connected the
	 * integration, because nobody is present.
	 */
	actingUserId: string;
}): Promise<{
	review: PullRequestReviewSummary;
	owner: string;
	repo: string;
	headSha: string;
}> {
	// The integration must belong to THIS project. A caller's permission
	// authorizes the project; it says nothing about whether this integration is
	// one of its own, and without this an authorised member could read a PR
	// through another project's connected repository. `resolveFreshRepoToken`
	// re-scopes by projectId too, but a NOT_FOUND here names the actual problem
	// instead of failing later as "no usable credential".
	const integration = await db.projectRepositoryIntegration.findFirst({
		where: {
			id: input.repositoryIntegrationId,
			projectId: input.projectId,
		},
		select: {
			id: true,
			provider: true,
			repositoryOwner: true,
			repositoryName: true,
			repositoryUrl: true,
			azureOrganization: true,
			project: { select: { organizationId: true } },
		},
	});
	if (!integration) {
		throw new ORPCError("NOT_FOUND", {
			message: "That repository is not connected to this project.",
		});
	}
	const organizationId = integration.project.organizationId;

	const host = providerFor(integration.provider);
	if (!host) {
		// Refusing by name beats failing somewhere deeper with a confusing error,
		// the same rule the QA pipeline sources follow.
		throw new ORPCError("BAD_REQUEST", {
			message: `Reading a pull request is not supported for ${integration.provider} repositories.`,
		});
	}

	const { token } = await resolveFreshRepoToken({
		integrationId: integration.id,
		projectId: input.projectId,
		userId: input.actingUserId,
		organizationId,
	});
	if (!token) {
		throw new ORPCError("BAD_REQUEST", {
			message:
				"No usable credential for this repository — reconnect it in Settings ▸ Repositories and try again.",
		});
	}

	const owner = integration.repositoryOwner;
	const repo = integration.repositoryName;
	const read = await host.read({
		token,
		repositoryUrl: integration.repositoryUrl,
		repositoryOwner: owner,
		repositoryName: repo,
		azureOrganization: integration.azureOrganization,
		prNumber: input.prNumber,
		maxDiffBytes: PR_REVIEW_MAX_DIFF_BYTES,
	});
	const { pullRequest, diff, diffTruncated } = read;
	const headSha = pullRequest.headSha;
	if (!headSha || !pullRequest.baseSha) {
		throw new ORPCError("BAD_REQUEST", {
			// GitHub writes #42; GitLab and Azure both write !42. Every per-host
			// message already gets this right and this shared one did not.
			message: `The code host returned no commit range for ${
				integration.provider === "GITHUB" ? "#" : "!"
			}${input.prNumber}, so there is nothing to review.`,
		});
	}

	const review = await recordPullRequestRead({
		projectId: input.projectId,
		integrationId: integration.id,
		provider: integration.provider,
		repoOwner: owner,
		repoName: repo,
		prNumber: input.prNumber,
		title: pullRequest.title,
		authorLabel: pullRequest.authorLabel,
		headSha,
		baseSha: pullRequest.baseSha,
		prUrl: pullRequest.webUrl,
		diff,
		diffTruncated,
		changedFiles: pullRequest.changedFiles,
		// A PR whose metadata read but whose diff did not is recorded as FAILED
		// rather than as a review of nothing: the reader must be able to tell "no
		// changes" from "we could not see the changes".
		status: diff === null ? "FAILED" : "READ",
		failureText: read.failureText,
		requestedById: input.actingUserId,
	});

	return { review, owner, repo, headSha };
}
