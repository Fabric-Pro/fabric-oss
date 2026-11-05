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

	describe("a source that asks for a data type", () => {
		const genericSource = {
			id: "project-management",
			type: "mcp",
			dataType: "project-management",
		};
		const genericStored = {
			...stored,
			mcpBindings: { "project-management": "example-config-a" },
		};

		it("names no server for a changed binding to fall back on", async () => {
			await validateReportConnections(
				{
					...stored,
					mcpBindings: { "project-management": "example-config-b" },
				},
				OWNER,
				ORG,
				[genericSource],
			);
			expect(mocks.resolveReportMcpConfig).toHaveBeenCalledWith(
				expect.objectContaining({
					storedConfigId: "example-config-b",
					serverKeys: [],
				}),
			);
		});

		it("accepts a non-owner's change to another tool of the data type", async () => {
			mocks.getMcpConfigById.mockResolvedValue({
				id: "example-config-b",
				mcpServer: {
					key: "linear",
					category: "Project Management",
					tags: [],
				},
			});
			const result = await validateReportConnections(
				{
					...genericStored,
					mcpBindings: { "project-management": "example-config-b" },
				},
				OWNER,
				ORG,
				[genericSource],
				genericStored,
				{ sameServerOnly: true },
			);
			expect(result.valid).toBe(true);
		});

		it("refuses a non-owner's change to a tool of another data type", async () => {
			mocks.getMcpConfigById.mockResolvedValue({
				id: "example-config-b",
				mcpServer: {
					key: "gitlab",
					category: "Developer Tools",
					tags: ["git"],
				},
			});
			const result = await validateReportConnections(
				{
					...genericStored,
					mcpBindings: { "project-management": "example-config-b" },
				},
				OWNER,
				ORG,
				[genericSource],
				genericStored,
				{ sameServerOnly: true },
			);
			expect(result.valid).toBe(false);
			expect(result.invalidBindings).toEqual(["example-config-b"]);
		});
	});

	describe("raw mcpConfigs entries", () => {
		const withRawEntry = {
			...stored,
			mcpConfigs: ["example-config-a", "example-config-raw"],
		};

		it("refuses a new entry from a caller who is not the owner", async () => {
			const result = await validateReportConnections(
				withRawEntry,
				OWNER,
				ORG,
				undefined,
				stored,
				{ sameServerOnly: true },
			);

			expect(result.valid).toBe(false);
			expect(result.invalidBindings).toEqual(["example-config-raw"]);
			expect(mocks.getMcpConfigById).not.toHaveBeenCalled();
		});

		it("refuses a new entry that does not resolve for the owner", async () => {
			mocks.getMcpConfigById.mockResolvedValue(null);

			const result = await validateReportConnections(
				withRawEntry,
				OWNER,
				ORG,
				undefined,
				stored,
			);

			expect(result.valid).toBe(false);
			expect(result.invalidBindings).toEqual(["example-config-raw"]);
			expect(mocks.getMcpConfigById).toHaveBeenCalledWith(
				"example-config-raw",
				{ userId: OWNER, organizationId: ORG },
			);
		});

		it("refuses a new entry the owner has disabled", async () => {
			mocks.getMcpConfigById.mockResolvedValue({ enabled: false });

			const result = await validateReportConnections(
				withRawEntry,
				OWNER,
				ORG,
				undefined,
				stored,
			);

			expect(result.valid).toBe(false);
		});

		it("accepts a new entry that resolves for the owner", async () => {
			mocks.getMcpConfigById.mockResolvedValue({ enabled: true });

			const result = await validateReportConnections(
				withRawEntry,
				OWNER,
				ORG,
				undefined,
				stored,
			);

			expect(result).toMatchObject({ valid: true, errors: [] });
		});

		it("keeps an entry the report already stores, even for a caller who is not the owner", async () => {
			const result = await validateReportConnections(
				withRawEntry,
				OWNER,
				ORG,
				undefined,
				withRawEntry,
				{ sameServerOnly: true },
			);

			expect(result.valid).toBe(true);
			expect(mocks.getMcpConfigById).not.toHaveBeenCalled();
		});

		it("checks an entry the submitted bindings hold as a binding, not as a raw entry", async () => {
			const connections = {
				mcpConfigs: ["example-config-b"],
				mcpBindings: { fizzy: "example-config-b" },
			};

			const result = await validateReportConnections(
				connections,
				OWNER,
				ORG,
			);

			expect(result.valid).toBe(true);
			expect(mocks.resolveReportMcpConfig).toHaveBeenCalledTimes(1);
			expect(mocks.getMcpConfigById).not.toHaveBeenCalled();
		});
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
