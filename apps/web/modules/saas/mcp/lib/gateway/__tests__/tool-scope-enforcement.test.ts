/**
 * The scopes chosen when an API key is created are enforced on MCP (Fizzy #2380).
 *
 * They were stored and never read here. `GatewaySession` carried no scope list
 * at all, so a key ticked "MCP Read" and nothing else could call every write
 * tool on this surface — while the same scopes had always been enforced on the
 * REST v1 API. The checkboxes in the create dialog were decorative.
 *
 * The case that matters most is the compatibility one. Keys already in
 * circulation default to `["mcp:read", "mcp:write"]`, and enforcement that
 * demanded `projects:write` from them would break every one on the day it
 * deployed. So the coarse `mcp:*` scopes act as umbrellas over their direction,
 * and `legacy default reaches every tool` below is the assertion that says so.
 *
 * Scopes only ever subtract. They cannot grant a caller more than their role
 * allows — that is what the permission checks do, and they have their own
 * suite. A key is authentication; a scope is a limit its owner chose to accept.
 */

import { describe, expect, it, vi } from "vitest";

vi.mock("@repo/database", () => ({
	db: {},
	hasProjectAccess: vi.fn().mockResolvedValue(true),
	canUpdateProjectStory: vi.fn().mockResolvedValue(true),
	canCreateProjectInOrganization: vi.fn().mockResolvedValue(true),
	listProjects: vi.fn().mockResolvedValue([]),
	updateTask: vi.fn(),
	createProject: vi.fn(),
}));

import {
	executePlatformTool,
	PLATFORM_TOOL_DEFINITIONS,
	TOOL_SCOPES,
} from "../platform-tools";
import type { GatewaySession } from "../types";

function sessionWith(scopes: string[]): GatewaySession {
	return {
		sessionId: "sess-1",
		userId: "user-1",
		organizationId: "org-1",
		userName: "Example Agent",
		email: "agent@example.com",
		role: "user",
		credential: "organization-key",
		scopes,
		createdAt: new Date("2026-01-01T00:00:00Z"),
		expiresAt: new Date("2026-01-02T00:00:00Z"),
	};
}

function text(result: { content: Array<{ text: string }> }) {
	return result.content[0].text;
}

/** Did the call fail on scope, as opposed to succeeding or failing later? */
async function refusedOnScope(tool: string, scopes: string[]) {
	const result = await executePlatformTool(tool, {}, sessionWith(scopes));
	return text(result).includes("does not have the");
}

describe("a key is held to the scopes it was given", () => {
	it("refuses a write to a key that only holds mcp:read", async () => {
		expect(await refusedOnScope("fabric_update_task", ["mcp:read"])).toBe(
			true,
		);
	});

	it("allows a read to that same key", async () => {
		expect(await refusedOnScope("fabric_list_projects", ["mcp:read"])).toBe(
			false,
		);
	});

	it("accepts the tool's own specific scope, without any umbrella", async () => {
		expect(
			await refusedOnScope("fabric_update_task", ["features:write"]),
		).toBe(false);
	});

	it("refuses a scope that belongs to a different area", async () => {
		expect(
			await refusedOnScope("fabric_update_task", ["frames:write"]),
		).toBe(true);
	});

	it("refuses a key holding no scopes at all", async () => {
		expect(await refusedOnScope("fabric_list_projects", [])).toBe(true);
	});

	it("lets a wildcard key through", async () => {
		expect(await refusedOnScope("fabric_update_task", ["*"])).toBe(false);
	});

	// A key permitted to write is not meaningfully denied a read, and a key
	// ticked "MCP Write" only would be baffling to find read-blocked.
	it("treats mcp:write as covering reads too", async () => {
		expect(
			await refusedOnScope("fabric_list_projects", ["mcp:write"]),
		).toBe(false);
	});
});

describe("keys already in circulation keep working", () => {
	// The default every organization key is created with. If this ever goes
	// red, enforcement has become a breaking change for every existing key.
	const LEGACY_DEFAULT = ["mcp:read", "mcp:write"];

	it("the legacy default reaches every tool", async () => {
		const refused: string[] = [];
		for (const tool of PLATFORM_TOOL_DEFINITIONS) {
			if (await refusedOnScope(tool.name, LEGACY_DEFAULT)) {
				refused.push(tool.name);
			}
		}
		expect(refused).toEqual([]);
	});

	// Browser sessions carry `["*"]` — no key chose scopes for them, and the
	// interactive permission checks that already govern the UI are not
	// loosened or tightened by anything on this path.
	it("a browser session reaches every tool", async () => {
		const refused: string[] = [];
		for (const tool of PLATFORM_TOOL_DEFINITIONS) {
			if (await refusedOnScope(tool.name, ["*"])) {
				refused.push(tool.name);
			}
		}
		expect(refused).toEqual([]);
	});
});

describe("the scope map covers the tool list", () => {
	// An unmapped tool falls back to requiring `mcp:write`, which is the safe
	// reading of "we do not know what this does" — but it is a fallback, not a
	// plan. A tool added without a scope silently becomes write-gated, which is
	// wrong for a read and invisible until someone reports it.
	it("every exported tool definition has a scope", () => {
		const unmapped = PLATFORM_TOOL_DEFINITIONS.filter(
			(tool) => !TOOL_SCOPES[tool.name],
		).map((tool) => tool.name);

		expect(unmapped).toEqual([]);
	});

	it("maps no tool that does not exist", () => {
		const defined = new Set(PLATFORM_TOOL_DEFINITIONS.map((t) => t.name));
		const stale = Object.keys(TOOL_SCOPES).filter((n) => !defined.has(n));

		expect(stale).toEqual([]);
	});
});
