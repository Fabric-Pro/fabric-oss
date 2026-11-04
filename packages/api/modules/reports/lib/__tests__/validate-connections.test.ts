import { beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
	resolveReportMcpConfig: vi.fn(),
	getWorkflowIntegrationById: vi.fn(),
	getMcpConfigById: vi.fn(),
}));

vi.mock("@repo/database", () => ({
	resolveReportMcpConfig: mocks.resolveReportMcpConfig,
	getMcpConfigById: mocks.getMcpConfigById,
	getWorkflowIntegrationById: mocks.getWorkflowIntegrationById,
}));

import { validateReportConnections } from "../validate-connections";

const OWNER = "example-owner";
const ORG = "example-org";

const stored = {
	mcpConfigs: ["example-config-a"],
	mcpBindings: { fizzy: "example-config-a" },
	integrationBindings: { github: "example-integration-a" },
};

beforeEach(() => {
	vi.clearAllMocks();
	mocks.resolveReportMcpConfig.mockResolvedValue({
		configId: "example-config-b",
		healed: false,
		enabled: true,
	});
	mocks.getWorkflowIntegrationById.mockResolvedValue({ isActive: true });
});

describe("validateReportConnections", () => {
	it("does not re-check bindings that match the stored connections", async () => {
		const result = await validateReportConnections(
			stored,
			OWNER,
			ORG,
			undefined,
			stored,
		);
		expect(result.valid).toBe(true);
		expect(mocks.resolveReportMcpConfig).not.toHaveBeenCalled();
		expect(mocks.getWorkflowIntegrationById).not.toHaveBeenCalled();
	});

	it("checks a changed binding against the given owner", async () => {
		await validateReportConnections(
			{
				...stored,
				mcpBindings: { fizzy: "example-config-b" },
			},
			OWNER,
			ORG,
			undefined,
			stored,
		);
		expect(mocks.resolveReportMcpConfig).toHaveBeenCalledTimes(1);
		expect(mocks.resolveReportMcpConfig).toHaveBeenCalledWith(
			expect.objectContaining({
				storedConfigId: "example-config-b",
				userId: OWNER,
			}),
		);
		expect(mocks.getWorkflowIntegrationById).not.toHaveBeenCalled();
	});

	it("rejects a changed binding the owner cannot resolve", async () => {
		mocks.resolveReportMcpConfig.mockResolvedValue(null);
		const result = await validateReportConnections(
			{
				...stored,
				mcpBindings: { fizzy: "example-foreign-config" },
			},
			OWNER,
			ORG,
			undefined,
			stored,
		);
		expect(result.valid).toBe(false);
		expect(result.invalidBindings).toEqual(["example-foreign-config"]);
	});

	it("accepts a binding to a tool outside the data source's provider", async () => {
		mocks.resolveReportMcpConfig.mockResolvedValue({
			configId: "example-other-tool",
			healed: false,
			enabled: true,
		});
		const result = await validateReportConnections(
			{ mcpConfigs: [], mcpBindings: { fizzy: "example-other-tool" } },
			OWNER,
			ORG,
			[{ id: "fizzy", provider: "fizzy" }],
		);
		expect(result.valid).toBe(true);
		expect(mocks.resolveReportMcpConfig).toHaveBeenCalledWith(
			expect.objectContaining({ storedConfigId: "example-other-tool" }),
		);
	});

	it("refuses a non-owner's change to a tool outside the data source's provider", async () => {
		mocks.resolveReportMcpConfig.mockResolvedValue({
			configId: "example-other-tool",
			healed: false,
			enabled: true,
		});
		mocks.getMcpConfigById.mockResolvedValue({
			id: "example-other-tool",
			mcpServer: { key: "github" },
		});
		const result = await validateReportConnections(
			{ ...stored, mcpBindings: { fizzy: "example-other-tool" } },
			OWNER,
			ORG,
			[{ id: "fizzy", provider: "fizzy" }],
			stored,
			{ sameServerOnly: true },
		);
		expect(result.valid).toBe(false);
		expect(result.invalidBindings).toEqual(["example-other-tool"]);
		expect(mocks.getMcpConfigById).toHaveBeenCalledWith(
			"example-other-tool",
			{ userId: OWNER, organizationId: ORG },
		);
	});

	it("accepts a non-owner's change to another connection of the same provider", async () => {
		mocks.getMcpConfigById.mockResolvedValue({
			id: "example-config-b",
			mcpServer: { key: "Fizzy" },
		});
		const result = await validateReportConnections(
			{ ...stored, mcpBindings: { "task-board": "example-config-b" } },
			OWNER,
			ORG,
			[{ id: "task-board", provider: "fizzy" }],
			{ ...stored, mcpBindings: { "task-board": "example-config-a" } },
			{ sameServerOnly: true },
		);
		expect(result.valid).toBe(true);
	});

	it("checks every binding when there are no stored connections", async () => {
		await validateReportConnections(stored, OWNER, ORG);
		expect(mocks.resolveReportMcpConfig).toHaveBeenCalledTimes(1);
		expect(mocks.getWorkflowIntegrationById).toHaveBeenCalledWith(
			"example-integration-a",
			OWNER,
			ORG,
		);
	});
});
