import { beforeEach, describe, expect, it, vi } from "vitest";

// resolveReportConnections' only real dependency is resolveReportMcpConfig.
// Mock the heavy modules report-agent-loop.ts pulls in so the unit under test
// imports cleanly without a DB / AI / MCP / Temporal runtime.
const { resolveReportMcpConfig } = vi.hoisted(() => ({
	resolveReportMcpConfig: vi.fn(),
}));
vi.mock("@repo/database", () => ({ db: {}, resolveReportMcpConfig }));
vi.mock("@repo/mcp", () => ({ getCachedMcpClientForConfig: vi.fn() }));
vi.mock("@repo/ai", () => ({
	generateText: vi.fn(),
	getCurrentDateContext: vi.fn(() => ""),
	streamText: vi.fn(),
	tool: vi.fn(),
}));
vi.mock("@temporalio/activity", () => ({ heartbeat: vi.fn() }));

import { resolveReportConnections } from "../src/activities/template-instance/report-agent-loop";

const FIZZY_DS = [{ id: "task-board", provider: "fizzy", type: "mcp" }];

describe("resolveReportConnections (self-heal)", () => {
	beforeEach(() => resolveReportMcpConfig.mockReset());

	it("prefers the stored config when it resolves — no heal, no regression", async () => {
		resolveReportMcpConfig.mockResolvedValue({
			configId: "cfg-live",
			healed: false,
			enabled: true,
		});
		const r = await resolveReportConnections({
			connections: {
				mcpConfigs: ["cfg-live"],
				mcpBindings: { "task-board": "cfg-live" },
			},
			dataSources: FIZZY_DS,
			userId: "u1",
		});
		expect(r.mcpConfigs).toEqual(["cfg-live"]);
		// effective id written under both the id and the provider key
		expect(r.mcpBindings).toMatchObject({
			"task-board": "cfg-live",
			fizzy: "cfg-live",
		});
		expect(r.healed).toEqual([]);
		expect(r.unresolved).toEqual([]);
	});

	it("self-heals Avery's exact shape: dual dangling binding → the fallback config (deduped)", async () => {
		resolveReportMcpConfig.mockResolvedValue({
			configId: "cfg-current",
			healed: true,
			enabled: true,
		});
		const r = await resolveReportConnections({
			connections: {
				mcpConfigs: ["cfg-deleted", "cfg-deleted"],
				mcpBindings: {
					fizzy: "cfg-deleted",
					"task-board": "cfg-deleted",
				},
			},
			dataSources: FIZZY_DS,
			userId: "u1",
		});
		expect(r.mcpConfigs).toEqual(["cfg-current"]); // deduped to the one healed config
		expect(r.mcpBindings["task-board"]).toBe("cfg-current");
		expect(r.mcpBindings.fizzy).toBe("cfg-current");
		expect(r.healed).toHaveLength(1);
		expect(r.healed[0]).toMatchObject({
			from: "cfg-deleted",
			to: "cfg-current",
		});
		// the stored id is passed through; the server keys include the provider
		expect(resolveReportMcpConfig).toHaveBeenCalledWith(
			expect.objectContaining({
				storedConfigId: "cfg-deleted",
				serverKeys: expect.arrayContaining(["fizzy", "task-board"]),
				userId: "u1",
			}),
		);
	});

	it("marks a source unresolved when nothing resolves (no fallback) and keeps original configs", async () => {
		resolveReportMcpConfig.mockResolvedValue(null);
		const r = await resolveReportConnections({
			connections: {
				mcpConfigs: ["cfg-deleted"],
				mcpBindings: { "task-board": "cfg-deleted" },
			},
			dataSources: FIZZY_DS,
			userId: "u1",
		});
		expect(r.unresolved).toContain("task-board");
		expect(r.healed).toEqual([]);
		// behaviour unchanged for the (now genuinely unconfigured) run
		expect(r.mcpConfigs).toEqual(["cfg-deleted"]);
	});

	it("treats a disabled stored config as unresolved (does not run it)", async () => {
		resolveReportMcpConfig.mockResolvedValue({
			configId: "cfg-x",
			healed: false,
			enabled: false,
		});
		const r = await resolveReportConnections({
			connections: {
				mcpConfigs: ["cfg-x"],
				mcpBindings: { "task-board": "cfg-x" },
			},
			dataSources: FIZZY_DS,
			userId: "u1",
		});
		expect(r.unresolved).toContain("task-board");
	});

	it("skips non-MCP data sources and preserves legacy mcpConfigs when no dataSources", async () => {
		const r = await resolveReportConnections({
			connections: { mcpConfigs: ["legacy-cfg"], mcpBindings: {} },
			dataSources: [{ id: "x", provider: "y", type: "integration" }],
			userId: "u1",
		});
		expect(resolveReportMcpConfig).not.toHaveBeenCalled();
		expect(r.mcpConfigs).toEqual(["legacy-cfg"]);
	});

	it("dedupes multiple data sources that resolve to the same config", async () => {
		resolveReportMcpConfig.mockResolvedValue({
			configId: "cfg-x",
			healed: false,
			enabled: true,
		});
		const r = await resolveReportConnections({
			connections: {
				mcpConfigs: ["a", "b"],
				mcpBindings: { ds1: "a", ds2: "b" },
			},
			dataSources: [
				{ id: "ds1", provider: "p", type: "mcp" },
				{ id: "ds2", provider: "p", type: "mcp" },
			],
			userId: "u1",
		});
		expect(r.mcpConfigs).toEqual(["cfg-x"]);
	});
});
