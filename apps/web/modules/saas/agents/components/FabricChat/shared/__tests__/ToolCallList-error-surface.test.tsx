/**
 * Regression tests for the always-visible error and Runtime-Authority
 * surfaces in `<ToolCallList>` (PR 1093 review #1 + #2).
 *
 * Original PR 1093 added `expandable={false}` so Fabric Loom shows tools
 * as static pills. But error messages and the Runtime-Authority recovery
 * banner BOTH lived inside `<ToolContent>`, which `expandable={false}`
 * suppresses entirely. The unintended consequence: a user whose tool
 * call failed (or whose MCP provider needed approval) saw only a small
 * red "Error" status badge with no actionable info.
 *
 * Fix: lift both blocks OUT of `<ToolContent>` so they render as
 * siblings of `<Tool>` regardless of expand state. These tests pin
 * both contracts so a future refactor cannot silently re-bury them.
 */

import { render, screen } from "@testing-library/react";
import { describe, expect, it } from "vitest";
import { ToolCallList } from "../ToolCallList";

describe("<ToolCallList> error surface — visible when expandable=false (PR 1093 review #1)", () => {
	it("surfaces error message inline even when the tool card is non-expandable", () => {
		render(
			<ToolCallList
				expandable={false}
				toolCalls={[
					{
						id: "t1",
						name: "code_search",
						args: { query: "foo" },
						result: "index not ready",
						status: "error",
						error: "Index build failed: timeout after 30s",
					},
				]}
			/>,
		);

		// The actual error message text is the key assertion — without
		// our fix, this string would never appear (it lived inside
		// ToolContent which is suppressed when expandable=false). The
		// label "Error" appears in both the status Badge and our banner
		// — using the message text avoids the multi-match ambiguity.
		expect(
			screen.getByText(/Index build failed: timeout after 30s/i),
		).toBeDefined();
	});

	it("falls back to result string when explicit error field is missing", () => {
		// Some upstream tools put the error message directly in the
		// `result` field instead of `error`. The fallback chain in the
		// lifted error block (toolCall.error || stringified result) keeps
		// either shape visible.
		render(
			<ToolCallList
				expandable={false}
				toolCalls={[
					{
						id: "t2",
						name: "mcp_query",
						args: {},
						result: "Upstream 502 Bad Gateway",
						status: "error",
					},
				]}
			/>,
		);

		expect(screen.getByText(/Upstream 502 Bad Gateway/i)).toBeDefined();
	});

	it("does NOT render an error block when status is success", () => {
		const { container } = render(
			<ToolCallList
				expandable={false}
				toolCalls={[
					{
						id: "t3",
						name: "ok_tool",
						args: {},
						result: "this result text would leak if banner rendered",
						status: "success",
					},
				]}
			/>,
		);
		// The result text is what the error banner would dump if the
		// status->error gate was bypassed. With success, it must not
		// appear anywhere. The tool name "ok_tool" still renders inside
		// the static pill.
		expect(
			container.textContent?.includes(
				"this result text would leak if banner rendered",
			),
		).toBe(false);
		expect(container.textContent?.includes("ok_tool")).toBe(true);
	});
});

describe("<ToolCallList> Runtime-Authority banner — visible when expandable=false (PR 1093 review #2)", () => {
	it("renders the authority banner when the tool result advertises a pending authority state", () => {
		// The authority banner is triggered by the agent serializing a
		// canonical shape into the tool result. extractAuthorityState
		// (ToolCallList.tsx:213) reads `authorityRequired: true` plus the
		// provider/access metadata at the top level of the result object
		// (not a JSON string).
		const authorityResult = {
			authorityRequired: true,
			providerKey: "github",
			requiredAccessLevel: "write",
			pendingSessionId: "sess_abc123",
			hint: "Set scope: repo,workflow",
		};

		render(
			<ToolCallList
				expandable={false}
				toolCalls={[
					{
						id: "t4",
						name: "github_create_pr",
						args: {},
						result: authorityResult,
						// `success` lets us isolate the authority-banner
						// assertions from the error-block stringification
						// (which would otherwise dump the same fields and
						// trigger getByText "multiple elements found").
						status: "success",
					},
				]}
			/>,
		);

		// All key recovery details surface to the user without
		// requiring expansion:
		expect(screen.getByText("Runtime authority required")).toBeDefined();
		expect(screen.getByText(/Approve github \(write\)/i)).toBeDefined();
		expect(screen.getByText(/sess_abc123/)).toBeDefined();
		expect(screen.getByText(/Set scope: repo,workflow/)).toBeDefined();
	});

	it("renders the authority banner even on expandable=true surfaces (consistent UX)", () => {
		// We deliberately chose to ALWAYS show the banner — moving it
		// out of ToolContent means orchestrator-chat users no longer
		// need to expand the tool to see it either. This is a small UX
		// upgrade that's worth pinning so a future refactor doesn't
		// accidentally re-gate it behind expansion.
		const authorityResult = {
			authorityRequired: true,
			providerKey: "slack",
			requiredAccessLevel: "post_messages",
		};

		render(
			<ToolCallList
				expandable={true}
				toolCalls={[
					{
						id: "t5",
						name: "slack_post",
						args: {},
						result: authorityResult,
						status: "success",
					},
				]}
			/>,
		);

		expect(screen.getByText("Runtime authority required")).toBeDefined();
		expect(
			screen.getByText(/Approve slack \(post_messages\)/i),
		).toBeDefined();
	});
});

/**
 * A tool call that never ran carries an `error` and NO `result` — the shape
 * the direct-chat activity settles an abandoned call into (Fizzy #2040).
 * `JSON.stringify(undefined)` returns `undefined` rather than a string, so
 * the fallback rendered nothing and the user saw a red "Error" heading over
 * an empty box. Reported from a real staging run.
 */
describe("<ToolCallList> error surface — a call with no result (Fizzy #2040)", () => {
	it("shows the error message when there is no result to fall back to", () => {
		render(
			<ToolCallList
				expandable={false}
				toolCalls={[
					{
						id: "call-1",
						name: "mcp_example_get_identity",
						args: {},
						status: "error",
						error: "The model's request for this tool ended before it was complete, so the tool never ran.",
					},
				]}
			/>,
		);

		expect(
			screen.getByText(/ended before it was complete/i),
		).toBeInTheDocument();
	});

	it("never renders an empty error box when neither error nor result is present", () => {
		render(
			<ToolCallList
				expandable={false}
				toolCalls={[
					{
						id: "call-2",
						name: "mcp_example_search",
						args: {},
						status: "error",
					},
				]}
			/>,
		);

		expect(
			screen.getByText(/reported an error but sent no details/i),
		).toBeInTheDocument();
	});
});
