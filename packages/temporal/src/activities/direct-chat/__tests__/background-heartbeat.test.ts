import { readFileSync } from "node:fs";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { ActivityHeartbeatDetails } from "../../../types";
import {
	DIRECT_CHAT_BACKGROUND_HEARTBEAT_MS,
	startBackgroundHeartbeat,
} from "../background-heartbeat";

/**
 * Direct chat's only heartbeats came from the model-stream loop, so a slow
 * MCP tool or a silent reasoning step outlived the workflow's 30 s
 * `heartbeatTimeout` and Temporal re-ran the whole agentic loop, repeating
 * every tool call (Fizzy #2040, review F23).
 */

const HEARTBEAT_TIMEOUT_MS = 30_000;

function details(
	overrides: Partial<ActivityHeartbeatDetails> = {},
): ActivityHeartbeatDetails {
	return {
		phase: "preparing",
		message: "Preparing",
		progress: 60,
		toolCalls: [],
		timestamp: 0,
		...overrides,
	};
}

describe("startBackgroundHeartbeat", () => {
	beforeEach(() => {
		vi.useFakeTimers();
	});
	afterEach(() => {
		vi.useRealTimers();
	});

	it("beats well inside the workflow's heartbeat timeout while nothing streams", () => {
		const beat = vi.fn();
		const ticker = startBackgroundHeartbeat(details(), beat);

		// A 60 s MCP tool call with no stream parts at all.
		vi.advanceTimersByTime(60_000);

		expect(DIRECT_CHAT_BACKGROUND_HEARTBEAT_MS).toBeLessThan(
			HEARTBEAT_TIMEOUT_MS / 2,
		);
		expect(beat.mock.calls.length).toBeGreaterThanOrEqual(
			60_000 / DIRECT_CHAT_BACKGROUND_HEARTBEAT_MS,
		);
		ticker.stop();
	});

	it("re-sends the live state of the turn, not a bare phase", () => {
		// The stream route treats the latest heartbeat as the turn's state:
		// a beat without the text and tool calls would blank the screen.
		const beat = vi.fn();
		const ticker = startBackgroundHeartbeat(details(), beat);
		let responseText = "Let me check";
		ticker.track(() =>
			details({
				phase: "streaming",
				responseText,
				toolCalls: [
					{
						id: "call-1",
						name: "mcp_example_search",
						args: {},
						status: "running",
					},
				],
			}),
		);
		responseText = "Let me check the roadmap";

		vi.advanceTimersByTime(DIRECT_CHAT_BACKGROUND_HEARTBEAT_MS);

		const sent = beat.mock.calls.at(-1)?.[0] as ActivityHeartbeatDetails;
		expect(sent.phase).toBe("streaming");
		expect(sent.responseText).toBe("Let me check the roadmap");
		expect(sent.toolCalls).toHaveLength(1);
		ticker.stop();
	});

	it("stops beating once stopped", () => {
		const beat = vi.fn();
		const ticker = startBackgroundHeartbeat(details(), beat);
		ticker.stop();

		vi.advanceTimersByTime(60_000);

		expect(beat).not.toHaveBeenCalled();
	});

	it("survives a heartbeat that throws outside an activity context", () => {
		const beat = vi.fn(() => {
			throw new Error("not in activity context");
		});
		const ticker = startBackgroundHeartbeat(details(), beat);

		expect(() => vi.advanceTimersByTime(30_000)).not.toThrow();
		ticker.stop();
	});
});

describe("Direct chat activity wiring", () => {
	// ai-execution.ts pulls in the AI SDK, the database and agent-core, so the
	// wiring is read as source (same approach as mcp-tool-timeout-wiring).
	const source = readFileSync(
		join(process.cwd(), "src/activities/direct-chat/ai-execution.ts"),
		"utf-8",
	);

	it("wraps the whole turn in the background heartbeat and always stops it", () => {
		const entry = source.slice(
			source.indexOf("export async function executeDirectChatActivity("),
			source.indexOf("interface DirectChatTurnParams"),
		);
		expect(entry).toMatch(
			/const backgroundHeartbeat = startBackgroundHeartbeat\(/,
		);
		expect(entry).toMatch(
			/try \{\s*return await runDirectChatTurn\([\s\S]*\} finally \{\s*backgroundHeartbeat\.stop\(\);/,
		);
	});

	it("points the ticker at the streaming state", () => {
		expect(source).toMatch(/backgroundHeartbeat\.track\(\(\) => \(\{/);
	});
});
