import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";

/**
 * The Direct activity cannot run outside its provider, database and MCP
 * graph, so its wiring of the turn-limit helpers is read from source
 * (review F25, F37, F38). The helpers themselves are unit-tested beside this.
 */
const activity = readFileSync(
	join(process.cwd(), "src/activities/direct-chat/ai-execution.ts"),
	"utf-8",
);

describe("Direct turn-limit wiring", () => {
	it("fits the history to the model's window before building messages", () => {
		const fit = activity.indexOf(
			"const fittedHistory = fitHistoryToContext({",
		);
		const build = activity.indexOf("history.forEach((h:");
		expect(fit).toBeGreaterThan(-1);
		expect(build).toBeGreaterThan(fit);
		expect(activity.slice(fit, build)).toContain(
			"contextWindow: resolveContextWindow(metadata, catalogContextWindow),",
		);
		// The raw request history is never replayed directly.
		expect(activity).not.toMatch(
			/requestHistory\.forEach|requestHistory\s*\?\.\s*map/,
		);
	});

	it("passes the step count and cap to the outcome and returns the truncation", () => {
		expect(activity).toMatch(
			/resolveStreamOutcome\(\{[\s\S]*?stepCount: steps\.length,\s*maxSteps,\s*\}\)/,
		);
		expect(activity).toMatch(
			/streamOutcome\.truncated\s*\?\s*\{ truncated: streamOutcome\.truncated \}/,
		);
	});

	it("budgets image attachments before splicing them", () => {
		const budget = activity.indexOf(
			"budgetImageAttachments(imageAttachments)",
		);
		const splice = activity.indexOf("spliceImagePartsIntoLastUserMessage(");
		expect(budget).toBeGreaterThan(-1);
		expect(splice).toBeGreaterThan(budget);
		expect(activity.slice(splice, splice + 200)).toContain(
			"imageBudget.kept",
		);
	});
});
