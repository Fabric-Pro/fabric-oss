import { CancelledFailure } from "@temporalio/common";
import { beforeEach, describe, expect, it, vi } from "vitest";

const m = vi.hoisted(() => ({ patch: vi.fn(() => true), preload: vi.fn() }));
vi.mock("@temporalio/workflow", () => ({
	log: { info: vi.fn(), warn: vi.fn() },
	patched: m.patch,
	proxyActivities: () => ({ preloadFrameToolsActivity: m.preload }),
}));

import {
	preloadFrameToolsForTurn,
	scrubArgsForRetention,
} from "../src/workflows/orchestrator/phases/iterative-execution";

const input = {
	userId: "example-user",
	organizationId: "example-org",
	actingGrant: "example-grant",
	executionId: "example-execution",
};
const offered = ["fabric_get_frame", "fabric_edit_frame_block"].map((name) => ({
	name,
	description: name,
	inputSchema: { type: "object" },
}));
beforeEach(() => {
	vi.clearAllMocks();
	m.patch.mockReturnValue(true);
	m.preload.mockResolvedValue(offered);
});
describe("frame tools at turn start", () => {
	it("registers read and edit schemas without tool search with the patch enabled", async () => {
		const tools = {};
		const configs = {};
		await preloadFrameToolsForTurn(input, tools, configs);
		expect(Object.keys(tools)).toEqual(offered.map((entry) => entry.name));
		expect(configs).toEqual({
			fabric_get_frame: "fabric-ai-server",
			fabric_edit_frame_block: "fabric-ai-server",
		});
	});
	it("keeps the old path when the patch is disabled", async () => {
		m.patch.mockReturnValue(false);
		const tools = {};
		await preloadFrameToolsForTurn(input, tools, {});
		expect(tools).toEqual({});
		expect(m.preload).not.toHaveBeenCalled();
	});
	it("registers nothing when the gateway is unavailable", async () => {
		m.preload.mockResolvedValue([]);
		const tools = {};
		await preloadFrameToolsForTurn(input, tools, {});
		expect(tools).toEqual({});
	});
	it("registers nothing without acting context", async () => {
		const tools = {};
		await preloadFrameToolsForTurn(
			{ ...input, actingGrant: undefined },
			tools,
			{},
		);
		expect(tools).toEqual({});
		expect(m.preload).not.toHaveBeenCalled();
	});
	it("honors an explicit enabled tool list", async () => {
		const tools = {};
		await preloadFrameToolsForTurn(
			{ ...input, enabledFabricToolIds: ["fabric_get_frame"] },
			tools,
			{},
		);
		expect(Object.keys(tools)).toEqual(["fabric_get_frame"]);
	});
	it("continues without registration after a generic preload error", async () => {
		m.preload.mockRejectedValue(new Error("Example gateway unavailable"));
		const tools = {};
		const configs = {};
		await expect(
			preloadFrameToolsForTurn(input, tools, configs, {
				cancellationAware: true,
			}),
		).resolves.toEqual([]);
		expect(tools).toEqual({});
		expect(configs).toEqual({});
	});
	it("rethrows a turn cancellation from preload", async () => {
		const stop = new CancelledFailure("Example turn stopped");
		m.preload.mockRejectedValue(stop);
		const tools = {};
		await expect(
			preloadFrameToolsForTurn(
				input,
				tools,
				{},
				{ cancellationAware: true },
			),
		).rejects.toBe(stop);
		expect(tools).toEqual({});
	});

	it("scrubs newText over 2000 chars without changing dispatched arguments", () => {
		const args = {
			edits: [
				{ oldText: "old", newText: "x".repeat(2001) },
				{ oldText: "old", newText: "x".repeat(2000) },
			],
		};
		const scrubbed = scrubArgsForRetention("fabric_edit_frame_block", args);
		expect(scrubbed.edits).toEqual([
			{
				oldText: "old",
				newText: "[content omitted: 2001 chars - rendered to frame]",
			},
			args.edits[1],
		]);
		expect(args.edits[0].newText).toHaveLength(2001);
	});
});
