/**
 * Guards the fix for the hung tool call found while QA'ing the unified agent
 * interface (Fizzy #2040): an MCP `tool.execute` that never settles used to
 * hang the whole turn on the Direct engine. The tool card sat on `Running`,
 * no assistant text was ever produced, and because a running status is
 * persisted as running, a reload rehydrated the same live spinner — so the
 * chat looked busy indefinitely rather than reporting a failure.
 *
 * `runWithTimeout` already existed for exactly this, with its own unit tests
 * (../../orchestrator/execution/__tests__/mcp-call-timeout.test.ts), but the
 * Direct path called `toolDef.execute(args)` bare. This asserts the wiring,
 * which is the part that actually regressed; ai-execution.ts pulls in the AI
 * SDK, the database and agent-core, so it is read as source rather than
 * imported for an invariant check.
 */

import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";

// Resolved from the package root (vitest runs with cwd = packages/temporal)
// rather than from `import.meta.url`: this tree is also pulled into the web
// app's TypeScript program, where an `import.meta` in it breaks resolution
// for unrelated activity modules.
const aiExecutionSource = readFileSync(
	join(process.cwd(), "src/activities/direct-chat/ai-execution.ts"),
	"utf-8",
);

describe("Direct chat MCP tool execution", () => {
	it("bounds every MCP tool call", () => {
		expect(aiExecutionSource).toMatch(
			/return runWithTimeout<unknown>\(\s*\n?\s*call,\s*\n?\s*DEFAULT_MCP_TOOL_TIMEOUT_MS,/,
		);
	});

	it("covers the whole call, not just the tool's own execute", () => {
		// The read-only guard and the authority check both await the database
		// BEFORE the tool runs. Leaving them outside the ceiling leaves the
		// same dead turn — a card stuck on `Running` — from a different await.
		const closure = aiExecutionSource.slice(
			aiExecutionSource.indexOf("const call = (async () => {"),
			aiExecutionSource.indexOf("return runWithTimeout<unknown>("),
		);
		expect(closure).toMatch(/guardToolWriteForReadOnly/);
		expect(closure).toMatch(/ensureSensitiveOperationAuthority/);
		expect(closure).toMatch(/return toolDef\.execute\(args\);/);
	});

	it("hands the model an error it can relay on timeout", () => {
		// A thrown activity failure would surface as a dead stream; a tool
		// result keeps the turn alive so the assistant can say what happened.
		expect(aiExecutionSource).toMatch(/did not respond within/);
	});

	it("shares the ceiling with the orchestrator path", () => {
		expect(aiExecutionSource).toMatch(
			/DEFAULT_MCP_TOOL_TIMEOUT_MS,\s*\n?\s*runWithTimeout,\s*\n?\s*\} from "\.\.\/orchestrator\/execution\/mcp-call-timeout"/,
		);
	});
});

describe("explicitly attached MCP servers", () => {
	/**
	 * `analyzeToolNeed` is a keyword heuristic over the message text alone: a
	 * message containing "explain", "what is", "why" and friends returns
	 * `needsTools: false` outright, and a single tool-intent keyword scores 15
	 * against a threshold of 30. When it says no, MCP loading is skipped and
	 * the model is told "No tools connected. Suggest the user connect tools in
	 * Settings." — which is what the user then hears, while the sidebar shows
	 * the servers as active. A selection the user made explicitly has to beat
	 * the guess.
	 */
	it("are loaded regardless of the keyword heuristic", () => {
		expect(aiExecutionSource).toMatch(
			/const shouldForceLoadAttachedMcpTools =\s*\n?\s*Boolean\(instanceId\) \|\|\s*\n?\s*\(Array\.isArray\(enabledMcpConfigIds\) &&\s*\n?\s*enabledMcpConfigIds\.length > 0\)/,
		);
	});

	it("reads the selection off the workflow input", () => {
		expect(aiExecutionSource).toMatch(
			/enabledFabricToolIds,\s*\n?\s*enabledMcpConfigIds,/,
		);
	});
});
