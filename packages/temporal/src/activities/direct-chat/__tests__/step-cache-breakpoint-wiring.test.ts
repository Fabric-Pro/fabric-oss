/**
 * Guards Fizzy #3099: direct chat's `streamText` tool loop takes the rolling
 * per-step cache breakpoint that keeps the history marker
 * `buildDirectChatPromptCacheRequest` placed up front. The plain
 * `makeStepCacheBreakpoint` would strip that marker, and the next turn would
 * stop reusing the cached history. The variant's behaviour, including a real
 * multi-step AI SDK call, is tested in
 * `packages/ai/lib/__tests__/step-cache-breakpoint.test.ts`.
 *
 * `ai-execution.ts` pulls in the AI SDK, the database, and agent-core, so —
 * following `allow-system-in-messages-wiring.test.ts` — this reads the file as
 * source and asserts on the call site.
 */

import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";

const aiExecutionSource = readFileSync(
	join(process.cwd(), "src/activities/direct-chat/ai-execution.ts"),
	"utf-8",
);

function streamTextCallBlock(): string {
	const start = aiExecutionSource.indexOf("const result = streamText({");
	expect(start).toBeGreaterThanOrEqual(0);
	const end = aiExecutionSource.indexOf("\n\t\t});", start);
	expect(end).toBeGreaterThan(start);
	return aiExecutionSource.slice(start, end);
}

describe("Direct chat streamText — per-step cache breakpoint wiring", () => {
	it("passes the prepareStep built for this call", () => {
		expect(streamTextCallBlock()).toContain(
			"...(prepareStep ? { prepareStep } : {}),",
		);
	});

	it("builds it with the variant that keeps the up-front history marker, gated on the resolved model and the tools sent", () => {
		expect(aiExecutionSource).toMatch(
			/const prepareStep = makeAppendedStepCacheBreakpoint\(\{\s*provider: metadata\.provider,\s*modelString: metadata\.modelString,\s*hasTools: shouldUseTools,\s*\}\);/,
		);
		expect(aiExecutionSource).not.toMatch(/\bmakeStepCacheBreakpoint\b/);
	});
});
