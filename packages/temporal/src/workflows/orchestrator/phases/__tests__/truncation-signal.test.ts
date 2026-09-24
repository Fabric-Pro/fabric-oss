/**
 * An orchestrator answer cut at the output-token ceiling was shown as
 * complete (review F25). The loop records it on the workflow state behind
 * `orch-truncation-signal-v1`, and the output carries it to the chat. Read
 * from source: the workflow modules are not importable outside the Temporal
 * sandbox.
 */
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";

const loop = readFileSync(join(__dirname, "../iterative-execution.ts"), "utf8");
const completion = readFileSync(join(__dirname, "../completion.ts"), "utf8");

describe("orchestrator truncation signal", () => {
	it("records truncation only behind its patch marker", () => {
		const helper = loop.slice(
			loop.indexOf("function recordTruncation("),
			loop.indexOf("function checkIterationBudget("),
		);
		expect(helper).toContain(
			'if (truncated && patched("orch-truncation-signal-v1"))',
		);
		expect(helper).toContain("state.truncated = truncated;");
		// The state is written nowhere else.
		expect(loop.split("state.truncated =").length).toBe(2);
	});

	it("records it for the final answer and for the exhaustion synthesis", () => {
		const finalBranch = loop.slice(
			loop.indexOf('if (iterationResult.type === "response") {'),
		);
		expect(finalBranch).toMatch(
			/recordTruncation\(state, iterationResult\.truncated\);[\s\S]*data: \{ finalResponse \}/,
		);
		expect(loop).toContain("recordTruncation(state, synthesisTruncated);");
	});

	it("puts it on the workflow output", () => {
		expect(completion).toContain(
			"...(state.truncated ? { truncated: state.truncated } : {}),",
		);
	});
});
