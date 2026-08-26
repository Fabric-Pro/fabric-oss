/**
 * What changed since a failing test last passed.
 *
 * Ties three things that already existed and had never been used together: the
 * commit range from the test's own run history, the provider-agnostic compare
 * that Atlas/code-index already ships, and the ranking that decides which of the
 * changed files plausibly relate to THIS test.
 *
 * Everything here is best-effort by construction. The failure analysis was
 * useful before the diff existed and must stay useful when the diff cannot be
 * fetched — a repo that is disconnected, a token that expired, a provider that
 * caps the compare. So every path returns "no diff" rather than throwing, and
 * the caller states that absence to the model explicitly. A cause proposed
 * WITHOUT the diff is the shipped behaviour; a cause proposed while silently
 * believing it had the diff is a regression.
 */

import { db, getFailureCommitRange } from "@repo/database";
import { resolveFreshRepoToken } from "@repo/integrations";
import { logger } from "@repo/logs";
import { correlateFailureToDiff } from "./correlate-failure-to-diff";
import { compareIndexedCommitToHead } from "./repo-compare";

export interface ResolvedFailureDiff {
	commitRange: { baseSha: string; headSha: string };
	changedFiles: Array<{ path: string; reason: string }>;
	truncated: boolean;
}

/**
 * Resolve the ranked diff for a finding, or `null` when there is nothing honest
 * to show.
 *
 * `null` covers every "we cannot see the change" case — no commit range, no
 * connected repo, a failed compare, or a compare that returned nothing relevant.
 * They are one outcome here on purpose: the model is told the same thing in all
 * of them, because in all of them it must not blame a change it cannot see.
 */
export async function resolveFailureDiff(input: {
	projectId: string;
	findingId: string;
	userId: string;
	organizationId?: string | null;
	testName: string;
	classname?: string | null;
	specFilePath?: string | null;
}): Promise<ResolvedFailureDiff | null> {
	const range = await getFailureCommitRange({
		projectId: input.projectId,
		findingId: input.findingId,
	});
	if (!range.range) {
		return null;
	}

	// projectId in the WHERE is the tenant guard, as everywhere else — an
	// integration from another project matches nothing.
	const integration = await db.projectRepositoryIntegration.findFirst({
		where: { projectId: input.projectId },
		select: {
			id: true,
			provider: true,
			repositoryOwner: true,
			repositoryName: true,
			repositoryUrl: true,
			azureOrganization: true,
		},
	});
	if (!integration) {
		return null;
	}

	let compared: Awaited<ReturnType<typeof compareIndexedCommitToHead>>;
	try {
		// The canonical decrypt/refresh path — no consumer may read
		// `encryptedAccessToken` itself.
		const { token } = await resolveFreshRepoToken({
			integrationId: integration.id,
			projectId: input.projectId,
			userId: input.userId,
			organizationId: input.organizationId ?? undefined,
		});
		if (!token) {
			return null;
		}
		compared = await compareIndexedCommitToHead({
			repo: integration,
			token,
			base: range.range.baseSha,
			head: range.range.headSha,
		});
	} catch (error) {
		// A disconnected repo or an expired token must cost the diff, never the
		// analysis. Logged without the failure text, which is customer code.
		logger.warn("qa.finding.diff_compare_failed", {
			projectId: input.projectId,
			findingId: input.findingId,
			error: error instanceof Error ? error.message : String(error),
		});
		return null;
	}
	// The compare helper degrades rather than throwing: a force-pushed-away base
	// or a transient API error comes back as `status: "unknown"`, which is not a
	// diff and must not be presented as one.
	if (compared.status === "unknown" || compared.changedFiles.length === 0) {
		return null;
	}

	const ranked = correlateFailureToDiff({
		testName: input.testName,
		classname: input.classname,
		specFilePath: input.specFilePath,
		changedFiles: compared.changedFiles,
	});
	// Files changed, but none of them relate to this test in any way we can
	// argue for. Reported as no diff rather than as an unranked dump: handing
	// the model 47 unrelated paths is how a confident wrong cause gets written.
	if (ranked.length === 0) {
		return null;
	}

	return {
		commitRange: {
			baseSha: range.range.baseSha,
			headSha: range.range.headSha,
		},
		changedFiles: ranked.map((file) => ({
			path: file.path,
			reason: file.reason,
		})),
		truncated: compared.truncated ?? false,
	};
}
