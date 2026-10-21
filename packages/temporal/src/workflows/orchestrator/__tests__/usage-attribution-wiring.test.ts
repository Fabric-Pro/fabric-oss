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
import { secondaryUsageFields, usageOriginFields } from "../usage-attribution";

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

describe("usageOriginFields", () => {
	it("spreads the conversation when the run has one", () => {
		expect(usageOriginFields({ conversationId: "conv-1" })).toEqual({
			conversationId: "conv-1",
		});
	});

	it("adds no key without one", () => {
		expect(usageOriginFields({})).toEqual({});
		expect(usageOriginFields({ conversationId: "" })).toEqual({});
		expect(usageOriginFields({ usageFrameId: "" })).toEqual({});
	});

	it("maps only the validated launch origin to the model attribution contract", () => {
		expect(
			usageOriginFields({
				conversationId: "conv-1",
				usageFrameId: "frame-1",
				projectId: "project-1",
			}),
		).toEqual({
			conversationId: "conv-1",
			frameId: "frame-1",
			projectId: "project-1",
		});
		expect(usageOriginFields({ frameId: "frame-1" })).toEqual({
			frameId: "frame-1",
		});
		const oldInput = {
			conversationId: "conv-1",
			launchWorkspaceId: "unverified",
			workspaceId: "unverified",
			executionId: "chat-execution",
		};
		expect(usageOriginFields(oldInput)).toEqual({
			conversationId: "conv-1",
		});
	});
});

describe("usage attribution — workflow wiring", () => {
	it("memory loading, hybrid search and episode creation carry separate usage origin", () => {
		for (const [file, activity] of [
			["phases/initialization.ts", "loadOrchestratorMemoryActivity"],
			["phases/initialization.ts", "getHybridRoutingSuggestions"],
			["phases/completion.ts", "createEpisodeFromExecutionActivity"],
		] as const) {
			const [call] = callArguments(source(file), activity);
			expect(call).toContain("...secondaryUsageOriginFields(input)");
		}
	});

	it("both clarity checks carry the conversation", () => {
		const calls = callArguments(
			source("index.ts"),
			"analyzeIntentClarityActivity",
		);
		expect(calls).toHaveLength(2);
		for (const call of calls) {
			expect(call).toContain("...usageOriginFields(input)");
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
		expect(routing).toContain("...usageOriginFields(input)");
		expect(plan).toContain("...usageOriginFields(input)");
	});

	it("the trajectory summary carries the conversation, not the execution-ID fallback", () => {
		const [call] = callArguments(
			source("phases/completion.ts"),
			"embedAndStoreTrajectory",
		);
		expect(call).toContain("...usageOriginFields(input)");
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
		expect(call).toMatch(
			/turn,\s*input\.conversationId,\s*input\.usageFrameId,\s*input\.projectId,?\s*$/,
		);
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
		expect(stepInput).toContain("...usageOriginFields(input)");
	});
});

it("secondary accounting origin never falls back to retrieval or binding ids", () => {
	const input = {
		projectId: "retrieval-project",
		conversationId: "episode-binding",
		usageConversationId: "legacy-conversation",
		usageOrigin: {
			conversationId: "turn-conversation",
			projectId: "origin-project",
			frameId: "origin-frame",
			workflowExecutionId: "origin-execution",
			featureKey: "chat-agent" as const,
		},
	};
	expect(secondaryUsageFields(input)).toEqual(input.usageOrigin);
	const legacyInput = {
		projectId: "retrieval-project",
		usageConversationId: undefined,
	};
	expect(secondaryUsageFields(legacyInput)).toEqual({});
});
