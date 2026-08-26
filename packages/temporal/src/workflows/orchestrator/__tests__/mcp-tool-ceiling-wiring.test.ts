/**
 * The orchestrator's `executeMcpTool` supports a per-call ceiling — it races
 * the call against `runWithTimeout` — but only when the caller supplies
 * `timeoutMs`, and no Loom call site did. A server that never answered was
 * therefore bounded only by the activity timeout, which surfaces as a run that
 * dies rather than a tool error the assistant can talk about. The Direct
 * engine was fixed first (see activities/direct-chat/__tests__); this pins the
 * orchestrator half.
 *
 * The call sits in a workflow, so widening the recorded activity input needs a
 * `patched()` gate — without it, replaying a history recorded before this
 * change fails with a non-determinism error. That gate is the part most likely
 * to be dropped in a later refactor, so it is asserted explicitly.
 *
 * Read as source: importing a workflow module pulls in the Temporal sandbox
 * machinery, and this is a wiring invariant.
 */

import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";

const source = readFileSync(
	join(
		process.cwd(),
		"src/workflows/orchestrator/phases/iterative-execution.ts",
	),
	"utf-8",
);

describe("orchestrator MCP tool ceiling", () => {
	it("passes a ceiling to executeMcpTool", () => {
		expect(source).toMatch(
			/timeoutMs: patched\("loom-mcp-tool-call-ceiling-v1"\)\s*\n?\s*\?\s*DEFAULT_MCP_TOOL_TIMEOUT_MS\s*\n?\s*:\s*undefined/,
		);
	});

	it("keeps the old shape for histories recorded before the change", () => {
		// A bare `timeoutMs: DEFAULT_MCP_TOOL_TIMEOUT_MS` would replay-fail.
		expect(source).not.toMatch(/timeoutMs: DEFAULT_MCP_TOOL_TIMEOUT_MS,/);
	});

	it("shares the ceiling with the Direct engine", () => {
		expect(source).toMatch(
			/import \{ DEFAULT_MCP_TOOL_TIMEOUT_MS \} from "\.\.\/\.\.\/\.\.\/activities\/orchestrator\/execution\/mcp-call-timeout"/,
		);
	});
});
