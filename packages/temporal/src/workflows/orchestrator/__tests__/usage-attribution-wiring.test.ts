/**
 * The orchestrator activities that resolve a model in-process carry the chat's
 * conversation, so their usage-log rows record it.
 *
 * The iterative loop's rounds, summarizer and compaction are exercised end to
 * end in `phases/__tests__/usage-attribution.test.ts`. The other call sites
 * are read as source, as `clarity-project-context-wiring.test.ts` does:
 * importing the workflow module pulls in the Temporal sandbox machinery.
 */
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { conversationIdField } from "../usage-attribution";

function source(path: string): string {
	return readFileSync(
		join(process.cwd(), "src/workflows/orchestrator", path),
		"utf-8",
	);
}

/** The argument text of every `<name>(` call in `text`, up to its `});`. */
function callArguments(text: string, name: string): string[] {
	const out: string[] = [];
	const pattern = new RegExp(`\\b${name}\\(`, "g");
	for (const match of text.matchAll(pattern)) {
		const start = match.index ?? 0;
		const end = text.indexOf("});", start);
		out.push(text.slice(start, end));
	}
	return out;
}

describe("conversationIdField", () => {
	it("spreads the conversation when the run has one", () => {
		expect(conversationIdField({ conversationId: "conv-1" })).toEqual({
			conversationId: "conv-1",
		});
	});

	it("adds no key without one", () => {
		expect(conversationIdField({})).toEqual({});
		expect(conversationIdField({ conversationId: "" })).toEqual({});
	});
});

describe("usage attribution — workflow wiring", () => {
	it("both clarity checks carry the conversation", () => {
		const calls = callArguments(
			source("index.ts"),
			"analyzeIntentClarityActivity",
		);
		expect(calls).toHaveLength(2);
		for (const call of calls) {
			expect(call).toContain("...conversationIdField(input)");
		}
	});

	it("the routing and planning inputs carry the conversation", () => {
		const planning = source("phases/planning.ts");
		const routing = planning.slice(
			planning.indexOf("const routingInput = {"),
			planning.indexOf("const routingDecision ="),
		);
		const plan = planning.slice(
			planning.indexOf("const planInput = {"),
			planning.indexOf("taskPlan = turn?.turnScope"),
		);
		expect(routing).toContain("...conversationIdField(input)");
		expect(plan).toContain("...conversationIdField(input)");
	});

	it("the trajectory summary carries the conversation, not the execution-ID fallback", () => {
		const [call] = callArguments(
			source("phases/completion.ts"),
			"embedAndStoreTrajectory",
		);
		expect(call).toContain("...conversationIdField({ conversationId })");
		expect(call).not.toContain("effectiveConversationId");
	});

	it("the loop's compaction call passes the run's conversation", () => {
		const iterative = source("phases/iterative-execution.ts");
		const call = iterative.slice(
			iterative.indexOf("await maybeCompactConversationHistory("),
			iterative.indexOf(
				");",
				iterative.indexOf("await maybeCompactConversationHistory("),
			),
		);
		expect(call).toMatch(/turn,\s*input\.conversationId,?\s*$/);
	});

	it("a plan step's input carries the run's conversation", () => {
		const steps = source("step-processing.ts");
		const stepInput = steps.slice(
			steps.indexOf("const stepInput = {"),
			steps.indexOf(
				"enabledMcpConfigIds",
				steps.indexOf("const stepInput = {"),
			),
		);
		expect(stepInput).toContain("conversationId: input.conversationId");
	});
});
