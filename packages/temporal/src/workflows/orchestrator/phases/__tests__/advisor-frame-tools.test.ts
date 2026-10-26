import { CancelledFailure } from "@temporalio/common";
import { beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => {
	const activities = new Map<string, ReturnType<typeof vi.fn>>();
	const stub = (name: string) => {
		let fn = activities.get(name);
		if (!fn) {
			fn = vi.fn();
			activities.set(name, fn);
		}
		return fn;
	};
	return {
		stub,
		resetAll: () => {
			for (const fn of activities.values()) {
				fn.mockReset();
			}
		},
		off: new Set<string>(),
	};
});

vi.mock("@temporalio/workflow", () => ({
	log: { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() },
	patched: vi.fn((id: string) => !mocks.off.has(id)),
	proxyActivities: vi.fn(
		() =>
			new Proxy({}, { get: (_target, name) => mocks.stub(String(name)) }),
	),
	workflowInfo: vi.fn(() => ({
		startTime: new Date(Date.now()),
		runId: "test-run-id",
		unsafe: { isReplaying: false },
	})),
	startChild: vi.fn(),
	ParentClosePolicy: { ABANDON: "ABANDON" },
}));

import { FABRIC_FRAME_TOOL_DEFINITIONS } from "../../../../lib/fabric-frame-tool-definitions";
import {
	installDefaultStubs,
	preloaded,
	runTurn,
	toolMessage,
} from "./advisor-scenario-harness";

const names = ["fabric_get_frame", "fabric_edit_frame_block"];
const offered = FABRIC_FRAME_TOOL_DEFINITIONS.filter((entry) =>
	names.includes(entry.name),
);
beforeEach(() => {
	installDefaultStubs(mocks);
	mocks.stub("preloadFrameToolsActivity").mockResolvedValue(offered);
});
describe("frame tools in the Advisor initial model request", () => {
	it("attaches read and edit without discovery", async () => {
		mocks.stub("executeMcpTool").mockImplementation(async () => {
			expect(mocks.stub("searchAvailableTools")).not.toHaveBeenCalled();
			return {
				success: true,
				output: {
					frameId: "example-frame",
					title: "Example outline",
					blocks: [],
				},
				durationMs: 1,
				cached: false,
			};
		});
		const { seen } = await runTurn(mocks, {
			message: "Add a link to this page",
			input: { actingGrant: "example-grant" },
			projectId: null,
			steps: [
				{
					calls: [
						{
							name: "fabric_get_frame",
							args: { frameId: "example-frame", outline: true },
						},
					],
				},
				{ answer: "Read the outline." },
			],
		});
		expect(seen[0].tools).toEqual(expect.arrayContaining(names));
		expect(mocks.stub("executeMcpTool")).toHaveBeenCalledWith(
			expect.objectContaining({
				toolName: "fabric_get_frame",
				args: { frameId: "example-frame", outline: true },
				mcpConfigId: "fabric-ai-server",
			}),
		);
		expect(toolMessage(seen, 1, "call-1-0")).toContain("Example outline");
		expect(mocks.stub("searchAvailableTools")).not.toHaveBeenCalled();
	});
	it("preserves the old initial tool set with the patch off", async () => {
		mocks.off.add("orch-frame-block-edit-preload-v1");
		const { seen } = await runTurn(mocks, {
			message: "Edit this page",
			input: { actingGrant: "example-grant" },
			projectId: null,
			steps: [{ answer: "Ready." }],
		});
		for (const name of names) {
			expect(seen[0].tools).not.toContain(name);
		}
		expect(mocks.stub("preloadFrameToolsActivity")).not.toHaveBeenCalled();
	});
	it("does not attach tools when the gateway offers none", async () => {
		mocks.stub("preloadFrameToolsActivity").mockResolvedValue([]);
		const { seen } = await runTurn(mocks, {
			message: "Edit this page",
			input: { actingGrant: "example-grant" },
			projectId: null,
			steps: [{ answer: "Ready." }],
		});
		for (const name of names) {
			expect(seen[0].tools).not.toContain(name);
		}
	});
	it("continues the turn without frame tools after a generic preload error", async () => {
		mocks
			.stub("preloadFrameToolsActivity")
			.mockRejectedValue(new Error("Example gateway unavailable"));
		const { seen, result } = await runTurn(mocks, {
			message: "Read this page",
			turn: { cancellationAware: true },
			input: { actingGrant: "example-grant" },
			projectId: null,
			steps: [{ answer: "Ready." }],
		});
		for (const name of names) {
			expect(seen[0].tools).not.toContain(name);
		}
		expect(result.success).toBe(true);
	});
	it("lists eager frame schemas as attached Fabric tools rather than connected-server tools", async () => {
		const { seen } = await runTurn(mocks, {
			message: "Read this page",
			turn: { cancellationAware: true },
			input: { actingGrant: "example-grant" },
			projectId: null,
			enabledMcpConfigIds: ["example-server"],
			preload: preloaded(
				["example_read"],
				"example-server",
				"Example Server",
			),
			steps: [{ answer: "Ready." }],
		});
		const serverLine = seen[0].systemPrompt
			.split("\n")
			.find((line) =>
				line.includes("Pre-loaded tools from Example Server"),
			);
		expect(serverLine).toContain("example_read");
		for (const name of names) {
			expect(serverLine).not.toContain(name);
		}
		expect(seen[0].systemPrompt).toContain(
			"Already-attached Fabric tools: fabric_edit_frame_block, fabric_get_frame",
		);
	});
	it("propagates a turn-stop failure from preload", async () => {
		const stop = new CancelledFailure("Example turn cancelled");
		mocks.stub("preloadFrameToolsActivity").mockRejectedValue(stop);
		await expect(
			runTurn(mocks, {
				message: "Read this page",
				input: { actingGrant: "example-grant" },
				turn: { cancellationAware: true },
				projectId: null,
				steps: [{ answer: "Unreachable" }],
			}),
		).rejects.toBe(stop);
		expect(mocks.stub("runAgentIteration")).not.toHaveBeenCalled();
	});
	it("keeps the prior eager prompt with the frame preload patch disabled", async () => {
		mocks.off.add("orch-frame-block-edit-preload-v1");
		const { seen } = await runTurn(mocks, {
			message: "Read this page",
			input: { actingGrant: "example-grant" },
			projectId: null,
			enabledMcpConfigIds: ["example-server"],
			preload: preloaded(
				["example_read"],
				"example-server",
				"Example Server",
			),
			steps: [{ answer: "Ready." }],
		});
		expect(seen[0].systemPrompt).toContain(
			"Pre-loaded tools from Example Server: example_read.",
		);
		expect(seen[0].systemPrompt).not.toContain(
			"Already-attached Fabric tools:",
		);
	});
});
