/**
 * A connect's MESSAGES_SNAPSHOT read back as the saved conversation it was
 * built from (`runtime/thread.ts`), so a reattached chat shows a saved answer
 * the way a reopened one does: each tool call's saved status, how long the
 * answer reasoned and when it was stopped.
 */

import type { Message } from "@ag-ui/client";
import { describe, expect, it } from "vitest";
import { snapshotToPersistedMessages } from "../direct-runtime-events";

const ASKED_AT = "2026-10-30T09:00:00.000Z";
const STOPPED_AT = "2026-10-30T09:00:05.000Z";

/** An answer as the runtime's snapshot sends it. */
const snapshot: Message[] = [
	{
		id: "run-a:user",
		role: "user",
		content: "What changed?",
		metadata: { fabric: { timestamp: ASKED_AT } },
	},
	{ id: "run-a:assistant:reasoning", role: "reasoning", content: "Check" },
	{
		id: "run-a:assistant",
		role: "assistant",
		content: "Two things",
		toolCalls: [
			{
				id: "tool-1",
				type: "function",
				function: { name: "search_docs", arguments: '{"query":"x"}' },
			},
			{
				id: "tool-2",
				type: "function",
				function: { name: "create_story", arguments: "{}" },
			},
			{
				id: "tool-3",
				type: "function",
				function: { name: "read_page", arguments: "{}" },
			},
		],
		metadata: {
			fabric: {
				timestamp: STOPPED_AT,
				streamStatus: "cancelled",
				cancelledAt: STOPPED_AT,
				reasoningDurationMs: 900,
				toolStatus: { "tool-1": "success", "tool-2": "pending" },
			},
		},
	},
	{
		id: "tool-1:result",
		role: "tool",
		toolCallId: "tool-1",
		content: '{"hits":2}',
	},
	{
		id: "tool-3:result",
		role: "tool",
		toolCallId: "tool-3",
		content: "boom",
		error: "boom",
	},
];

describe("snapshotToPersistedMessages", () => {
	it("reads back the answer's saved tool status, reasoning time and stop time", () => {
		expect(snapshotToPersistedMessages(snapshot)).toEqual([
			{
				id: "run-a:user",
				role: "user",
				content: "What changed?",
				timestamp: ASKED_AT,
			},
			{
				id: "run-a:assistant",
				role: "assistant",
				content: "Two things",
				timestamp: STOPPED_AT,
				streamStatus: "cancelled",
				cancelledAt: STOPPED_AT,
				reasoningDurationMs: 900,
				reasoningText: "Check",
				toolCalls: [
					{
						id: "tool-1",
						name: "search_docs",
						args: { query: "x" },
						result: '{"hits":2}',
						status: "success",
					},
					// Waiting for approval: no result, and it stays pending.
					{
						id: "tool-2",
						name: "create_story",
						args: {},
						status: "pending",
					},
					// Saved without a status: its failed result says error.
					{
						id: "tool-3",
						name: "read_page",
						args: {},
						result: "boom",
						status: "error",
					},
				],
			},
		]);
	});
});
