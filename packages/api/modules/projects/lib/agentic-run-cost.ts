/**
 * The cost guard for a Fabric-orchestrated run.
 *
 * An agentic run costs tokens per step, so a large suite is a real bill on every
 * dispatch. The product ruling on 2026-07-26 was specific and is implemented
 * literally: **a HARD per-run cap, with an estimate shown before dispatch, that
 * REFUSES rather than warns.** A warning that can be clicked through is not a cap, and
 * the failure mode being guarded against — someone dispatches a 100-case suite
 * agentically and discovers the bill afterwards — is exactly the one a warning
 * does not prevent.
 *
 * Everything here is an ESTIMATE and says so. The real cost is metered by the
 * usual AI-usage interceptor and written back onto the run when it finishes, so
 * an estimate that turns out badly calibrated is visible as a discrepancy rather
 * than believed forever.
 */

/**
 * What one step costs, in US dollars.
 *
 * Derived, not guessed at. A step is TWO model calls, not one: the runner asks
 * what to do, performs it, and then has to look at the resulting page to decide
 * whether `expected` actually holds — and the second question cannot be answered
 * from the pre-action snapshot. Each call sends an aria snapshot plus the step's
 * instruction (~6k input tokens on a real page) and returns a small decision
 * object (~300 output). At the pricing the COMPLEX task type resolves to
 * (~$3/M input, ~$15/M output) that is ~$0.0225 per call, so ~$0.045 per step.
 *
 * Rounded UP to $0.05. An estimate that runs UNDER the real cost would let a run
 * past a cap that should have stopped it, which is the expensive direction to be
 * wrong in.
 *
 * **Measured against real runs on staging, 2026-07-27** — the derivation above
 * was theory until then:
 *
 * | Run | Steps | Actual | Per step | Estimate / actual |
 * |---|---|---|---|---|
 * | 3 cases | 12 | $0.40 | $0.0333 | 1.50× |
 * | 1 case  |  4 | $0.15 | $0.0375 | 1.33× |
 *
 * So the real figure is $0.033-0.038 and this constant is conservative by
 * roughly 1.3-1.5×, which is the intended direction and a defensible margin —
 * the 6k-token page snapshot the derivation assumes is simply larger than a
 * typical one. **Deliberately NOT lowered to match.** Trimming the margin buys
 * a slightly friendlier cap and spends the property the cap exists for; a hard
 * ceiling that refuses is only worth having while it errs high.
 *
 * A caveat for whoever measures this next: do not compare a CANCELLED run's
 * estimate against its actual. The estimate covers every step the run was asked
 * to do and the actual covers only the cases that ran, so the ratio looks about
 * twice as bad as it is. That mistake was made once already, in the first
 * write-up of these numbers.
 */
export const ESTIMATED_COST_PER_STEP_USD = 0.05;

/**
 * Steps assumed for a case whose step count we do not know yet.
 *
 * Only used by the pre-dispatch quote shown beside the button, where the exact
 * cases have not been resolved. The dispatch path itself counts real steps.
 */
export const ASSUMED_STEPS_PER_CASE = 6;

/**
 * The default ceiling, in US dollars, per run.
 *
 * Overridable per DEPLOYMENT (not per project, and not per user) via
 * `FABRIC_QA_AGENTIC_RUN_COST_CAP_USD`. Deliberately not a project setting: a
 * cap the person spending the money can raise is a speed bump, and "hard" was
 * the word in the ruling. Raising it is an operator decision made with the bill
 * in view.
 */
export const DEFAULT_RUN_COST_CAP_USD = 5;

/**
 * Hard ceiling on cases per dispatch.
 *
 * Separate from the cost cap and cruder on purpose: the cost cap bounds the
 * BILL, this bounds the REQUEST. Each case is a browser session held open in the
 * worker, so an unbounded array asks one container for something it cannot do.
 *
 * Exported so the UI can refuse BEFORE sending. It previously lived only as an
 * inline `.max(50)` on the input schema, which meant "select all" on a project
 * with more cases than this produced a bare **"Input validation failed"** —
 * technically correct and useless to the person reading it. Found by pressing
 * the button on staging, not by a unit test.
 *
 * **This is no longer a cap on the FEATURE.** Runs are sliced into durable
 * batches (spec F3), so a hundred selected cases run a hundred cases; the
 * platform's limit is no longer pushed onto the user as "pick 50". What remains
 * is a request-size sanity bound: a single dispatch carrying thousands of ids is
 * a mistake or an abuse, not a test plan, and refusing it protects the workflow
 * input from the 4 MiB gRPC frame that ids alone would eventually reach.
 *
 * The COST cap is untouched and still refuses. That one protects the bill rather
 * than the machine, and batching changes how many cases can run, not how much a
 * run may cost.
 */
export const MAX_CASES_PER_RUN = 500;

export function resolveRunCostCapUsd(): number {
	const raw = process.env.FABRIC_QA_AGENTIC_RUN_COST_CAP_USD;
	if (!raw) {
		return DEFAULT_RUN_COST_CAP_USD;
	}
	const parsed = Number.parseFloat(raw);
	// A malformed override falls back to the default rather than to NaN, which
	// would compare false against every estimate and silently disable the cap —
	// a typo in an env var must not turn the guard off.
	return Number.isFinite(parsed) && parsed > 0
		? parsed
		: DEFAULT_RUN_COST_CAP_USD;
}

export interface RunCostEstimate {
	estimatedCostUsd: number;
	capUsd: number;
	/** False means: do not dispatch. */
	withinCap: boolean;
	stepCount: number;
	caseCount: number;
}

function round4(value: number): number {
	return Math.round(value * 10_000) / 10_000;
}

/**
 * Estimate a run and decide whether it is allowed.
 *
 * `stepCount` is the total across every case in the run. Pass the real counts
 * when they are known; {@link ASSUMED_STEPS_PER_CASE} covers the quote shown
 * before cases are resolved.
 */
export function estimateRunCost(input: {
	caseCount: number;
	stepCount?: number;
}): RunCostEstimate {
	const stepCount =
		input.stepCount ?? input.caseCount * ASSUMED_STEPS_PER_CASE;
	const estimatedCostUsd = round4(stepCount * ESTIMATED_COST_PER_STEP_USD);
	const capUsd = resolveRunCostCapUsd();
	return {
		estimatedCostUsd,
		capUsd,
		// `<=`, not `<`: an estimate that lands exactly on the cap is within it.
		withinCap: estimatedCostUsd <= capUsd,
		stepCount,
		caseCount: input.caseCount,
	};
}

/**
 * The sentence a user sees when a run is refused on cost.
 *
 * Names both numbers and what to do about it. A refusal that says only "too
 * expensive" leaves someone re-pressing the button, because nothing in it tells
 * them the run needs to be smaller.
 */
export function describeCostRefusal(estimate: RunCostEstimate): string {
	return (
		`This run would cost about $${estimate.estimatedCostUsd.toFixed(2)} ` +
		`(${estimate.caseCount} case${estimate.caseCount === 1 ? "" : "s"}, ` +
		`${estimate.stepCount} steps), which is over the $${estimate.capUsd.toFixed(2)} ` +
		"per-run limit. Run fewer cases at a time."
	);
}
