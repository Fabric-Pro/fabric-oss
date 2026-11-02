import { ToolMessage } from "@langchain/core/messages";
import { describe, expect, it } from "vitest";
import { AgUiToolResults } from "../src/ag-ui-tool-results";

function finishCall(results: AgUiToolResults, id = "example-call") {
	results.observe({ type: "TOOL_CALL_START", toolCallId: id });
	results.observe({ type: "TOOL_CALL_END", toolCallId: id });
}

describe("AG-UI tool results", () => {
	it.each([true, false])(
		"preserves structured success=%s across large result previews",
		(success) => {
			const results = new AgUiToolResults();
			finishCall(results);
			const [event] = results.collect([
				{
					type: "tool",
					tool_call_id: "example-call",
					content: JSON.stringify({
						success,
						message: "x".repeat(6000),
						password: "example-secret-value",
					}),
				},
			]);
			expect(JSON.parse(event!.content)).toMatchObject({
				success,
				truncated: true,
			});
			expect(event!.content.length).toBeLessThanOrEqual(4001);
			expect(event!.content).not.toContain("example-secret-value");
		},
	);
	it.each([
		new ToolMessage({
			content: '{"success":true}',
			tool_call_id: "example-call",
		}),
		{
			type: "tool",
			content: '{"success":true}',
			tool_call_id: "example-call",
		},
		{
			lc: 1,
			type: "constructor",
			id: ["langchain_core", "messages", "ToolMessage"],
			kwargs: {
				content: '{"success":true}',
				tool_call_id: "example-call",
			},
		},
	])("emits a real tool result exactly once", (message) => {
		const results = new AgUiToolResults();
		finishCall(results);
		expect(results.collect([message])).toEqual([
			{
				type: "TOOL_CALL_RESULT",
				messageId: "example-call:result",
				toolCallId: "example-call",
				role: "tool",
				content: '{"success":true}',
			},
		]);
		expect(results.collect([message])).toEqual([]);
	});
	it("ignores historical, foreign, malformed and not-yet-finished calls", () => {
		const results = new AgUiToolResults();
		const message = {
			type: "tool",
			tool_call_id: "example-call",
			content: "ok",
		};
		expect(results.collect([message])).toEqual([]);
		results.observe({ type: "TOOL_CALL_END", toolCallId: "example-call" });
		expect(results.collect([message])).toEqual([]);
		results.observe({
			type: "TOOL_CALL_START",
			toolCallId: "example-call",
		});
		expect(results.collect([message])).toEqual([]);
		finishCall(results);
		expect(
			results.collect([
				{ ...message, tool_call_id: "foreign" },
				{ ...message, type: "ai" },
			]),
		).toEqual([]);
		expect(results.collect([message])).toHaveLength(1);
		expect(new AgUiToolResults().collect([message])).toEqual([]);
	});
	it("preserves explicit failure even when content claims success", () => {
		const results = new AgUiToolResults();
		finishCall(results);
		const [event] = results.collect([
			new ToolMessage({
				tool_call_id: "example-call",
				content: '{"success":true}',
				status: "error",
			}),
		]);
		expect(JSON.parse(event!.content)).toMatchObject({ success: false });
	});
	it("redacts credential fields and bounds previews", () => {
		const results = new AgUiToolResults();
		finishCall(results);
		const [event] = results.collect([
			{
				type: "tool",
				tool_call_id: "example-call",
				content: JSON.stringify({
					password: "example-secret-value",
					data: "x".repeat(6000),
				}),
			},
		]);
		expect(event!.content).not.toContain("example-secret-value");
		expect(event!.content.length).toBeLessThanOrEqual(4001);
		expect(JSON.parse(event!.content)).toMatchObject({ truncated: true });
	});
	it("keeps long credential-bearing failures redacted and valid JSON within the preview budget", () => {
		const results = new AgUiToolResults();
		finishCall(results);
		const [event] = results.collect([
			new ToolMessage({
				tool_call_id: "example-call",
				status: "error",
				content: JSON.stringify({
					password: "example-secret-value",
					detail: '\\"\n'.repeat(3000),
				}),
			}),
		]);
		expect(event!.content.length).toBeLessThanOrEqual(4001);
		expect(event!.content).not.toContain("example-secret-value");
		expect(JSON.parse(event!.content)).toMatchObject({
			success: false,
			error: expect.any(String),
		});
	});
});
