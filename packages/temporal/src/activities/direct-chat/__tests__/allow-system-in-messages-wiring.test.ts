/**
 * Guards the fix for Fizzy #2527: since `ai` 6.0.170, `generateText` /
 * `streamText` log "AI SDK Warning: System messages in the prompt or
 * messages fields can be a security risk…" whenever a call's `messages`
 * array contains a `role: "system"` entry, and AI SDK 7 rejects such calls
 * outright unless `allowSystemInMessages` is explicitly set. (The workspace
 * is now on AI SDK 7, so this is a hard rejection, not a warning.)
 *
 * Direct chat's rolling-history path is the one INTENTIONAL exception:
 * `buildDirectChatPromptCacheRequest` (see `../prompt-cache.ts` and its
 * tests) appends a variable `role: "system"` message as the LAST element of
 * `messages` when both `promptCacheEnabled` and `rollingHistoryEnabled` are
 * true — that is Anthropic's mid-conversation-system beta, gated by
 * `supportsAnthropicMidConversationSystem`. Every other combination returns
 * `messages` with no system rows at all (proven by
 * `prompt-cache.test.ts`), so the `streamText` call must only opt in to
 * `allowSystemInMessages` for that one combination.
 *
 * `ai-execution.ts` pulls in the AI SDK, the database, and agent-core, so —
 * following the precedent in `mcp-tool-timeout-wiring.test.ts` — this reads
 * the file as source and asserts on the call site rather than importing and
 * exercising the whole activity.
 */

import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";

// Resolved from the package root (vitest runs with cwd = packages/temporal),
// matching the convention in mcp-tool-timeout-wiring.test.ts.
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

describe("Direct chat streamText — allowSystemInMessages wiring", () => {
	it("passes the rolling-history system row through the system-aware call site", () => {
		const block = streamTextCallBlock();
		// AI SDK 7 renamed the top-level `system` option to `instructions`;
		// `buildDirectChatPromptCacheRequest` still names its field `system`.
		expect(block).toContain("instructions: promptCacheRequest.system,");
		expect(block).toContain("messages: promptCacheRequest.messages,");
	});

	it("sets allowSystemInMessages: true only when both promptCacheEnabled and rollingHistoryEnabled are active", () => {
		const block = streamTextCallBlock();
		expect(block).toMatch(
			/\.\.\.\(promptCacheEnabled && rollingHistoryEnabled\s*\n\s*\?\s*\{\s*allowSystemInMessages:\s*true\s*\}\s*\n\s*:\s*\{\}\),/,
		);
	});

	it("does not set allowSystemInMessages unconditionally", () => {
		const block = streamTextCallBlock();
		// The only occurrence must be inside the conditional spread checked
		// above — never a bare `allowSystemInMessages: true,` on its own line.
		expect(block).not.toMatch(/^\s*allowSystemInMessages: true,\s*$/m);
	});
});
