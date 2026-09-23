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

describe("classifyToolAccessLevel — vendor-namespaced names", () => {
	/**
	 * Real tool inventories do not put the verb at position 0. Slack's MCP
	 * server names its own tools `slack_search_public`, so a position-0 test
	 * saw `slack`, learned nothing, and fell through to the conservative WRITE
	 * default — a public message search demanding write authority. Every
	 * namespaced read across every connected server did the same, which trains
	 * people to grant write access in order to read.
	 */
	it("reads a verb that sits behind a vendor token", () => {
		expect(classifyToolAccessLevel("slack_search_public")).toBe("READ");
		expect(classifyToolAccessLevel("github_list_issues")).toBe("READ");
		expect(classifyToolAccessLevel("notion_get_page")).toBe("READ");
	});

	it("reads a verb behind a Vendor__ namespace", () => {
		expect(classifyToolAccessLevel("Microsoft_Teams__list_teams")).toBe(
			"READ",
		);
	});

	/**
	 * The safety property, and the reason the namespaced test runs last: it can
	 * only rescue names that would otherwise have hit the conservative default.
	 * Nothing may become more permissive than it was.
	 */
	it("never lets a namespaced read verb override an explicit write prefix", () => {
		// `update` matches and returns before the read test sees `search_index`.
		expect(classifyToolAccessLevel("update_search_index")).toBe("WRITE");
		expect(classifyToolAccessLevel("delete_get_cache")).toBe("WRITE");
		expect(classifyToolAccessLevel("create_list_view")).toBe("WRITE");
	});

	it("keeps writes hiding behind a vendor token as writes", () => {
		expect(classifyToolAccessLevel("slack_send_message")).toBe("WRITE");
		expect(classifyToolAccessLevel("slack_delete_message")).toBe("WRITE");
	});

	it("does not accept a trailing read verb as a read", () => {
		// A bare verb is never a strip remainder — every test needs a separator
		// after the verb, so "…_read" stays a write.
		expect(classifyToolAccessLevel("fizzy_mark_notification_read")).toBe(
			"WRITE",
		);
	});

	it("leaves the names that already classified correctly alone", () => {
		expect(classifyToolAccessLevel("list_issues")).toBe("READ");
		expect(classifyToolAccessLevel("create_view")).toBe("READ");
		expect(classifyToolAccessLevel("some_unknown_shape")).toBe("WRITE");
	});
});

/**
 * The orchestrator's chat loop now gates every WRITE behind an inline
 * approval, so this classifier decides what interrupts a conversation. Reads
 * must not prompt (that trains people to grant writes), and a name carrying
 * both a read verb and a write verb is a write. `get_or_create_page` used to
 * read as READ on its leading `get`; it can create a page, so it is WRITE now.
 */
describe("classifyToolAccessLevel — chat gate table", () => {
	const READS = [
		"notion-search",
		"notion-fetch",
		"notion-get-users",
		"notion-get-self",
		"notion__notion-search",
		"search",
		"fetch",
		"get_identity",
		"get_workflow_run",
		"get_merge_request",
		"list_posts",
		"get_post",
		"get_closed_cards",
		"list_created_issues",
		"describe_table",
		"retrieve_page",
		"view_board",
		"find_user",
		"query_database",
		"create_view",
	];
	const WRITES = [
		"notion-create-pages",
		"notion-update-page",
		"notion-move-pages",
		"notion-duplicate-page",
		"notion-create-comment",
		"get_or_create_page",
		"find_or_create_issue",
		"search_and_replace",
		"get_and_send_report",
		"mark_read",
		"mark-read",
		"fizzy_mark_notification_read",
		"update_search_index",
		"create_issue",
		"update_page",
		"delete_item",
		"move_card",
		"upload_file",
		"send_message",
		"post_comment",
		"write_file",
		"set_status",
		"add_label",
		"remove_member",
		"some_unknown_shape",
	];

	it.each(READS)("%s is READ", (name) => {
		expect(classifyToolAccessLevel(name)).toBe("READ");
	});

	it.each(WRITES)("%s is WRITE", (name) => {
		expect(classifyToolAccessLevel(name)).toBe("WRITE");
	});
});
