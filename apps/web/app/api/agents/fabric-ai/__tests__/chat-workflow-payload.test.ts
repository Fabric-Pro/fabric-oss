import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it, vi } from "vitest";
import {
	assertChatWorkflowPayload,
	CHAT_PAYLOAD_TOO_LARGE_MESSAGE,
} from "../chat-workflow-payload";

/**
 * Neither chat route measured its workflow input against Temporal's 4 MiB
 * start frame, so an oversized turn failed with a gRPC error nobody could
 * act on (review F38).
 */
describe("assertChatWorkflowPayload", () => {
	it("passes an ordinary turn and returns its size", () => {
		expect(
			assertChatWorkflowPayload({ message: "hello" }, "test start"),
		).toBeGreaterThan(0);
	});

	it("refuses an input over the frame with a message the user can act on", () => {
		const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
		expect(() =>
			assertChatWorkflowPayload(
				{ message: "x".repeat(5 * 1024 * 1024) },
				"test start",
			),
		).toThrow(CHAT_PAYLOAD_TOO_LARGE_MESSAGE);
		warn.mockRestore();
	});
});

describe("chat route wiring", () => {
	const read = (path: string) =>
		readFileSync(join(process.cwd(), path), "utf-8");
	// The Direct route builds and starts its workflow in `direct-turn.ts`.
	const direct = read("app/api/agents/fabric-ai/stream/direct-turn.ts");
	const orchestrator = read(
		"app/api/agents/fabric-ai/orchestrator-temporal/stream/route.ts",
	);
	// The Orchestrator route and runtime engine measure their input and
	// bound its history through this module.
	const orchestratorTurn = read(
		"app/api/agents/fabric-ai/orchestrator-temporal/orchestrator-turn.ts",
	);

	it("measures the Direct input before starting its workflow", () => {
		const guard = direct.indexOf("assertChatWorkflowPayload(");
		const start = direct.indexOf('"directChatWorkflow",');
		expect(guard).toBeGreaterThan(-1);
		expect(start).toBeGreaterThan(guard);
	});

	it("measures the orchestrator input and bounds its history", () => {
		const guard = orchestrator.indexOf(
			"refuseOversizedOrchestratorInput(workflowInput)",
		);
		// The start itself lives in the shared turn starter
		// (orchestrator-temporal/turn-admission.ts); the guard must run
		// before the route hands the input to it.
		const start = orchestrator.indexOf("await startTurnWorkflow({");
		expect(guard).toBeGreaterThan(-1);
		expect(start).toBeGreaterThan(guard);
		expect(orchestratorTurn).toContain("assertChatWorkflowPayload(");
		expect(orchestratorTurn).toMatch(/status: 413/);
		expect(orchestratorTurn).toContain(
			"const history = windowUntypedHistory(rawHistory);",
		);
	});

	it("forwards the orchestrator's truncation on completion", () => {
		// The route and the runtime engine follow a run through the shared
		// observer.
		expect(
			read(
				"app/api/agents/fabric-ai/orchestrator-temporal/execution-observer.ts",
			),
		).toMatch(/truncated: result\.truncated,/);
	});
});
