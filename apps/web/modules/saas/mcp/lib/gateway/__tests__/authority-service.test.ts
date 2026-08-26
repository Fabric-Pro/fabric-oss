/**
 * Authority Service Tests
 *
 * Tests for provider normalization, access level classification,
 * and request fingerprinting. These are pure-logic tests that don't
 * require a database.
 *
 * Run with: pnpm --filter web test -- authority-service
 */

import { describe, expect, it } from "vitest";
import {
	classifyAccessLevel,
	generateRequestFingerprint,
	resolveProviderFromMcpConfig,
	resolveProviderKeyForPlatformTool,
	resolveProviderKeyFromToolPrefix,
} from "../authority-service";

// ─── Access Level Classification ────────────────────────────────────────────

describe("classifyAccessLevel", () => {
	describe("read operations", () => {
		const readTools = [
			"list_issues",
			"get_user",
			"search_documents",
			"read_file",
			"find_projects",
			"fetch_data",
			"query_database",
			"describe_table",
			"show_details",
			"count_items",
			"check_status",
			"view_report",
		];

		it.each(readTools)("should classify '%s' as READ", (toolName) => {
			expect(classifyAccessLevel(toolName)).toBe("READ");
		});
	});

	describe("write operations", () => {
		const writeTools = [
			"create_issue",
			"update_user",
			"delete_file",
			"remove_member",
			"send_message",
			"post_comment",
			"set_status",
			"add_label",
			"edit_document",
			"modify_settings",
			"move_card",
			"assign_task",
			"close_ticket",
			"archive_project",
			"publish_post",
			"execute_workflow",
			"run_automation",
			"trigger_webhook",
			"invite_user",
			"revoke_access",
			"upload_file",
		];

		it.each(writeTools)("should classify '%s' as WRITE", (toolName) => {
			expect(classifyAccessLevel(toolName)).toBe("WRITE");
		});
	});

	describe("annotation overrides", () => {
		it("should use readOnlyHint annotation over name pattern", () => {
			// Tool name looks like write, but annotation says read-only
			expect(
				classifyAccessLevel("create_report", { readOnlyHint: true }),
			).toBe("READ");
		});

		it("should use destructiveHint annotation", () => {
			// Tool name looks like read, but annotation says destructive
			expect(
				classifyAccessLevel("list_and_purge", {
					destructiveHint: true,
				}),
			).toBe("WRITE");
		});
	});

	describe("namespaced tools", () => {
		it("should strip server prefix before classification", () => {
			expect(classifyAccessLevel("linear__list_issues")).toBe("READ");
			expect(classifyAccessLevel("github__create_pr")).toBe("WRITE");
		});

		it("should strip fabric_ prefix", () => {
			expect(classifyAccessLevel("fabric_list_projects")).toBe("READ");
			expect(classifyAccessLevel("fabric_create_project")).toBe("WRITE");
		});
	});

	describe("conservative fallback", () => {
		it("should classify unknown tools as WRITE", () => {
			expect(classifyAccessLevel("do_something")).toBe("WRITE");
			expect(classifyAccessLevel("process_data")).toBe("WRITE");
			expect(classifyAccessLevel("transform")).toBe("WRITE");
		});
	});
});

// ─── Provider Normalization ─────────────────────────────────────────────────

describe("resolveProviderFromMcpConfig", () => {
	it("should resolve known server keys to canonical provider keys", () => {
		const result = resolveProviderFromMcpConfig({
			id: "config-1",
			mcpServer: { key: "github", name: "GitHub" },
		});
		expect(result.providerKey).toBe("github");
		expect(result.providerType).toBe("MCP");
		expect(result.displayName).toBe("GitHub");
	});

	it("should resolve github-mcp to github", () => {
		const result = resolveProviderFromMcpConfig({
			id: "config-2",
			mcpServer: { key: "github-mcp", name: "GitHub MCP" },
		});
		expect(result.providerKey).toBe("github");
	});

	it("should use custom: prefix for unknown servers", () => {
		const result = resolveProviderFromMcpConfig({
			id: "config-3",
			mcpServer: { key: "my-custom-server", name: "My Server" },
		});
		expect(result.providerKey).toBe("custom:my-custom-server");
	});

	it("should use displayName over server name", () => {
		const result = resolveProviderFromMcpConfig({
			id: "config-4",
			displayName: "My GitHub",
			mcpServer: { key: "github", name: "GitHub" },
		});
		expect(result.displayName).toBe("My GitHub");
	});

	it("should handle missing server key", () => {
		const result = resolveProviderFromMcpConfig({
			id: "config-5",
			displayName: "Unknown",
			mcpServer: null,
		});
		expect(result.providerKey).toBe("custom:config-5");
	});
});

describe("resolveProviderKeyFromToolPrefix", () => {
	const servers = [
		{
			configId: "c1",
			displayName: "GitHub Integration",
			toolPrefix: "github_integration",
		},
		{
			configId: "c2",
			displayName: "My Custom Tool",
			toolPrefix: "my_custom_tool",
		},
		{
			configId: "c3",
			displayName: "Linear",
			toolPrefix: "linear",
		},
	];

	it("should resolve known provider from display name", () => {
		const result = resolveProviderKeyFromToolPrefix(
			"github_integration",
			servers,
		);
		expect(result?.providerKey).toBe("github");
	});

	it("should resolve linear by display name", () => {
		const result = resolveProviderKeyFromToolPrefix("linear", servers);
		expect(result?.providerKey).toBe("linear");
	});

	it("should use custom: prefix for unknown", () => {
		const result = resolveProviderKeyFromToolPrefix(
			"my_custom_tool",
			servers,
		);
		expect(result?.providerKey).toBe("custom:my_custom_tool");
	});

	it("should return null for unmatched prefix", () => {
		const result = resolveProviderKeyFromToolPrefix("nonexistent", servers);
		expect(result).toBeNull();
	});
});

describe("resolveProviderKeyForPlatformTool", () => {
	it("should return 'fabric'", () => {
		expect(resolveProviderKeyForPlatformTool()).toBe("fabric");
	});
});

// ─── Request Fingerprinting ─────────────────────────────────────────────────

describe("generateRequestFingerprint", () => {
	it("should generate a deterministic fingerprint", async () => {
		const fp1 = await generateRequestFingerprint("create_issue", {
			title: "Bug fix",
			priority: 1,
		});
		const fp2 = await generateRequestFingerprint("create_issue", {
			title: "Bug fix",
			priority: 1,
		});
		expect(fp1).toBe(fp2);
	});

	it("should generate different fingerprints for different args", async () => {
		const fp1 = await generateRequestFingerprint("create_issue", {
			title: "Bug A",
		});
		const fp2 = await generateRequestFingerprint("create_issue", {
			title: "Bug B",
		});
		expect(fp1).not.toBe(fp2);
	});

	it("should generate different fingerprints for different tools", async () => {
		const fp1 = await generateRequestFingerprint("create_issue", {
			title: "X",
		});
		const fp2 = await generateRequestFingerprint("update_issue", {
			title: "X",
		});
		expect(fp1).not.toBe(fp2);
	});

	it("should be order-independent for args", async () => {
		const fp1 = await generateRequestFingerprint("tool", {
			a: 1,
			b: 2,
		});
		const fp2 = await generateRequestFingerprint("tool", {
			b: 2,
			a: 1,
		});
		expect(fp1).toBe(fp2);
	});

	it("should return a hex string", async () => {
		const fp = await generateRequestFingerprint("test", {});
		expect(fp).toMatch(/^[0-9a-f]+$/);
		expect(fp.length).toBe(64); // SHA-256 = 32 bytes = 64 hex chars
	});
});
