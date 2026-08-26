/**
 * Recovering a revision from a completion the structured-output schema rejected.
 *
 * This is not hypothetical. On staging, pressing "Revise" on a test case whose
 * feature had a real pull request produced a 500: the model had correctly worked
 * out that the fix inverted the case's expected outcome, and returned `steps` as
 * `<step>` markup inside a string instead of an array. The schema rejected it,
 * the prompt rethrew, and the person who pressed the button got "Internal server
 * error" while a correct revision sat inside the response.
 *
 * The payload below is the one from that run.
 */

import { describe, expect, it } from "vitest";
import { salvageRevisedSteps } from "../test-case-step-revision";

const PRODUCTION_REJECTION = JSON.stringify({
	rationale:
		"The diff shows the read-then-resend bug was fixed: the sweeper now checks existence via a read-state-independent findMany before writing, so a recipient who already read the announcement is NOT notified again on the next pass — this inverts the old test's expected outcome.",
	steps: "\n<step>\n<action>Publish a status announcement to a recipient, then open it as that recipient so it is marked read.</action>\n<expected>The announcement is marked read for that recipient.</expected>\n</step>\n<step>\n<action>Trigger the next announcement delivery pass for the same announcement.</action>\n<expected>The recipient is not notified again: no duplicate notification is written for that recipient.</expected>\n</step>\n",
});

describe("salvageRevisedSteps", () => {
	it("recovers the steps the model put in a string instead of an array", () => {
		const salvaged = salvageRevisedSteps(PRODUCTION_REJECTION);

		expect(salvaged).not.toBeNull();
		expect(salvaged?.steps).toHaveLength(2);
		expect(salvaged?.steps[0].action).toContain(
			"Publish a status announcement",
		);
		expect(salvaged?.steps[0].expected).toContain("marked read");
		// The second step is the one carrying the corrected expectation — the
		// whole value of the revision.
		expect(salvaged?.steps[1].expected).toContain("not notified again");
		expect(salvaged?.rationale).toContain("inverts the old test");
	});

	it("prefers a well-formed array when the model sends one", () => {
		const salvaged = salvageRevisedSteps(
			JSON.stringify({
				rationale: "fine",
				steps: [{ action: "Do the thing", expected: "It happened" }],
			}),
		);

		expect(salvaged?.steps).toEqual([
			{ action: "Do the thing", expected: "It happened" },
		]);
	});

	it("drops a step with no action rather than proposing a blank line", () => {
		const salvaged = salvageRevisedSteps(
			JSON.stringify({
				rationale: "",
				steps: [
					{ action: "", expected: "orphaned expectation" },
					{ action: "Real step", expected: "Real outcome" },
				],
			}),
		);

		expect(salvaged?.steps).toEqual([
			{ action: "Real step", expected: "Real outcome" },
		]);
	});

	it("returns null when there is nothing to recover, so the caller still throws", () => {
		// Salvage must not turn a genuine failure into a silent empty proposal.
		expect(salvageRevisedSteps(undefined)).toBeNull();
		expect(salvageRevisedSteps("")).toBeNull();
		expect(
			salvageRevisedSteps("the model apologised and wrote prose"),
		).toBeNull();
		expect(
			salvageRevisedSteps(JSON.stringify({ rationale: "x", steps: [] })),
		).toBeNull();
	});

	it("reads step markup out of a bare, non-JSON completion", () => {
		const salvaged = salvageRevisedSteps(
			"<step><action>Open the page</action><expected>It renders</expected></step>",
		);

		expect(salvaged?.steps).toEqual([
			{ action: "Open the page", expected: "It renders" },
		]);
	});

	// The four containers below all reached the rethrow before, so a correct
	// revision in any of them was shown to the user as "Internal server error".
	// Each is the same content with the wrapper one step wrong.

	it("recovers a single step the model did not wrap in an array", () => {
		const salvaged = salvageRevisedSteps(
			JSON.stringify({
				rationale: "one step changed",
				steps: { action: "Do the thing", expected: "It happened" },
			}),
		);

		expect(salvaged?.steps).toEqual([
			{ action: "Do the thing", expected: "It happened" },
		]);
		expect(salvaged?.rationale).toBe("one step changed");
	});

	it("recovers steps returned as plain strings", () => {
		const salvaged = salvageRevisedSteps(
			JSON.stringify({
				rationale: "prose steps",
				steps: [
					"Open the invoice",
					"Press Pay and confirm the receipt",
				],
			}),
		);

		// No stated expectation is not the same as no step: the action is the
		// half a reviewer cannot reconstruct, and blank expectations already
		// pass through from a well-formed array.
		expect(salvaged?.steps).toEqual([
			{ action: "Open the invoice", expected: "" },
			{ action: "Press Pay and confirm the receipt", expected: "" },
		]);
	});

	it("recovers a top-level array with the wrapper object omitted", () => {
		const salvaged = salvageRevisedSteps(
			JSON.stringify([
				{ action: "Do the thing", expected: "It happened" },
			]),
		);

		expect(salvaged?.steps).toEqual([
			{ action: "Do the thing", expected: "It happened" },
		]);
		expect(salvaged?.rationale).toBe("");
	});

	it("recovers a completion the model wrapped in a markdown fence", () => {
		const salvaged = salvageRevisedSteps(
			'```json\n{"rationale":"fenced","steps":[{"action":"Do the thing","expected":"It happened"}]}\n```',
		);

		expect(salvaged?.steps).toEqual([
			{ action: "Do the thing", expected: "It happened" },
		]);
		expect(salvaged?.rationale).toBe("fenced");
	});
});
