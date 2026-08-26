import { describe, expect, it } from "vitest";
import {
	buildReadOnlyBlockedOutput,
	classifyReadOnlyToolAccess,
	isReadOnlyBlockedOutput,
	READ_ONLY_MODE_ERROR_CODE,
	READ_ONLY_MODE_MESSAGE,
} from "../read-only-mode";

describe("classifyReadOnlyToolAccess", () => {
	it.each([
		"list_work_items",
		"get_card",
		"search_issues",
		"read_page",
		"find-items",
		"fetch_comments",
		"query_board",
		"describe_project",
		"show_diagram",
		"count_rows",
		"check_status",
		"view_dashboard",
	])("classifies %s as READ", (name) => {
		expect(classifyReadOnlyToolAccess(name)).toBe("READ");
	});

	it.each([
		"create_work_item",
		"update_card",
		"delete_issue",
		"send_message",
		"upload_attachment",
		"close_ticket",
	])("classifies %s as WRITE", (name) => {
		expect(classifyReadOnlyToolAccess(name)).toBe("WRITE");
	});

	it("defaults unknown names to WRITE (conservative)", () => {
		expect(classifyReadOnlyToolAccess("do_something")).toBe("WRITE");
		expect(classifyReadOnlyToolAccess("sync")).toBe("WRITE");
	});

	it("blocks content-creation tools the authority gate whitelists — diagram sync is an external write here", () => {
		// classifyToolAccessLevel (authority-gate.ts) returns READ for these so
		// agents can draw without approval; Read-only mode must NOT inherit
		// that exemption (card #2007 explicitly blocks "sync a diagram").
		expect(classifyReadOnlyToolAccess("create_diagram")).toBe("WRITE");
		expect(classifyReadOnlyToolAccess("create_view")).toBe("WRITE");
		expect(classifyReadOnlyToolAccess("open_drawio_xml")).toBe("WRITE");
	});

	it("requires a prefix separator — 'getaway_tool' is not a get_* read", () => {
		expect(classifyReadOnlyToolAccess("getaway_tool")).toBe("WRITE");
	});

	it("classifies a compound read-prefixed WRITE tool as WRITE (composed verb)", () => {
		// A read prefix must not wave through a name that also mutates.
		expect(classifyReadOnlyToolAccess("get_or_create_page")).toBe("WRITE");
		expect(classifyReadOnlyToolAccess("find_or_create_issue")).toBe(
			"WRITE",
		);
		expect(classifyReadOnlyToolAccess("list_and_delete_stale")).toBe(
			"WRITE",
		);
	});

	// Token-level write verbs: compound names whose mutating verb is OUTSIDE
	// the substring list (replace/send/publish/…) must not ride a read prefix
	// through the gate. These were the classifier's last known write escapes.
	it.each([
		"search_and_replace",
		"get_and_send_report",
		"list_and_archive_stale",
		"fetch_and_push",
		"find_and_move_items",
		"read_and_submit",
		"getAndPublishPage",
		"get_or_replace_config",
	])("classifies compound %s as WRITE (token-level verb)", (name) => {
		expect(classifyReadOnlyToolAccess(name)).toBe("WRITE");
	});

	// Token matching must NOT break reads whose tokens merely RESEMBLE write
	// verbs — this is exactly why the check is token-equality, not substring.
	it.each([
		"get_closed_cards", // "closed" ≠ "close"
		"list_posts", // "posts" ≠ "post" (and "post" is deliberately excluded)
		"get_settings", // "settings" ≠ "set"
		"get_merge_request", // "merge" deliberately excluded
		"list_merge_requests",
		"download_attachment",
		"download_file",
		"preview_page",
		"preview_document",
	])("still classifies %s as READ (token safety)", (name) => {
		expect(classifyReadOnlyToolAccess(name)).toBe("READ");
	});

	it("does NOT misclassify genuine reads that merely contain a non-listed verb", () => {
		// "merge" is deliberately NOT a write-substring — these are real reads.
		expect(classifyReadOnlyToolAccess("get_merge_request")).toBe("READ");
		expect(classifyReadOnlyToolAccess("list_merge_requests")).toBe("READ");
	});

	// Real-inventory reads that the position-0 prefix test used to classify
	// WRITE, blocking pulls/polls in read-only projects (post-ship review
	// finding). Names verified against the live Fizzy/ADO/Rovo/Sandbox tool
	// catalogs — a regression here refuses real reads, not just a heuristic.
	it.each([
		// vendor-prefixed snake_case (Fizzy MCP, ADO official MCP)
		"fizzy_get_card",
		"fizzy_get_cards",
		"fizzy_get_accounts",
		"fizzy_get_identity",
		"wit_get_work_item",
		"wit_list_work_items",
		"wit_get_work_items_batch_by_ids",
		// camelCase (Atlassian Rovo, Sandbox MCP)
		"getJiraIssue",
		"searchJiraIssuesUsingJql",
		"getVisibleJiraProjects",
		"getConfluenceSpaces",
		"getAccessibleAtlassianResources",
		"getSession",
		"listSessions",
		"readFile",
		"getDiff",
		// OAuth executor namespaced names (gated before prefix-stripping)
		"Microsoft_Teams__list_teams",
		"Microsoft_Teams__get_transcript",
		"Slack__get_channel_history",
		"GitHub__list_issues",
		// bare-verb and pure-lookup reads (Perplexity, NHTSA, Firecrawl)
		"search",
		"ask",
		"decode_vin",
		"decode_wmi",
		"scrape_url",
		"crawl_site",
	])("classifies real-inventory read %s as READ", (name) => {
		expect(classifyReadOnlyToolAccess(name)).toBe("READ");
	});

	// The widened read detection must NOT admit any real write — every name
	// here is a genuine external mutation from the same tool catalogs.
	it.each([
		"fizzy_create_card",
		"fizzy_update_card",
		"fizzy_close_card",
		"fizzy_move_card_to_column",
		// tokenization trap: strip-one must not surface the trailing "read"
		"fizzy_mark_notification_read",
		"fizzy_mark_all_notifications_read",
		"wit_create_work_item",
		"wit_update_work_item",
		"createJiraIssue",
		"editJiraIssue",
		"transitionJiraIssue",
		"addCommentToJiraIssue",
		"sendMessage",
		"chat.postMessage",
		"Slack__send_message",
		"Microsoft_Teams__send_message",
		"writeFile",
		"destroySession",
		"runClaude",
		"linear_create_issue",
		"slack_send_message",
		// integration__ container names carry the real op in args — the
		// container itself must stay WRITE (call sites resolve the op).
		"integration__NHTSA_VPIC",
		"integration__SLACK",
	])("still classifies real-inventory write %s as WRITE", (name) => {
		expect(classifyReadOnlyToolAccess(name)).toBe("WRITE");
	});
});

describe("buildReadOnlyBlockedOutput / isReadOnlyBlockedOutput", () => {
	it("builds a structured block with the canonical code and message", () => {
		const out = buildReadOnlyBlockedOutput("create_card");
		expect(out).toEqual({
			error: READ_ONLY_MODE_MESSAGE,
			code: READ_ONLY_MODE_ERROR_CODE,
			toolName: "create_card",
		});
	});

	it("round-trips through the type guard", () => {
		expect(isReadOnlyBlockedOutput(buildReadOnlyBlockedOutput())).toBe(
			true,
		);
		expect(isReadOnlyBlockedOutput({ error: "other" })).toBe(false);
		expect(isReadOnlyBlockedOutput(null)).toBe(false);
		expect(isReadOnlyBlockedOutput("string")).toBe(false);
	});
});
