/**
 * Guards two defects found while QA'ing the unified agent interface (Fizzy
 * #2040), both of which made the chat look healthy while it silently dropped
 * what the user asked for.
 *
 * 1. MCP servers enabled in the control deck never reached the request.
 *    `selectedConversationMcpIds` (the per-conversation override) was seeded
 *    from the sidebar prop at mount. The prop starts `[]`, `[]` is non-null so
 *    it won the `??` chain that resolves the active ids, and `[]` means "no
 *    MCP at all" downstream — so the deck read "1/10 selected" while the wire
 *    payload carried `enabledMcpConfigIds: []` and the model correctly
 *    reported it had no such tools. `null` is the only value that means "no
 *    override, use the live sidebar selection".
 *
 * 2. One `role: "system"` row killed a thread permanently. Conversations
 *    persist three roles (`agents.conversations.recordOperationResult` writes
 *    system rows); the chat API accepted two. The client cast the persisted
 *    role through into `history`, so the route rejected every subsequent turn
 *    with "Invalid request body" — the thread could never be used again.
 *
 * Both modules pull in the whole chat surface / Temporal + database, so they
 * are not cheap to import for an invariant check. This reads the live source
 * instead, mirroring stream-max-duration-drift.test.ts.
 */

import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";

function readSource(relativePath: string): string {
	return readFileSync(join(process.cwd(), relativePath), "utf-8");
}

const DIRECT_CHAT_PATH =
	"modules/saas/agents/components/FabricChat/FabricDirectChat.tsx";
const STREAM_ROUTE_PATH = "app/api/agents/fabric-ai/stream/route.ts";

describe("Direct chat MCP selection", () => {
	const source = readSource(DIRECT_CHAT_PATH);

	it("starts with no per-conversation override so the sidebar selection applies", () => {
		expect(source).toMatch(
			/const \[selectedConversationMcpIds, setSelectedConversationMcpIds\] =\s*\n?\s*useState<string\[\] \| null>\(null\)/,
		);
	});

	it("never seeds the override from the sidebar prop", () => {
		// Any `setSelectedConversationMcpIds(... enabledMcpConfigIds ...)` re-
		// freezes the value and reintroduces the bug.
		const seeded = source.match(
			/setSelectedConversationMcpIds\([^)]*enabledMcpConfigIds[^)]*\)/g,
		);
		expect(seeded).toBeNull();
	});

	it("shows the effective selection in the conversation tool picker", () => {
		// With no override the chat runs on the sidebar selection, so the
		// dialog has to fall back to it or enabled servers render unchecked.
		expect(source).toMatch(
			/selectedIds=\{\s*selectedConversationMcpIds \?\? enabledMcpConfigIds \?\? null\s*\}/,
		);
	});
});

describe("conversation rehydration", () => {
	const source = readSource(DIRECT_CHAT_PATH);

	it("normalizes persisted roles instead of casting them", () => {
		expect(source).not.toMatch(/role: msg\.role as "user" \| "assistant"/);
		expect(source).toMatch(
			/role: msg\.role === "user" \? "user" : "assistant"/,
		);
	});
});

describe("floating drawer tool parity", () => {
	// The drawer passed no MCP selection at all, so it ran on the always-on
	// managed servers only: the same question, asked from the drawer and from
	// the full page in the same workspace, reached the model with different
	// tools — and the servers the user had enabled were absent in the drawer.
	// It already reads the stored preference for simple/advanced; this hands
	// the same record's server list to the chat.
	const source = readSource(
		"modules/saas/agents/components/FabricAgentLauncher.tsx",
	);

	it("passes the stored MCP selection into the chat", () => {
		expect(source).toMatch(
			/const storedMcpConfigIds = interfaceModeQuery\.data\?\.enabledMcpConfigIds/,
		);
		expect(source).toMatch(/enabledMcpConfigIds=\{storedMcpConfigIds\}/);
	});
});

describe("control deck tabs", () => {
	// The Agents tab configures the specialists the orchestrator delegates to.
	// On Direct it was still offered and rendered a blank deck — the panel's
	// own guards (`showAgents && sectionMode !== "tools"`) resolve to nothing
	// there, so the tab highlighted and the body below it stayed empty.
	const source = readSource(
		"modules/saas/agents/components/fabric-ai/FabricAIClient.tsx",
	);

	it("offers the Agents tab only on the orchestrator engine", () => {
		expect(source).toMatch(
			/\.\.\.\(useOrchestrator\s*\n?\s*\?\s*\[\s*\n?\s*\{\s*\n?\s*id: "agents" as TabType,/,
		);
	});

	it("moves off the Agents tab when the engine leaves orchestrator", () => {
		expect(source).toMatch(
			/if \(!useOrchestrator && activeTab === "agents"\) \{\s*\n?\s*setActiveTab\("tools"\);/,
		);
	});
});

describe("chat stream route history contract", () => {
	const source = readSource(STREAM_ROUTE_PATH);

	it("accepts the system role a persisted conversation can carry", () => {
		expect(source).toMatch(
			/role: z\.enum\(\["user", "assistant", "system"\]\)/,
		);
	});

	it("folds it into the assistant turn before the workflow sees it", () => {
		// The workflow input is typed to two roles; a system row must be
		// attributed, not forwarded.
		expect(source).toMatch(/history: rawHistory/);
		expect(source).toMatch(
			/const history = rawHistory\.map\([\s\S]{0,240}?entry\.role === "user"/,
		);
	});
});
