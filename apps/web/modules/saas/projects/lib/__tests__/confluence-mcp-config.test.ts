/**
 * Unit tests for confluence-mcp-config.ts
 *
 * The predicate must detect a Confluence config via the STABLE catalog signal
 * (`server.tags` / `server.key === "atlassian"`), never the user-editable name.
 */

import { describe, expect, it } from "vitest";
import {
	findConfluenceMcpConfig,
	isConfluenceMcpConfig,
} from "../confluence-mcp-config";

describe("isConfluenceMcpConfig", () => {
	it("detects a config tagged 'confluence' even when the user renamed it", () => {
		const config = {
			id: "c1",
			// User renamed their config — must be ignored.
			mcpServer: {
				key: "atlassian",
				tags: ["jira", "confluence", "bitbucket"],
			},
		};
		expect(isConfluenceMcpConfig(config)).toBe(true);
	});

	it("detects a config whose catalog key is 'atlassian' (no confluence tag)", () => {
		const config = {
			id: "c2",
			mcpServer: { key: "atlassian", tags: ["issues"] },
		};
		expect(isConfluenceMcpConfig(config)).toBe(true);
	});

	it("is case-insensitive on the tag and the key", () => {
		expect(
			isConfluenceMcpConfig({
				mcpServer: { key: "ATLASSIAN", tags: [] },
			}),
		).toBe(true);
		expect(
			isConfluenceMcpConfig({
				mcpServer: { key: "x", tags: ["Confluence"] },
			}),
		).toBe(true);
	});

	it("does NOT detect a Notion-tagged / non-Atlassian config", () => {
		expect(
			isConfluenceMcpConfig({
				mcpServer: { key: "notion", tags: ["notion", "docs"] },
			}),
		).toBe(false);
	});

	it("does NOT detect a config with no linked catalog server", () => {
		expect(isConfluenceMcpConfig({ id: "x", mcpServer: null })).toBe(false);
		expect(isConfluenceMcpConfig({ id: "x" })).toBe(false);
	});
});

describe("findConfluenceMcpConfig", () => {
	it("yields the first matching config (pick-first) when multiple match", () => {
		const configs = [
			{
				id: "first",
				mcpServer: { key: "atlassian", tags: ["confluence"] },
			},
			{
				id: "second",
				mcpServer: { key: "atlassian", tags: ["confluence"] },
			},
		];
		expect(findConfluenceMcpConfig(configs)?.id).toBe("first");
	});

	it("skips non-Confluence configs and returns the first Confluence one", () => {
		const configs = [
			{ id: "notion", mcpServer: { key: "notion", tags: ["notion"] } },
			{
				id: "confluence",
				mcpServer: { key: "atlassian", tags: ["confluence"] },
			},
		];
		expect(findConfluenceMcpConfig(configs)?.id).toBe("confluence");
	});

	it("returns undefined when none match or the list is empty/nullish", () => {
		expect(findConfluenceMcpConfig([])).toBeUndefined();
		expect(findConfluenceMcpConfig(null)).toBeUndefined();
		expect(
			findConfluenceMcpConfig([
				{ id: "n", mcpServer: { key: "notion", tags: ["notion"] } },
			]),
		).toBeUndefined();
	});
});
