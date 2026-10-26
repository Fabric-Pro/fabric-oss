/**
 * An orchestrator turn whose ChatGPT plans all ran out mid-turn finishes on
 * the organization's API billing, and the chat said nothing about it
 * (Fizzy #3048). The loop records it on the workflow state behind
 * `orch-api-billing-signal-v1`, and the output carries it to the chat. Read
 * from source: the workflow modules are not importable outside the Temporal
 * sandbox.
 */
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";

const loop = readFileSync(join(__dirname, "../iterative-execution.ts"), "utf8");
const completion = readFileSync(join(__dirname, "../completion.ts"), "utf8");

describe("orchestrator API billing signal", () => {
	it("records it only behind its patch marker", () => {
		const helper = loop.slice(
			loop.indexOf("function recordApiBilling("),
			loop.indexOf("function checkIterationBudget("),
		);
		expect(helper).toContain(
			'if (apiBilling && patched("orch-api-billing-signal-v1"))',
		);
		expect(helper).toContain("state.apiBilling = apiBilling;");
		// The state is written nowhere else.
		expect(loop.split("state.apiBilling =").length).toBe(2);
	});

	it("records it from every model round: the loop's and both synthesis attempts", () => {
		for (const result of [
			"iterationResult",
			"synthesisResult",
			"retryResult",
		]) {
			expect(loop).toMatch(
				new RegExp(
					`recordAdvisorRequests\\(state, ${result}\\);\\s*recordApiBilling\\(state, ${result}\\.apiBilling\\);`,
				),
			);
		}
	});

	it("puts it on the workflow output", () => {
		expect(completion).toContain(
			"...(state.apiBilling ? { apiBilling: state.apiBilling } : {}),",
		);
	});
});
