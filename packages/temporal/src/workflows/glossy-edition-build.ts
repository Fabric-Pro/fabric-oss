import {
	ApplicationFailure,
	CancellationScope,
	isCancellation,
	log,
	proxyActivities,
} from "@temporalio/workflow";
import type * as glossyActivities from "../activities/glossy-edition";
import type {
	ExtractGlossyVisualActivityResult,
	GlossyBuildErrorCode,
	GlossyBuildRef,
	GlossyEditionBuildWorkflowInput,
	GlossyEditionBuildWorkflowOutput,
	GlossyOpportunityRef,
	RewriteGlossySectionActivityResult,
} from "../activities/glossy-edition/types";
import {
	AI_NON_RETRYABLE_ERROR_TYPES,
	GLOSSY_BUILD_NON_RETRYABLE_ERROR_TYPE_SET,
	GLOSSY_BUILD_NON_RETRYABLE_ERROR_TYPES,
} from "./ai-non-retryable-errors";

/**
 * Build one Glossy edition (Fizzy #2589, KTD3, KTD4, KTD9): prepare,
 * detection when prepare asks for it, a bounded pool of section rewrites and
 * visual extractions, then finalize.
 *
 * The workflow only orchestrates. Its input is ids and options; every
 * snapshot read, model call, cache write, and guarded attempt write is an
 * activity, and activity results carry keys and kinds, never text (KTD24).
 * The pool is hand-rolled over workflow promises — no timers, no concurrency
 * library — so it replays deterministically.
 *
 * Runs on `GLOSSY_EDITION_TASK_QUEUE` with the id
 * `glossyEditionBuildWorkflowId(documentId, buildId)`. The starter sets a
 * 30-minute execution timeout: with every activity's attempts bounded too, a
 * stalled run closes, and the build procedure's reclaim takes over a stale
 * claim once Temporal reports the run closed (KTD4).
 *
 * Failure: a superseded run has already marked its own attempt and returns
 * `superseded`; any other failure goes to fail-build, which records the code
 * and a fixed message through the attempt guard, and the run then fails with
 * that code. A failed rebuild leaves the published edition in place (KTD5).
 */

/**
 * Concurrent activities one build runs at most. Equal to the worker's
 * `glossyEdition` activity slots: one build can fill the queue, and more
 * would only wait for a slot.
 */
export const GLOSSY_BUILD_POOL_SIZE = 4;

const NON_RETRYABLE_ERROR_TYPES = [
	...AI_NON_RETRYABLE_ERROR_TYPES,
	...GLOSSY_BUILD_NON_RETRYABLE_ERROR_TYPES,
];

// Prepare re-checks access and resolves the model; finalize assembles and
// writes the edition. Database work plus one resolver call, so short.
const { prepareGlossyBuildActivity, finalizeGlossyBuildActivity } =
	proxyActivities<typeof glossyActivities>({
		startToCloseTimeout: "2 minutes",
		retry: {
			initialInterval: "2s",
			backoffCoefficient: 2,
			maximumInterval: "30s",
			maximumAttempts: 3,
			nonRetryableErrorTypes: NON_RETRYABLE_ERROR_TYPES,
		},
	});

// One model call each (a rewrite may make a second, guard-driven one). The
// activities heartbeat through `withHeartbeatTicker`, so a dead worker is
// noticed within a minute and a provider blip is retried.
const {
	detectGlossyOpportunitiesActivity,
	rewriteGlossySectionActivity,
	extractGlossyVisualActivity,
} = proxyActivities<typeof glossyActivities>({
	startToCloseTimeout: "5 minutes",
	heartbeatTimeout: "1 minute",
	retry: {
		initialInterval: "5s",
		backoffCoefficient: 2,
		maximumInterval: "1 minute",
		maximumAttempts: 3,
		nonRetryableErrorTypes: NON_RETRYABLE_ERROR_TYPES,
	},
});

// The failure write must land for the claim to be released before the
// stale-holder reclaim is needed, so it gets the most attempts.
const { failGlossyBuildActivity } = proxyActivities<typeof glossyActivities>({
	startToCloseTimeout: "1 minute",
	retry: {
		initialInterval: "2s",
		backoffCoefficient: 2,
		maximumInterval: "30s",
		maximumAttempts: 5,
	},
});

export async function glossyEditionBuildWorkflow(
	input: GlossyEditionBuildWorkflowInput,
): Promise<GlossyEditionBuildWorkflowOutput> {
	const ref: GlossyBuildRef = {
		buildId: input.buildId,
		documentId: input.documentId,
		projectId: input.projectId,
		organizationId: input.organizationId,
		startedById: input.startedById,
	};
	try {
		return await build(ref, input);
	} catch (error) {
		const code = failureCode(error);
		if (code === "SUPERSEDED") {
			log.info("Glossy build superseded", { buildId: ref.buildId });
			return { status: "superseded" };
		}
		const recorded = await recordFailure(ref, code, error);
		if (recorded === "superseded") {
			return { status: "superseded" };
		}
		if (isCancellation(error)) {
			throw error;
		}
		throw ApplicationFailure.create({
			type: code,
			message: `Glossy edition build failed: ${code}`,
			nonRetryable: true,
		});
	}
}

async function build(
	ref: GlossyBuildRef,
	input: GlossyEditionBuildWorkflowInput,
): Promise<GlossyEditionBuildWorkflowOutput> {
	const { options } = input;
	const plan = await prepareGlossyBuildActivity({ ...ref, options });
	const { documentType } = plan;
	const sectionsTotal = plan.sectionKeys.length;
	let sectionsDone = 0;
	const progress = () => ({ sectionsDone, sectionsTotal });

	let opportunities: GlossyOpportunityRef[] = plan.opportunities;
	let detectionCacheKey: string | null = null;
	if (plan.detection) {
		const detected = await detectGlossyOpportunitiesActivity({
			...ref,
			documentType,
			sectionKeys: plan.detection.sectionKeys,
			limit: plan.detection.limit,
			progress: progress(),
		});
		detectionCacheKey = detected.cacheKey;
		const order = new Map(
			plan.sectionKeys.map((key, index) => [key, index]),
		);
		opportunities = [...opportunities, ...detected.opportunities].sort(
			(a, b) =>
				(order.get(a.sectionKey) ?? 0) - (order.get(b.sectionKey) ?? 0),
		);
	}

	// Rewrites first, in document order, so progress moves from the start;
	// then the slots (R22), then the opportunities.
	const tasks: GlossyBuildTask[] = [
		...plan.sectionKeys.map((sectionKey) => ({
			type: "rewrite" as const,
			sectionKey,
		})),
		...plan.slots.map((slot) => ({
			type: "extract" as const,
			sectionKey: slot.sectionKey,
			kind: slot.kind,
			slotId: slot.slotId,
		})),
		...opportunities.map((opportunity) => ({
			type: "extract" as const,
			sectionKey: opportunity.sectionKey,
			kind: opportunity.kind,
			slotId: null,
		})),
	];

	const results = await runBounded(
		tasks,
		GLOSSY_BUILD_POOL_SIZE,
		async (task): Promise<GlossyBuildTaskResult> => {
			if (task.type === "rewrite") {
				const rewrite = await rewriteGlossySectionActivity({
					...ref,
					documentType,
					lengthMode: options.lengthMode,
					sectionKey: task.sectionKey,
					progress: progress(),
				});
				sectionsDone += 1;
				return { type: "rewrite", rewrite };
			}
			const visual = await extractGlossyVisualActivity({
				...ref,
				documentType,
				sectionKey: task.sectionKey,
				kind: task.kind,
				slotId: task.slotId,
				styleDirection: options.styleDirection ?? null,
				progress: progress(),
			});
			return { type: "extract", visual };
		},
	);

	const finalized = await finalizeGlossyBuildActivity({
		...ref,
		documentType,
		options,
		rewrites: results.flatMap((result) =>
			result.type === "rewrite" ? [result.rewrite] : [],
		),
		visuals: results.flatMap((result) =>
			result.type === "extract" ? [result.visual] : [],
		),
		detectionCacheKey,
	});
	if (finalized.outcome === "superseded") {
		log.info("Glossy build superseded at finalize", {
			buildId: ref.buildId,
		});
		return { status: "superseded" };
	}
	return {
		status: "succeeded",
		editionId: finalized.editionId,
		contentRevision: finalized.contentRevision,
	};
}

type GlossyBuildTask =
	| { type: "rewrite"; sectionKey: string }
	| {
			type: "extract";
			sectionKey: string;
			kind: GlossyOpportunityRef["kind"] | "auto";
			slotId: string | null;
	  };

type GlossyBuildTaskResult =
	| { type: "rewrite"; rewrite: RewriteGlossySectionActivityResult }
	| { type: "extract"; visual: ExtractGlossyVisualActivityResult };

/**
 * Run `run` over `items` with at most `size` in flight, results in item
 * order. Each lane takes the next item when its current one settles, so the
 * pool refills as activities finish rather than in waves.
 *
 * After the first failure no lane takes new work; the ones in flight settle
 * before it is rethrown, so the run never closes with its own activities
 * still writing. Deterministic under replay: the lanes resume in the order
 * the history records the completions.
 */
async function runBounded<T, R>(
	items: readonly T[],
	size: number,
	run: (item: T) => Promise<R>,
): Promise<R[]> {
	const results: R[] = new Array(items.length);
	const failures: unknown[] = [];
	let next = 0;
	const lane = async (): Promise<void> => {
		while (failures.length === 0 && next < items.length) {
			const index = next++;
			try {
				results[index] = await run(items[index]);
			} catch (error) {
				failures.push(error);
			}
		}
	};
	await Promise.all(
		Array.from({ length: Math.min(size, items.length) }, () => lane()),
	);
	if (failures.length > 0) {
		throw failures[0];
	}
	return results;
}

/**
 * The code a failure persists as: the activity's `ApplicationFailure` type
 * when it is one of the build's verdicts, found through the failure's
 * `cause` chain, and `BUILD_FAILED` otherwise.
 */
function failureCode(error: unknown): GlossyBuildErrorCode {
	let current: unknown = error;
	for (let depth = 0; current && depth < 8; depth++) {
		const type = (current as { type?: unknown }).type;
		if (
			typeof type === "string" &&
			GLOSSY_BUILD_NON_RETRYABLE_ERROR_TYPE_SET.has(type)
		) {
			return type as GlossyBuildErrorCode;
		}
		if (type === "AIProviderNotConfiguredError") {
			return "AI_PROVIDER_NOT_CONFIGURED";
		}
		current = (current as { cause?: unknown }).cause;
	}
	return "BUILD_FAILED";
}

/** Longest failure message handed to fail-build, which only logs it after redaction. */
const FAILURE_DETAIL_MAX_CHARS = 1_000;

/** The innermost message of the failure chain: an activity's own error, not "Activity task failed". */
function failureDetail(error: unknown): string | null {
	let message: string | null = null;
	let current: unknown = error;
	for (let depth = 0; current && depth < 8; depth++) {
		const text = (current as { message?: unknown }).message;
		if (typeof text === "string" && text) {
			message = text;
		}
		current = (current as { cause?: unknown }).cause;
	}
	return message ? message.slice(0, FAILURE_DETAIL_MAX_CHARS) : null;
}

/**
 * The guarded FAILED write. A cancelled run still records it, outside the
 * cancelled scope. When the write itself cannot be made, the claim stays with
 * this attempt until its heartbeat goes stale and the reclaim takes over.
 */
async function recordFailure(
	ref: GlossyBuildRef,
	code: GlossyBuildErrorCode,
	error: unknown,
): Promise<"applied" | "superseded" | "unrecorded"> {
	const write = () =>
		failGlossyBuildActivity({ ...ref, code, detail: failureDetail(error) });
	try {
		const result = isCancellation(error)
			? await CancellationScope.nonCancellable(write)
			: await write();
		return result.outcome;
	} catch {
		log.error("Glossy build failure could not be recorded", {
			buildId: ref.buildId,
			code,
		});
		return "unrecorded";
	}
}
