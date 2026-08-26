/**
 * Pure brief-completion accounting for the Daily Brief workflow.
 *
 * Kept in its own dependency-free module so it can be (a) imported by the
 * sandboxed workflow without pulling in non-deterministic APIs, and (b) unit
 * tested without a Temporal test environment.
 *
 * `completedSources` is cosmetic (drives the progress UI) and counts a source
 * that merely RAN. The fatal gate (`allCollectorsFailed`) is stricter: deployments
 * may only suppress it when it CONTRIBUTED real in-window items, because the
 * releases collector swallows per-repo errors and can "fulfill" with no items
 * (no repos / all repos failed / truncated-no-items). Counting that as healthy
 * would mask a systemic all-core-failure as a quiet EMPTY brief instead of FAILED.
 *
 * Runtime-dependency-free (the only import is type-only, erased at compile) so the
 * sandboxed workflow can import it without pulling in non-deterministic APIs.
 */
import type {
	DailyBriefContent,
	DeploymentItem,
	ReleaseNotesSummary,
} from "@repo/database";

export interface BriefCompletionInput {
	/** # of core fan-out collectors that fulfilled (not rejected). */
	coreFulfilledCount: number;
	/** Did the deployments collector activity fulfill (regardless of items)? */
	deploymentsRan: boolean;
	/** Did the deployments collector return >= 1 in-window item? */
	deploymentsContributed: boolean;
}

export interface BriefCompletionResult {
	completedSources: number;
	allCollectorsFailed: boolean;
}

export function resolveBriefCompletion(
	input: BriefCompletionInput,
): BriefCompletionResult {
	const { coreFulfilledCount, deploymentsRan, deploymentsContributed } =
		input;
	return {
		completedSources: coreFulfilledCount + (deploymentsRan ? 1 : 0),
		allCollectorsFailed:
			coreFulfilledCount === 0 && !deploymentsContributed,
	};
}

/**
 * The settled shape of the deployments collector promise, after the workflow's
 * eager `.then(ok, reason)` wrapper.
 */
export type DeploymentsSettled =
	| {
			ok: true;
			value: {
				items: DeploymentItem[];
				failures: Array<{ repoFullName: string; reason: string }>;
				latestRelease?: DeploymentItem;
				latestReleasesByRepo?: DeploymentItem[];
			};
	  }
	| { ok: false; reason: unknown };

export interface AppliedDeployments {
	/** Collected items, if the activity fulfilled. */
	deployments?: DeploymentItem[];
	/** Did the activity fulfill (regardless of items)? Cosmetic source count. */
	deploymentsRan: boolean;
	/** Did it return >= 1 in-window item? Gates the fatal check. */
	deploymentsContributed: boolean;
	/**
	 * Set when the collector reported any per-repo failure/truncation or the
	 * activity rejected. Surfaced to the UI via the rollback-safe OPTIONAL
	 * `deploymentsError` content field — NOT a new `partialFailures.source` enum
	 * value (which a rolled-back reader would reject).
	 */
	deploymentsError?: string;
	/** The repo's GitHub-canonical "Latest" release, passed through for the v5 anchor. */
	latestProdRelease?: DeploymentItem;
	/** Per-repo latest production releases (newest-first), for the per-repo anchor. */
	latestProdReleasesByRepo?: DeploymentItem[];
}

/**
 * Normalize a settled deployments result into the fields the workflow needs.
 * `undefined` = the v4 patch is off (deployments disabled) → fully inert.
 */
export function applyDeploymentsResult(
	settled: DeploymentsSettled | undefined,
): AppliedDeployments {
	if (!settled) {
		return { deploymentsRan: false, deploymentsContributed: false };
	}
	if (settled.ok) {
		const { items, failures, latestRelease, latestReleasesByRepo } =
			settled.value;
		// Section-level notes (repoFullName === "*": item-cap / body-budget truncation)
		// go FIRST so the bounded-degradation explanation survives the banner's 300-char
		// cap even when several per-repo errors are also present; render "*" notes without
		// the repo prefix.
		const ordered = [
			...failures.filter((f) => f.repoFullName === "*"),
			...failures.filter((f) => f.repoFullName !== "*"),
		];
		const deploymentsError =
			ordered.length > 0
				? ordered
						.map((f) =>
							f.repoFullName === "*"
								? f.reason
								: `${f.repoFullName}: ${f.reason}`,
						)
						.join("; ")
				: undefined;
		return {
			deployments: items,
			deploymentsRan: true,
			deploymentsContributed: items.length > 0,
			...(latestRelease ? { latestProdRelease: latestRelease } : {}),
			...(latestReleasesByRepo?.length
				? { latestProdReleasesByRepo: latestReleasesByRepo }
				: {}),
			...(deploymentsError ? { deploymentsError } : {}),
		};
	}
	return {
		deploymentsRan: false,
		deploymentsContributed: false,
		deploymentsError: String(settled.reason),
	};
}

/**
 * Whether a finished brief has anything worth showing — drives READY vs EMPTY.
 * Includes `deploymentsError` so a quiet window whose ONLY signal is a deployment
 * outage/truncation still renders (READY) and surfaces the banner, instead of being
 * hidden behind the EMPTY early-return in the page.
 */
export function briefHasDisplayableContent(args: {
	executiveSummary: string;
	priorityActionCount: number;
	deploymentsError?: string;
	deploymentCount?: number;
}): boolean {
	return (
		args.executiveSummary.length > 0 ||
		args.priorityActionCount > 0 ||
		Boolean(args.deploymentsError) ||
		(args.deploymentCount ?? 0) > 0
	);
}

export const PROD_ANCHOR_SUMMARY = "No tracked activity in this window.";

/** Dependency-free mirror of summarizer hasAnyItems (sandbox-safe). */
function sectionsHaveItems(sections: DailyBriefContent["sections"]): boolean {
	return Boolean(
		sections.github?.length ||
			sections.storyChanges?.length ||
			sections.taskChanges?.length ||
			sections.documents?.length ||
			sections.meetings?.length ||
			sections.teamsProposals?.length ||
			sections.deployments?.length,
	);
}

export interface AssembleFinalBriefInput {
	anchorV5: boolean;
	summaryContent: DailyBriefContent;
	deploymentsError?: string;
	latestProdRelease?: DeploymentItem;
	latestProdReleasesByRepo?: DeploymentItem[];
	releaseNotesSummary?: ReleaseNotesSummary;
}

export function assembleFinalBrief(input: AssembleFinalBriefInput): {
	status: "READY" | "EMPTY";
	content: DailyBriefContent;
} {
	const {
		anchorV5,
		summaryContent,
		deploymentsError,
		latestProdRelease,
		latestProdReleasesByRepo,
		releaseNotesSummary,
	} = input;

	if (!anchorV5) {
		// Legacy (v5 OFF) — byte-identical to pre-change behavior.
		const status = briefHasDisplayableContent({
			executiveSummary: summaryContent.executiveSummary,
			priorityActionCount: summaryContent.priorityActions.length,
			deploymentsError,
			deploymentCount: summaryContent.sections.deployments?.length ?? 0,
		})
			? "READY"
			: "EMPTY";
		const content: DailyBriefContent = {
			...summaryContent,
			...(releaseNotesSummary ? { releaseNotesSummary } : {}),
			...(deploymentsError ? { deploymentsError } : {}),
		};
		return { status, content };
	}

	// v5 ON — unified predicate gates both suppression and status.
	const hasOtherDisplayableSignal =
		summaryContent.priorityActions.length > 0 ||
		sectionsHaveItems(summaryContent.sections) ||
		Boolean(deploymentsError) ||
		(summaryContent.partialFailures?.length ?? 0) > 0 || // source failures render banners
		(summaryContent.ahead?.length ?? 0) > 0 ||
		(summaryContent.storylines?.length ?? 0) > 0 ||
		Boolean(releaseNotesSummary);

	let executiveSummary = summaryContent.executiveSummary;
	if (
		executiveSummary.length === 0 &&
		latestProdRelease &&
		!hasOtherDisplayableSignal
	) {
		const name = latestProdRelease.releaseName ?? latestProdRelease.tagName;
		executiveSummary = `${PROD_ANCHOR_SUMMARY} Latest production release: ${name} (${latestProdRelease.repoFullName}).`;
	}

	const status: "READY" | "EMPTY" =
		executiveSummary.length > 0 || hasOtherDisplayableSignal
			? "READY"
			: "EMPTY";

	const content: DailyBriefContent = {
		...summaryContent,
		executiveSummary,
		...(releaseNotesSummary ? { releaseNotesSummary } : {}),
		...(deploymentsError ? { deploymentsError } : {}),
		...(latestProdRelease ? { latestProdRelease } : {}),
		...(latestProdReleasesByRepo?.length
			? { latestProdReleasesByRepo }
			: {}),
	};
	return { status, content };
}
