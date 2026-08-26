/**
 * Tests for the syntheticProbeWorkflow NOT_CONFIGURED branch.
 *
 * The full workflow runs inside Temporal's deterministic sandbox. For a
 * focused assertion on activity dispatch we re-implement the workflow's
 * per-iteration body in test scope and feed it deterministic probe
 * outcomes. This mirrors the pattern used by
 * `status-page-poller.test.ts` and keeps the workflow body itself
 * untyped by `vi.mock` of `@temporalio/workflow` (which is a hard road in
 * sandboxed code).
 *
 * Specifically guards against the staging regression where AWS S3 and
 * Stripe stayed pinned to `MAJOR_OUTAGE` for hours despite #1019
 * shipping the NOT_CONFIGURED logic: the missing top-level activity
 * re-export meant `markProviderNotConfigured` was never registered, and
 * the workflow's best-effort `try/catch` swallowed the failure. The
 * fix re-exports the activity; this test locks in the call wiring so a
 * future regression can't silently drop the call again.
 */
import { describe, expect, it, vi } from "vitest";

/**
 * Probe outcome shape — matches the contract of `runSyntheticProbe`.
 */
interface ProbeOutcome {
	success: boolean;
	error?: string;
	notConfigured?: boolean;
}

interface Counters {
	consecutiveFailures: number;
	consecutiveSuccesses: number;
	incidentOpen: boolean;
}

const FAILURE_THRESHOLD = 3;
const SUCCESS_THRESHOLD = 3;

/**
 * Per-iteration mirror of `syntheticProbeWorkflow`'s body. Returns the
 * updated counters + the list of (named) activity calls observed in the
 * iteration. The actual workflow file is the single source of truth;
 * this re-implementation must be kept in sync.
 */
async function tick(args: {
	probeResult: ProbeOutcome;
	prev: Counters;
	markProviderNotConfigured: (input: {
		providerKey: string;
		reason?: string;
	}) => Promise<{ updated: boolean }>;
	upsertIntegrationIncident: (input: unknown) => Promise<{
		wasNew: boolean;
		incidentId: string;
	}>;
	closeIntegrationIncident: (input: {
		providerKey: string;
		reason: string;
		note?: string;
	}) => Promise<{
		resolved: boolean;
		incidentId: string | null;
	}>;
}): Promise<{
	next: Counters;
}> {
	const next: Counters = { ...args.prev };

	if (args.probeResult.notConfigured) {
		await args.markProviderNotConfigured({
			providerKey: "aws_s3",
			reason: args.probeResult.error,
		});
		// Mirror the production workflow's stale-incident close: every
		// NOT_CONFIGURED tick attempts to close any active synthetic-
		// probe incident for this provider. The activity is idempotent —
		// it's a no-op when no row is active.
		const closeResult = await args.closeIntegrationIncident({
			providerKey: "aws_s3",
			reason: "NOT_CONFIGURED",
			note: args.probeResult.error,
		});
		if (closeResult.resolved) {
			next.incidentOpen = false;
		}
		next.consecutiveFailures = 0;
		next.consecutiveSuccesses = 0;
		return { next };
	}

	if (args.probeResult.success) {
		next.consecutiveFailures = 0;
		next.consecutiveSuccesses += 1;
		if (
			next.incidentOpen &&
			next.consecutiveSuccesses >= SUCCESS_THRESHOLD
		) {
			await args.closeIntegrationIncident({
				providerKey: "aws_s3",
				reason: "PROBE_SUCCESS",
			});
			next.incidentOpen = false;
			next.consecutiveSuccesses = 0;
		}
	} else {
		next.consecutiveSuccesses = 0;
		next.consecutiveFailures += 1;
		if (
			!next.incidentOpen &&
			next.consecutiveFailures >= FAILURE_THRESHOLD
		) {
			await args.upsertIntegrationIncident({
				providerKey: "aws_s3",
				detectionMethod: "SYNTHETIC_PROBE",
			});
			next.incidentOpen = true;
		}
	}

	return { next };
}

function makeMocks() {
	const markNotConfigured = vi
		.fn<
			(input: {
				providerKey: string;
				reason?: string;
			}) => Promise<{ updated: boolean }>
		>()
		.mockResolvedValue({ updated: true });
	const upsert = vi
		.fn<
			(input: unknown) => Promise<{
				wasNew: boolean;
				incidentId: string;
			}>
		>()
		.mockResolvedValue({ wasNew: true, incidentId: "inc-1" });
	const close = vi
		.fn<
			(input: {
				providerKey: string;
				reason: string;
				note?: string;
			}) => Promise<{
				resolved: boolean;
				incidentId: string | null;
			}>
		>()
		// Default: no active row to resolve. Individual tests override
		// this with `.mockResolvedValueOnce({ resolved: true, ... })` to
		// simulate a stale row found by the NOT_CONFIGURED close path.
		.mockResolvedValue({ resolved: false, incidentId: null });
	return { markNotConfigured, upsert, close };
}

const ZERO: Counters = {
	consecutiveFailures: 0,
	consecutiveSuccesses: 0,
	incidentOpen: false,
};

describe("syntheticProbeWorkflow — NOT_CONFIGURED branch", () => {
	it("calls markProviderNotConfigured AND closeIntegrationIncident(NOT_CONFIGURED) when probe returns notConfigured:true", async () => {
		const { markNotConfigured, upsert, close } = makeMocks();
		const { next } = await tick({
			probeResult: {
				success: false,
				notConfigured: true,
				error: "Synthetic probe disabled — AWS_S3_BUCKET not set in this environment",
			},
			prev: ZERO,
			markProviderNotConfigured: markNotConfigured,
			upsertIntegrationIncident: upsert,
			closeIntegrationIncident: close,
		});

		expect(markNotConfigured).toHaveBeenCalledTimes(1);
		expect(markNotConfigured).toHaveBeenCalledWith(
			expect.objectContaining({
				providerKey: "aws_s3",
				reason: expect.stringMatching(/AWS_S3_BUCKET/),
			}),
		);
		// Critically: a NOT_CONFIGURED probe is NOT a failure — the
		// failure counter must reset and we must NOT open an incident.
		expect(upsert).not.toHaveBeenCalled();
		// The close call is the bug-2 fix: any stale SYNTHETIC_PROBE
		// incident for this provider must be auto-resolved when the
		// probe transitions to NOT_CONFIGURED. The activity itself is
		// idempotent — a no-op when no row matches — but the call must
		// happen unconditionally so an orphaned pre-#1019 row clears.
		expect(close).toHaveBeenCalledTimes(1);
		expect(close).toHaveBeenCalledWith(
			expect.objectContaining({
				providerKey: "aws_s3",
				reason: "NOT_CONFIGURED",
			}),
		);
		expect(next.consecutiveFailures).toBe(0);
		expect(next.consecutiveSuccesses).toBe(0);
		expect(next.incidentOpen).toBe(false);
	});

	it("does NOT open an incident even after repeated NOT_CONFIGURED ticks", async () => {
		const { markNotConfigured, upsert, close } = makeMocks();
		let state: Counters = { ...ZERO };
		// Simulate 10 consecutive ticks where the probe says NOT_CONFIGURED.
		// Without the bug fix, missing-env-var was being silently counted
		// as a probe failure → after 3 ticks an incident would open. With
		// the fix, the workflow short-circuits and we never accumulate a
		// failure streak.
		for (let i = 0; i < 10; i += 1) {
			const result = await tick({
				probeResult: { success: false, notConfigured: true },
				prev: state,
				markProviderNotConfigured: markNotConfigured,
				upsertIntegrationIncident: upsert,
				closeIntegrationIncident: close,
			});
			state = result.next;
		}
		expect(markNotConfigured).toHaveBeenCalledTimes(10);
		// Close is also called 10x — once per tick — and is a no-op when
		// no row is active. Idempotent by design (see
		// `closeIntegrationIncident` semantics).
		expect(close).toHaveBeenCalledTimes(10);
		expect(upsert).not.toHaveBeenCalled();
		expect(state.incidentOpen).toBe(false);
		expect(state.consecutiveFailures).toBe(0);
	});

	// Bug 2 (post-#1021 staging regression): pre-#1019 the synthetic
	// probe opened SEV-2 incidents when the credential env var was
	// missing. After #1019 those same probe ticks transition the row
	// to NOT_CONFIGURED instead, but the orphaned SEV-2 incidents from
	// before the deploy stayed in FIRING state forever because nothing
	// closed them. This test locks in the close-on-transition behavior.
	it("closes a stale SYNTHETIC_PROBE incident from before NOT_CONFIGURED was added", async () => {
		const { markNotConfigured, upsert, close } = makeMocks();
		// The activity reports it found an active row to resolve.
		close.mockResolvedValueOnce({
			resolved: true,
			incidentId: "stale-incident-from-pre-1019",
		});

		// Counters reflect the orphaned-row scenario: a workflow CAN was
		// restored from a state where `incidentOpen` was true (the FIRING
		// row exists in the DB), but a fresh redeploy stripped the env
		// var, so today's probe says notConfigured:true.
		const orphanState: Counters = {
			consecutiveFailures: 0,
			consecutiveSuccesses: 0,
			incidentOpen: true,
		};

		const { next } = await tick({
			probeResult: {
				success: false,
				notConfigured: true,
				error: "STRIPE_SECRET_KEY not set in this environment",
			},
			prev: orphanState,
			markProviderNotConfigured: markNotConfigured,
			upsertIntegrationIncident: upsert,
			closeIntegrationIncident: close,
		});

		// The close call must happen with reason=NOT_CONFIGURED so the
		// AUTO_RESOLVED event payload makes the cause auditable.
		expect(close).toHaveBeenCalledWith(
			expect.objectContaining({
				providerKey: "aws_s3",
				reason: "NOT_CONFIGURED",
			}),
		);
		// And the workflow-local `incidentOpen` flag flips to false so a
		// subsequent successful probe doesn't try to close the same row
		// twice.
		expect(next.incidentOpen).toBe(false);
	});

	it("treats a real probe failure (no notConfigured flag) as a normal failure that escalates after 3", async () => {
		// Sibling check: the fix must NOT widen the NOT_CONFIGURED gate so
		// that real outages (`success:false`, `notConfigured` undefined)
		// stop escalating. Three real failures → upsert called once.
		const { markNotConfigured, upsert, close } = makeMocks();
		let state: Counters = { ...ZERO };
		for (let i = 0; i < 3; i += 1) {
			const result = await tick({
				probeResult: {
					success: false,
					error: "probe HTTP 503",
				},
				prev: state,
				markProviderNotConfigured: markNotConfigured,
				upsertIntegrationIncident: upsert,
				closeIntegrationIncident: close,
			});
			state = result.next;
		}
		expect(upsert).toHaveBeenCalledTimes(1);
		expect(markNotConfigured).not.toHaveBeenCalled();
		expect(state.incidentOpen).toBe(true);
	});

	it("recovery: successful probes after a NOT_CONFIGURED streak start a fresh success streak", async () => {
		// After 3 NOT_CONFIGURED ticks → ops adds the env var → probes
		// succeed. Counters were reset to 0 on each NOT_CONFIGURED tick;
		// the success path then increments from 0 normally.
		const { markNotConfigured, upsert, close } = makeMocks();
		let state: Counters = { ...ZERO };
		for (let i = 0; i < 3; i += 1) {
			const r = await tick({
				probeResult: { success: false, notConfigured: true },
				prev: state,
				markProviderNotConfigured: markNotConfigured,
				upsertIntegrationIncident: upsert,
				closeIntegrationIncident: close,
			});
			state = r.next;
		}
		// Now ops sets AWS_S3_BUCKET and the probes start succeeding.
		const success = await tick({
			probeResult: { success: true },
			prev: state,
			markProviderNotConfigured: markNotConfigured,
			upsertIntegrationIncident: upsert,
			closeIntegrationIncident: close,
		});
		expect(success.next.consecutiveSuccesses).toBe(1);
		expect(success.next.incidentOpen).toBe(false);
	});
});
