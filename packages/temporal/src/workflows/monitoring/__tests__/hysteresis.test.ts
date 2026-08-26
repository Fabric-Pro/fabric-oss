/**
 * Tests for the auto-resolve hysteresis logic.
 *
 * The hysteresis decisions live inline in the workflow bodies as small
 * counter/threshold checks. These pure-function tests verify the math
 * is correct independently of the Temporal sandbox so that the workflow
 * body stays a thin reducer over the counter state.
 */
import { describe, expect, it } from "vitest";

/**
 * Re-implementation of the statusPagePollerWorkflow's operational-poll
 * counter logic, factored out for testability. Returns a new counter
 * map + a `shouldClose` flag.
 */
function tickStatusPageHysteresis(
	current: Record<string, number>,
	providerKey: string,
	pollResult: "operational" | "degraded",
	threshold = 2,
): { next: Record<string, number>; shouldClose: boolean } {
	const next = { ...current };
	if (pollResult === "operational") {
		const prev = next[providerKey] ?? 0;
		next[providerKey] = prev + 1;
		if (next[providerKey] >= threshold) {
			next[providerKey] = 0;
			return { next, shouldClose: true };
		}
		return { next, shouldClose: false };
	}
	next[providerKey] = 0;
	return { next, shouldClose: false };
}

/**
 * Re-implementation of the syntheticProbeWorkflow's
 * consecutive-failure / consecutive-success transitions.
 */
function tickProbeHysteresis(
	state: {
		consecutiveFailures: number;
		consecutiveSuccesses: number;
		incidentOpen: boolean;
	},
	probeSuccess: boolean,
	failureThreshold = 3,
	successThreshold = 3,
): {
	state: typeof state;
	shouldOpen: boolean;
	shouldClose: boolean;
} {
	const out = { ...state };
	let shouldOpen = false;
	let shouldClose = false;

	if (probeSuccess) {
		out.consecutiveFailures = 0;
		out.consecutiveSuccesses += 1;
		if (out.incidentOpen && out.consecutiveSuccesses >= successThreshold) {
			shouldClose = true;
			out.incidentOpen = false;
			out.consecutiveSuccesses = 0;
		}
	} else {
		out.consecutiveSuccesses = 0;
		out.consecutiveFailures += 1;
		if (!out.incidentOpen && out.consecutiveFailures >= failureThreshold) {
			shouldOpen = true;
			out.incidentOpen = true;
		}
	}

	return { state: out, shouldOpen, shouldClose };
}

describe("statusPagePoller hysteresis (L14: 2 consecutive operational polls)", () => {
	it("does not close on a single operational poll", () => {
		const result = tickStatusPageHysteresis({}, "openai", "operational");
		expect(result.shouldClose).toBe(false);
		expect(result.next.openai).toBe(1);
	});

	it("closes on the second consecutive operational poll", () => {
		let counts: Record<string, number> = {};
		let r = tickStatusPageHysteresis(counts, "openai", "operational");
		counts = r.next;
		expect(r.shouldClose).toBe(false);
		r = tickStatusPageHysteresis(counts, "openai", "operational");
		expect(r.shouldClose).toBe(true);
		expect(r.next.openai).toBe(0); // reset after close
	});

	it("resets the counter when health flips to degraded", () => {
		let counts: Record<string, number> = {};
		let r = tickStatusPageHysteresis(counts, "openai", "operational");
		counts = r.next;
		r = tickStatusPageHysteresis(counts, "openai", "degraded");
		counts = r.next;
		expect(counts.openai).toBe(0);

		// Now a single operational poll should NOT close.
		r = tickStatusPageHysteresis(counts, "openai", "operational");
		expect(r.shouldClose).toBe(false);
	});

	it("isolates per-provider counters", () => {
		let counts: Record<string, number> = {};
		let r = tickStatusPageHysteresis(counts, "openai", "operational");
		counts = r.next;
		r = tickStatusPageHysteresis(counts, "stripe", "operational");
		counts = r.next;
		expect(counts.openai).toBe(1);
		expect(counts.stripe).toBe(1);

		// Two more for openai but not stripe.
		r = tickStatusPageHysteresis(counts, "openai", "operational");
		expect(r.shouldClose).toBe(true);
		expect(r.next.stripe).toBe(1); // stripe counter untouched
	});
});

describe("syntheticProbe hysteresis (L14: 3 consecutive failures → open, 3 successes → close)", () => {
	const init = () => ({
		consecutiveFailures: 0,
		consecutiveSuccesses: 0,
		incidentOpen: false,
	});

	it("does not open on 1 or 2 failures", () => {
		let s = init();
		s = tickProbeHysteresis(s, false).state;
		expect(s.consecutiveFailures).toBe(1);
		s = tickProbeHysteresis(s, false).state;
		expect(s.consecutiveFailures).toBe(2);
		expect(s.incidentOpen).toBe(false);
	});

	it("opens on the 3rd consecutive failure", () => {
		let s = init();
		s = tickProbeHysteresis(s, false).state;
		s = tickProbeHysteresis(s, false).state;
		const r = tickProbeHysteresis(s, false);
		expect(r.shouldOpen).toBe(true);
		expect(r.state.incidentOpen).toBe(true);
	});

	it("does not re-open while incident is already open", () => {
		let s = init();
		s = { ...s, incidentOpen: true, consecutiveFailures: 5 };
		const r = tickProbeHysteresis(s, false);
		expect(r.shouldOpen).toBe(false);
	});

	it("resets failure count on a single success", () => {
		let s = init();
		s = tickProbeHysteresis(s, false).state;
		s = tickProbeHysteresis(s, false).state;
		s = tickProbeHysteresis(s, true).state;
		expect(s.consecutiveFailures).toBe(0);
		expect(s.consecutiveSuccesses).toBe(1);
	});

	it("closes on 3 consecutive successes while incident is open", () => {
		let s = { ...init(), incidentOpen: true };
		s = tickProbeHysteresis(s, true).state;
		s = tickProbeHysteresis(s, true).state;
		const r = tickProbeHysteresis(s, true);
		expect(r.shouldClose).toBe(true);
		expect(r.state.incidentOpen).toBe(false);
		expect(r.state.consecutiveSuccesses).toBe(0);
	});

	it("does NOT close after 3 successes when no incident is open", () => {
		let s = init();
		s = tickProbeHysteresis(s, true).state;
		s = tickProbeHysteresis(s, true).state;
		const r = tickProbeHysteresis(s, true);
		expect(r.shouldClose).toBe(false);
	});

	it("a failure breaks the success streak — does not close on 'almost 3' successes", () => {
		let s = { ...init(), incidentOpen: true };
		s = tickProbeHysteresis(s, true).state;
		s = tickProbeHysteresis(s, true).state;
		s = tickProbeHysteresis(s, false).state;
		s = tickProbeHysteresis(s, true).state;
		s = tickProbeHysteresis(s, true).state;
		const r = tickProbeHysteresis(s, true);
		expect(r.shouldClose).toBe(true); // 3 in a row after the failure
		expect(r.state.consecutiveSuccesses).toBe(0);
	});
});
