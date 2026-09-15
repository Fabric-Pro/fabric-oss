/**
 * Daily Brief — merged-PR join (plan Slice 8 "shipped" evidence).
 *
 * The GitHub collector knows which PRs merged in the window but nothing
 * about coding runs; `CodingRun` stores the PR URL but no merge state. This
 * activity joins the two: for every `pr_merged` item it stamps
 * `CodingRun.mergedAt` on runs whose `pullRequestUrl` matches (normalised),
 * only where `mergedAt` is still null so a re-run never rewrites history.
 *
 * Scoped to the project so a shared repo URL can never stamp another
 * tenant's runs.
 */
import type { GithubItem } from "@repo/database";
import { db } from "@repo/database";
import { logger } from "@repo/logs";
import { heartbeat } from "@temporalio/activity";

export interface StampMergedCodingRunsInput {
	projectId: string;
	organizationId: string | null;
	mergedItems: Array<Pick<GithubItem, "kind" | "url" | "occurredAt">>;
}

export interface StampMergedCodingRunsOutput {
	/** Number of CodingRun rows that received a mergedAt in this call. */
	stamped: number;
	/** Distinct normalised PR URLs considered. */
	considered: number;
}

/**
 * Canonical form for PR URL comparison: lower-case scheme+host, no trailing
 * slash, no `.git`, no query/hash. Returns the trimmed input when it is not
 * a parseable URL so odd stored values still get an exact-match chance.
 */
export function normalizePullRequestUrl(url: string): string {
	const trimmed = url.trim();
	try {
		const parsed = new URL(trimmed);
		let path = parsed.pathname.replace(/\/+$/, "");
		if (path.endsWith(".git")) {
			path = path.slice(0, -4);
		}
		return `${parsed.protocol.toLowerCase()}//${parsed.host.toLowerCase()}${path}`;
	} catch {
		return trimmed.replace(/\/+$/, "");
	}
}

export async function stampMergedCodingRuns(
	input: StampMergedCodingRunsInput,
): Promise<StampMergedCodingRunsOutput> {
	const { projectId, organizationId } = input;
	heartbeat("stampMergedCodingRuns: starting");

	// Earliest merge timestamp per normalised URL (a PR merges once; keep the
	// first observation if the collector emitted duplicates).
	const mergedAtByUrl = new Map<
		string,
		{ original: string; mergedAt: Date }
	>();
	for (const item of input.mergedItems) {
		if (item.kind !== "pr_merged" || !item.url) {
			continue;
		}
		const key = normalizePullRequestUrl(item.url);
		const mergedAt = new Date(item.occurredAt);
		if (Number.isNaN(mergedAt.getTime())) {
			continue;
		}
		const existing = mergedAtByUrl.get(key);
		if (!existing || mergedAt.getTime() < existing.mergedAt.getTime()) {
			mergedAtByUrl.set(key, { original: item.url, mergedAt });
		}
	}

	let stamped = 0;
	for (const [normalised, { original, mergedAt }] of mergedAtByUrl) {
		heartbeat(`stampMergedCodingRuns: ${normalised}`);
		const candidates = new Set<string>([normalised, original.trim()]);
		const result = await db.codingRun.updateMany({
			where: {
				projectId,
				organizationId,
				mergedAt: null,
				pullRequestUrl: { in: Array.from(candidates) },
			},
			data: { mergedAt },
		});
		stamped += result.count;
	}

	logger.info("[DailyBrief/stampMergedCodingRuns] Done", {
		projectId,
		considered: mergedAtByUrl.size,
		stamped,
	});

	return { stamped, considered: mergedAtByUrl.size };
}
