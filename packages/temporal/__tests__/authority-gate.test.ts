/**
 * Authority Gate Tests
 *
 * Tests for the orchestrator-side authority enforcement module.
 * Covers provider key resolution and access level classification.
 * These are pure-logic tests that don't require a database.
 *
 * Run with: pnpm --filter @repo/temporal test -- authority-gate
 */

import { describe, expect, it } from "vitest";
import {
	classifyIntegrationAccessLevel,
	classifyToolAccessLevel,
	resolveIntegrationProviderKey,
	resolveProviderKey,
} from "../src/activities/orchestrator/execution/authority-gate";

// ─── Provider Key Resolution ────────────────────────────────────────────────

describe("resolveProviderKey (MCP server)", () => {
	it("should resolve known server keys", () => {
		expect(resolveProviderKey("github")).toBe("github");
		expect(resolveProviderKey("github-mcp")).toBe("github");
		expect(resolveProviderKey("linear")).toBe("linear");
		expect(resolveProviderKey("slack")).toBe("slack");
		expect(resolveProviderKey("notion")).toBe("notion");
		expect(resolveProviderKey("azure-devops")).toBe("azure-devops");
		expect(resolveProviderKey("jira")).toBe("jira");
		expect(resolveProviderKey("atlassian-jira")).toBe("jira");
	});

	it("should be case-insensitive", () => {
		expect(resolveProviderKey("GitHub")).toBe("github");
		expect(resolveProviderKey("LINEAR")).toBe("linear");
	});

	it("should use custom: prefix for unknown keys", () => {
		expect(resolveProviderKey("my-server")).toBe("custom:my-server");
		expect(resolveProviderKey("internal-api")).toBe("custom:internal-api");
	});
});

describe("resolveIntegrationProviderKey", () => {
	it("should resolve known integration providers", () => {
		expect(resolveIntegrationProviderKey("GITHUB")).toBe("github");
		expect(resolveIntegrationProviderKey("SLACK")).toBe("slack");
		expect(resolveIntegrationProviderKey("MICROSOFT_TEAMS")).toBe(
			"microsoft-teams",
		);
	});

	it("should normalize underscores to hyphens", () => {
		expect(resolveIntegrationProviderKey("AZURE_DEVOPS")).toBe(
			"azure-devops",
		);
	});

	it("should use custom: prefix for unknown providers", () => {
		expect(resolveIntegrationProviderKey("CUSTOM_PROVIDER")).toBe(
			"custom:custom-provider",
		);
	});
});

// ─── Access Level Classification ────────────────────────────────────────────

describe("classifyToolAccessLevel", () => {
	it("should classify read operations", () => {
		expect(classifyToolAccessLevel("list_issues")).toBe("READ");
		expect(classifyToolAccessLevel("get_user")).toBe("READ");
		expect(classifyToolAccessLevel("search_projects")).toBe("READ");
		expect(classifyToolAccessLevel("find_item")).toBe("READ");
		expect(classifyToolAccessLevel("fetch_data")).toBe("READ");
		expect(classifyToolAccessLevel("query_db")).toBe("READ");
		expect(classifyToolAccessLevel("count_items")).toBe("READ");
		expect(classifyToolAccessLevel("check_status")).toBe("READ");
	});

	it("should classify write operations", () => {
		expect(classifyToolAccessLevel("create_issue")).toBe("WRITE");
		expect(classifyToolAccessLevel("update_status")).toBe("WRITE");
		expect(classifyToolAccessLevel("delete_item")).toBe("WRITE");
		expect(classifyToolAccessLevel("send_message")).toBe("WRITE");
		expect(classifyToolAccessLevel("post_comment")).toBe("WRITE");
		expect(classifyToolAccessLevel("archive_project")).toBe("WRITE");
		expect(classifyToolAccessLevel("publish_page")).toBe("WRITE");
		expect(classifyToolAccessLevel("execute_workflow")).toBe("WRITE");
	});

	it("should default unknown operations to WRITE", () => {
		expect(classifyToolAccessLevel("process_data")).toBe("WRITE");
		expect(classifyToolAccessLevel("handle_event")).toBe("WRITE");
	});
});

describe("classifyIntegrationAccessLevel", () => {
	it("should use the same classification as tools", () => {
		// SLACK has no shared executor, so both fall through to the heuristic.
		expect(classifyIntegrationAccessLevel("list_channels", "SLACK")).toBe(
			"READ",
		);
		expect(classifyIntegrationAccessLevel("send_message", "SLACK")).toBe(
			"WRITE",
		);
	});
});
