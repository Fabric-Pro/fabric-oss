/**
 * Cost and latency bounds shared by the interactive duplicate checks: the
 * manual-create check (`stories.checkDuplicate`) and the Proposal Inbox
 * flags (`backlog.proposals.duplicateFlags`).
 */

/** Cap on inline back-fill embedding per request, mirroring
 * `semantic-search.ts`'s `MAX_INLINE_EMBEDS` — bounds latency on a cold
 * backlog rather than blocking the caller on it. */
export const MAX_INLINE_EMBEDS = 200;

/**
 * Default request deadline for a whole embed-and-match pipeline, from right
 * after the auth check. Overridable via `DUPLICATE_CHECK_TIMEOUT_MS` for
 * tuning without a redeploy, mirroring `DECISION_PRECHECK_TIMEOUT_MS`
 * (`packages/temporal/src/lib/decision-precheck/judge.ts`).
 */
const DUPLICATE_CHECK_TIMEOUT_MS = 20_000;

function resolveDuplicateCheckTimeoutMs(): number {
	const raw = Number.parseInt(
		process.env.DUPLICATE_CHECK_TIMEOUT_MS ?? "",
		10,
	);
	return Number.isFinite(raw) && raw > 0 ? raw : DUPLICATE_CHECK_TIMEOUT_MS;
}

interface RequestDeadline {
	ms: number;
	/** Aborted when the deadline passes; hand it to every abortable step. */
	signal: AbortSignal;
	/** Resolves when the deadline passes; never rejects. */
	expired: Promise<void>;
	/** Stops the timer once the work settled first. */
	clear: () => void;
}

/**
 * One request deadline for a duplicate check. The override is read on every
 * call, so a changed env var takes effect on the very next request.
 */
export function startRequestDeadline(): RequestDeadline {
	const ms = resolveDuplicateCheckTimeoutMs();
	const controller = new AbortController();
	const timer = setTimeout(() => controller.abort(), ms);
	const expired = new Promise<void>((resolve) => {
		controller.signal.addEventListener("abort", () => resolve());
	});
	return {
		ms,
		signal: controller.signal,
		expired,
		clear: () => clearTimeout(timer),
	};
}
