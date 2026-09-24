/**
 * The assistant introduces itself as Advisor on both engines (Fizzy #2571).
 *
 * Asked what it was, the Direct engine answered "I'm Fabric Loom" — its system
 * prompt opened with that retired name — and the Orchestrator, which had no
 * identity line at all, improvised one from chat history and memory ("I run
 * in a 'Loom' workspace environment"). Both now start from one constant.
 *
 * The workflow half is read as source, as `clarity-project-context-wiring`
 * does: importing a workflow module pulls in the Temporal sandbox machinery.
 */
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import {
	buildLegacyDirectChatSystemInstructions,
	DIRECT_CHAT_CACHEABLE_SYSTEM_PROMPT,
	DIRECT_CHAT_IDENTITY,
} from "../../activities/direct-chat/prompt-cache";
import {
	ADVISOR_IDENTITY,
	orchestratorBasePrompt,
} from "../assistant-identity";

const RETIRED_NAMES = /\b(Loom|Nexus)\b/;

describe("ADVISOR_IDENTITY", () => {
	it("names Advisor and no retired product name", () => {
		expect(ADVISOR_IDENTITY).toMatch(/\bAdvisor\b/);
		expect(ADVISOR_IDENTITY).not.toMatch(RETIRED_NAMES);
	});
});

describe("Direct engine identity", () => {
	it("is the shared identity, not a restatement of it", () => {
		expect(DIRECT_CHAT_IDENTITY).toBe(ADVISOR_IDENTITY);
	});

	it("opens both system templates", () => {
		const legacy = buildLegacyDirectChatSystemInstructions({
			capabilitiesInstructions: "CAPABILITIES:\n- No tools connected.",
			webSearchInstructions: "",
			frameOutputInstructions: "",
			currentDateContext: "Today is September 24, 2026.",
		});

		expect(
			DIRECT_CHAT_CACHEABLE_SYSTEM_PROMPT.startsWith(ADVISOR_IDENTITY),
		).toBe(true);
		expect(legacy.startsWith(ADVISOR_IDENTITY)).toBe(true);
		expect(DIRECT_CHAT_CACHEABLE_SYSTEM_PROMPT).not.toMatch(RETIRED_NAMES);
		expect(legacy).not.toMatch(RETIRED_NAMES);
	});
});

describe("orchestratorBasePrompt", () => {
	it("gives a run with no caller persona the Advisor identity", () => {
		expect(orchestratorBasePrompt(undefined)).toBe(ADVISOR_IDENTITY);
		expect(orchestratorBasePrompt("")).toBe(ADVISOR_IDENTITY);
	});

	it("treats a whitespace-only caller prompt as no persona", () => {
		expect(orchestratorBasePrompt("  \n\t ")).toBe(ADVISOR_IDENTITY);
	});

	// The drawer, @template instructions and agent instances bring their own
	// persona. Prepending a second name is the conflict this exists to remove.
	it("leaves a caller's own persona untouched", () => {
		const drawer =
			"You are Fabric Agent, answering from the copilot panel docked to the page the user is on.";

		expect(orchestratorBasePrompt(drawer)).toBe(drawer);
	});
});

describe("orchestrator initialization wiring", () => {
	const initialization = readFileSync(
		join(
			process.cwd(),
			"src/workflows/orchestrator/phases/initialization.ts",
		),
		"utf-8",
	);

	// A history recorded before the marker must replay with the base it ran
	// with; only a run that records the marker starts from Advisor's identity.
	it("seeds the system prompt through the helper behind the patch marker", () => {
		expect(initialization).toMatch(
			/let enrichedSystemPrompt = patched\("orchestrator-advisor-identity-v1"\)\s*\?\s*orchestratorBasePrompt\(input\.systemPrompt\)\s*:\s*input\.systemPrompt \|\| "";/,
		);
	});

	it("calls the marker exactly once, so replay order cannot drift", () => {
		expect(
			initialization.match(/patched\("orchestrator-advisor-identity-v1"\)/g),
		).toHaveLength(1);
	});

	// The planning audit records "custom agent instructions" only when a
	// caller actually sent some — the default identity is not one.
	it("keeps the custom-instructions audit keyed on the caller's prompt", () => {
		expect(initialization).toMatch(/if \(input\.systemPrompt\) \{/);
	});
});
