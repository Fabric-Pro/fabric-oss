/**
 * The gateway tells a platform tool from a connected server's tool by name
 * alone (`isPlatformToolName`): a `fabric_` name with no `__`. A connection's
 * prefix can start with `fabric_` too ("Fabric Docs" gets `fabric_docs`), so
 * the routing holds only while no platform tool name contains `__`.
 */

import { describe, expect, it } from "vitest";
import { PLATFORM_TOOL_DEFINITIONS } from "../platform-tools";
import { isPlatformToolName } from "../server-selection";

describe("platform tool names", () => {
	it("checks every tool, so the test cannot pass on an empty list", () => {
		expect(PLATFORM_TOOL_DEFINITIONS.length).toBeGreaterThan(40);
	});

	it("are all routed as platform tools", () => {
		const misrouted = PLATFORM_TOOL_DEFINITIONS.map(
			(tool) => tool.name,
		).filter((name) => !isPlatformToolName(name));
		expect(misrouted).toEqual([]);
	});
});

describe("isPlatformToolName", () => {
	it("reads a connected tool whose prefix starts with fabric as connected", () => {
		expect(isPlatformToolName("fabric_2__list_items")).toBe(false);
		expect(isPlatformToolName("fabric_docs__list_items")).toBe(false);
	});

	it("reads a fabric_ name without __ as a platform tool", () => {
		expect(isPlatformToolName("fabric_list_projects")).toBe(true);
	});
});
