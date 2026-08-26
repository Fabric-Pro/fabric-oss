import { describe, expect, it } from "vitest";
import {
	applyOnboardingTourAction,
	DEFAULT_ONBOARDING_TOUR_STATE,
	normalizeOnboardingTourState,
} from "../prisma/queries/onboarding-tour";

const NOW = "2026-07-09T00:00:00.000Z";
const base = () => ({ ...DEFAULT_ONBOARDING_TOUR_STATE });

describe("normalizeOnboardingTourState", () => {
	it("returns a fresh default for null / undefined / non-objects", () => {
		for (const raw of [null, undefined, 42, "x", [] as unknown]) {
			expect(normalizeOnboardingTourState(raw as never)).toEqual(
				DEFAULT_ONBOARDING_TOUR_STATE,
			);
		}
	});

	it("defaults missing fields (backward-compatible: no migration needed)", () => {
		// An old row written before seenPages / pageToursOptedOut existed.
		const state = normalizeOnboardingTourState({
			status: "in_progress",
			currentStepId: "overview",
		});
		expect(state.seenPages).toEqual({});
		expect(state.pageToursOptedOut).toBe(false);
		// Written before the Get-started pointer existed.
		expect(state.pointerDismissed).toBe(false);
		expect(state.status).toBe("in_progress");
		expect(state.currentStepId).toBe("overview");
	});

	it("coerces defensively against malformed JSON", () => {
		const state = normalizeOnboardingTourState({
			status: "bogus",
			steps: { a: "completed", b: "nonsense", c: "skipped" },
			seenPages: { overview: true, docs: "yes", stories: false },
			pageToursOptedOut: "true",
			autoLaunched: 1,
			pointerDismissed: "true",
		});
		expect(state.status).toBe("not_started");
		// only valid outcomes survive
		expect(state.steps).toEqual({ a: "completed", c: "skipped" });
		// only `=== true` entries survive
		expect(state.seenPages).toEqual({ overview: true });
		// only the boolean `true` opts out (string "true" must not)
		expect(state.pageToursOptedOut).toBe(false);
		expect(state.autoLaunched).toBe(false);
		expect(state.pointerDismissed).toBe(false);
	});
});

describe("applyOnboardingTourAction", () => {
	it("markPageSeen accumulates without clobbering prior pages", () => {
		let s = applyOnboardingTourAction(
			base(),
			{ type: "markPageSeen", pageId: "overview" },
			NOW,
		);
		s = applyOnboardingTourAction(
			s,
			{ type: "markPageSeen", pageId: "documents" },
			NOW,
		);
		expect(s.seenPages).toEqual({ overview: true, documents: true });
	});

	it("clearPageSeen removes only the named marker (card #1837 reveal replay)", () => {
		let s = applyOnboardingTourAction(
			base(),
			{ type: "markPageSeen", pageId: "overview" },
			NOW,
		);
		s = applyOnboardingTourAction(
			s,
			{ type: "markPageSeen", pageId: "documents" },
			NOW,
		);
		s = applyOnboardingTourAction(
			s,
			{ type: "clearPageSeen", pageId: "documents" },
			NOW,
		);
		expect(s.seenPages).toEqual({ overview: true });
		// Clearing an unknown page is a no-op.
		const before = s;
		expect(
			applyOnboardingTourAction(
				s,
				{ type: "clearPageSeen", pageId: "ghost" },
				NOW,
			),
		).toBe(before);
	});

	it("markPageToursOptedOut sets the flag and leaves seenPages intact", () => {
		const prev = applyOnboardingTourAction(
			base(),
			{ type: "markPageSeen", pageId: "overview" },
			NOW,
		);
		const s = applyOnboardingTourAction(
			prev,
			{ type: "markPageToursOptedOut" },
			NOW,
		);
		expect(s.pageToursOptedOut).toBe(true);
		expect(s.seenPages).toEqual({ overview: true });
	});

	it("start / step / complete drive status and timestamps", () => {
		let s = applyOnboardingTourAction(base(), { type: "start" }, NOW);
		expect(s.status).toBe("in_progress");
		s = applyOnboardingTourAction(
			s,
			{ type: "step", stepId: "assistant", outcome: "completed" },
			NOW,
		);
		expect(s.steps.assistant).toBe("completed");
		s = applyOnboardingTourAction(s, { type: "complete" }, NOW);
		expect(s.status).toBe("completed");
		expect(s.completedAt).toBe(NOW);
		expect(s.currentStepId).toBeNull();
	});

	it("dismiss records dismissedAt without touching opt-out", () => {
		const s = applyOnboardingTourAction(base(), { type: "dismiss" }, NOW);
		expect(s.status).toBe("dismissed");
		expect(s.dismissedAt).toBe(NOW);
		expect(s.pageToursOptedOut).toBe(false);
	});

	it("dismissPointer suppresses the pointer without touching tour status", () => {
		const s = applyOnboardingTourAction(
			base(),
			{ type: "dismissPointer" },
			NOW,
		);
		expect(s.pointerDismissed).toBe(true);
		// Dismissing the nudge is not dismissing the tour.
		expect(s.status).toBe("not_started");
		expect(s.dismissedAt).toBeNull();
		expect(s.autoLaunched).toBe(false);
		expect(s.seenPages).toEqual({});
	});

	it("dismissPointer is idempotent", () => {
		const once = applyOnboardingTourAction(
			base(),
			{ type: "dismissPointer" },
			NOW,
		);
		const twice = applyOnboardingTourAction(
			once,
			{ type: "dismissPointer" },
			NOW,
		);
		expect(twice).toEqual(once);
	});

	it("restart keeps the pointer dismissed — replaying is not asking to be nudged", () => {
		const dismissed = applyOnboardingTourAction(
			base(),
			{ type: "dismissPointer" },
			NOW,
		);
		const s = applyOnboardingTourAction(
			dismissed,
			{ type: "restart" },
			NOW,
		);
		expect(s.status).toBe("in_progress");
		expect(s.pointerDismissed).toBe(true);
	});

	it("is immutable — never mutates the previous state", () => {
		const prev = base();
		const snapshot = JSON.stringify(prev);
		applyOnboardingTourAction(prev, { type: "markPageToursOptedOut" }, NOW);
		expect(JSON.stringify(prev)).toBe(snapshot);
	});
});
