import { describe, expect, it } from "vitest";
import {
	diffTestCaseActivities,
	type TestCaseActivitySnapshot,
} from "../test-case-activity";

/**
 * `diffTestCaseActivities` is the pure heart of the per-case audit: it turns a
 * before/after snapshot into exactly the activity events an update produced.
 * These assertions pin the contract the instrumentation relies on — a real
 * change yields one typed event, a no-op yields nothing.
 */

const snapshot = (
	overrides: Partial<TestCaseActivitySnapshot> = {},
): TestCaseActivitySnapshot => ({
	state: "DRAFT",
	priority: "MEDIUM",
	title: "Login succeeds",
	automationStatus: "NOT_AUTOMATED",
	stepCount: 3,
	...overrides,
});

describe("diffTestCaseActivities", () => {
	it("records nothing when nothing changed", () => {
		const events = diffTestCaseActivities({
			testCaseId: "tc1",
			actorUserId: "u1",
			before: snapshot(),
			after: snapshot(),
		});
		expect(events).toEqual([]);
	});

	it("records a state transition with from/to", () => {
		const events = diffTestCaseActivities({
			testCaseId: "tc1",
			actorUserId: "u1",
			before: snapshot({ state: "DRAFT" }),
			after: snapshot({ state: "READY" }),
		});
		expect(events).toEqual([
			{
				testCaseId: "tc1",
				actorUserId: "u1",
				type: "STATE_CHANGED",
				fromValue: "DRAFT",
				toValue: "READY",
			},
		]);
	});

	it("records priority, rename, automation, and step-count changes", () => {
		const events = diffTestCaseActivities({
			testCaseId: "tc1",
			actorUserId: "u1",
			before: snapshot(),
			after: snapshot({
				priority: "CRITICAL",
				title: "Login rejects a locked account",
				automationStatus: "AUTOMATED",
				stepCount: 5,
			}),
		});
		expect(events.map((e) => e.type)).toEqual([
			"PRIORITY_CHANGED",
			"RENAMED",
			"AUTOMATION_CHANGED",
			"STEPS_CHANGED",
		]);
		// Step counts are stringified so they fit the shared text columns.
		const steps = events.find((e) => e.type === "STEPS_CHANGED");
		expect(steps).toMatchObject({ fromValue: "3", toValue: "5" });
		// The rename does not leak the (potentially long) titles as no-ops.
		const renamed = events.find((e) => e.type === "RENAMED");
		expect(renamed).toMatchObject({
			fromValue: "Login succeeds",
			toValue: "Login rejects a locked account",
		});
	});

	it("emits several events in a stable order for a multi-field edit", () => {
		// State first, then priority — a fixed order so the timeline reads
		// consistently regardless of which fields a save touched.
		const events = diffTestCaseActivities({
			testCaseId: "tc1",
			actorUserId: null,
			before: snapshot({ state: "DRAFT", priority: "LOW" }),
			after: snapshot({ state: "CLOSED", priority: "HIGH" }),
		});
		expect(events.map((e) => e.type)).toEqual([
			"STATE_CHANGED",
			"PRIORITY_CHANGED",
		]);
		// A null actor (e.g. a system-driven change) is carried through verbatim.
		expect(events.every((e) => e.actorUserId === null)).toBe(true);
	});
});
