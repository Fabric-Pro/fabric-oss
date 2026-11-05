import { beforeEach, describe, expect, it, vi } from "vitest";

const m = vi.hoisted(() => ({
	findConfigs: vi.fn(),
	resolveConfig: vi.fn(),
	connect: vi.fn(),
	integration: vi.fn(),
}));

vi.mock("@repo/database", () => ({
	db: { mCPConfig: { findMany: m.findConfigs } },
	getWorkflowIntegrationById: m.integration,
	resolveReportMcpConfig: m.resolveConfig,
}));
vi.mock("@repo/mcp", () => ({
	getCachedMcpClientForConfig: m.connect,
}));

import {
	probeReportConnections,
	reportSourceConnectionFailure,
} from "../report-connection-test";

const tenant = { userId: "example-owner", organizationId: "example-org" };

function connectedClient() {
	return {
		serverName: "Example board server",
		client: { tools: async () => ({ fizzy_list_cards: {} }) },
	};
}

function report({
	required = true,
	bindings = { "task-board": "config-board" },
	mcpConfigs = ["config-board"],
}: {
	required?: boolean;
	bindings?: Record<string, string>;
	mcpConfigs?: string[];
} = {}) {
	return {
		connections: { mcpConfigs, mcpBindings: bindings },
		template: {
			definition: {
				dataSources: [
					{
						id: "task-board",
						type: "mcp",
						provider: "fizzy",
						...(required ? {} : { required: false }),
					},
					{ id: "notes", type: "user-input" },
				],
			},
			connections: {
				mcpServers: [{ key: "fizzy", name: "Example board", required }],
			},
		},
	};
}

beforeEach(() => {
	vi.clearAllMocks();
	m.findConfigs.mockResolvedValue([]);
	m.resolveConfig.mockImplementation(
		async ({ storedConfigId }: { storedConfigId: string }) => ({
			configId: storedConfigId,
			healed: false,
			enabled: true,
		}),
	);
	m.connect.mockResolvedValue(connectedClient());
});

describe("reportSourceConnectionFailure", () => {
	it("passes when every required source connects", async () => {
		await expect(
			reportSourceConnectionFailure(report(), tenant),
		).resolves.toBeNull();
		expect(m.connect).toHaveBeenCalledWith({
			configId: "config-board",
			userId: "example-owner",
			organizationId: "example-org",
			access: "read",
		});
	});

	it("names a required source whose sign-in was refused", async () => {
		m.connect.mockRejectedValue(
			Object.assign(new Error("401 unauthorized"), {
				isAuthError: true,
			}),
		);

		const failure = await reportSourceConnectionFailure(report(), tenant);

		expect(failure).toContain(
			"Example board: its sign-in was refused or has expired",
		);
		expect(failure).toContain("Fix the connection on the report page");
	});

	describe("a required integration", () => {
		const withIntegration = (required = true) => ({
			connections: {
				integrationBindings: { "example-chat": "integration-1" },
			},
			template: {
				definition: {},
				connections: {
					integrations: [
						{ key: "example-chat", name: "Example chat", required },
					],
				},
			},
		});

		it("refuses a run when someone switched it off, with no network call", async () => {
			m.integration.mockResolvedValue({ isActive: false });

			await expect(
				reportSourceConnectionFailure(withIntegration(), tenant),
			).resolves.toContain("Example chat: it is switched off");
			expect(m.integration).toHaveBeenCalledWith(
				"integration-1",
				"example-owner",
				"example-org",
			);
			expect(m.connect).not.toHaveBeenCalled();
		});

		it("passes while it stays on", async () => {
			m.integration.mockResolvedValue({ isActive: true });

			await expect(
				reportSourceConnectionFailure(withIntegration(), tenant),
			).resolves.toBeNull();
		});

		it("never blocks on an optional one", async () => {
			await expect(
				reportSourceConnectionFailure(withIntegration(false), tenant),
			).resolves.toBeNull();
			expect(m.integration).not.toHaveBeenCalled();
		});
	});

	it("bounds the live test, so a server that never answers refuses the run instead of holding it", async () => {
		vi.useFakeTimers();
		try {
			m.connect.mockReturnValue(new Promise(() => {}));

			const failure = reportSourceConnectionFailure(report(), tenant);
			await vi.advanceTimersByTimeAsync(31_000);

			await expect(failure).resolves.toContain("Example board");
		} finally {
			vi.useRealTimers();
		}
	});

	it("bounds the listing of a server's tools the same way", async () => {
		vi.useFakeTimers();
		try {
			m.connect.mockResolvedValue({
				serverName: "Example board server",
				client: { tools: () => new Promise(() => {}) },
			});

			const failure = reportSourceConnectionFailure(report(), tenant);
			await vi.advanceTimersByTimeAsync(31_000);

			await expect(failure).resolves.toContain("Example board");
		} finally {
			vi.useRealTimers();
		}
	});

	it("refuses a required source whose server offers no read tools", async () => {
		m.connect.mockResolvedValue({
			serverName: "Example board server",
			client: { tools: async () => ({ fizzy_create_card: {} }) },
		});

		await expect(
			reportSourceConnectionFailure(report(), tenant),
		).resolves.toContain(
			"Example board: its server offers no tools the report can read with",
		);
	});

	it("tests the connection the run resolves the binding to", async () => {
		m.resolveConfig.mockResolvedValue({
			configId: "config-current",
			healed: true,
			enabled: true,
		});

		await reportSourceConnectionFailure(report(), tenant);

		expect(m.resolveConfig).toHaveBeenCalledWith({
			storedConfigId: "config-board",
			serverKeys: ["fizzy", "task-board"],
			userId: "example-owner",
			organizationId: "example-org",
		});
		expect(m.connect).toHaveBeenCalledWith(
			expect.objectContaining({ configId: "config-current" }),
		);
	});

	it("never blocks on an optional source, which a run skips when it fails", async () => {
		m.connect.mockRejectedValue(new Error("ECONNREFUSED"));

		await expect(
			reportSourceConnectionFailure(report({ required: false }), tenant),
		).resolves.toBeNull();
		expect(m.connect).not.toHaveBeenCalled();
	});

	it("leaves an unbound required source to the readiness check", async () => {
		await expect(
			reportSourceConnectionFailure(
				report({ bindings: {}, mcpConfigs: [] }),
				tenant,
			),
		).resolves.toBeNull();
		expect(m.connect).not.toHaveBeenCalled();
	});

	it("tests an older report's raw connections when no data source is keyed", async () => {
		m.connect.mockRejectedValue(new Error("ECONNREFUSED"));

		const failure = await reportSourceConnectionFailure(
			report({ bindings: {}, mcpConfigs: ["config-legacy"] }),
			tenant,
		);

		expect(m.connect).toHaveBeenCalledWith(
			expect.objectContaining({ configId: "config-legacy" }),
		);
		expect(failure).toContain("config-legacy");
	});

	describe("a source that asks for a data type", () => {
		const genericReport = {
			connections: {
				mcpConfigs: ["config-tool"],
				mcpBindings: { "project-management": "config-tool" },
			},
			template: {
				definition: {
					dataSources: [
						{
							id: "project-management",
							type: "mcp",
							dataType: "project-management",
							required: true,
						},
					],
				},
				connections: {
					mcpServers: [
						{
							key: "project-management",
							name: "Project management tool",
							required: true,
						},
					],
				},
			},
		};

		it("tests the tool bound under the source's id, and names no server for it to fall back on", async () => {
			m.connect.mockResolvedValue(connectedClient());

			await expect(
				reportSourceConnectionFailure(genericReport, tenant),
			).resolves.toBeNull();

			expect(m.resolveConfig).toHaveBeenCalledWith({
				storedConfigId: "config-tool",
				serverKeys: [],
				userId: "example-owner",
				organizationId: "example-org",
			});
			expect(m.connect).toHaveBeenCalledWith(
				expect.objectContaining({ configId: "config-tool" }),
			);
		});

		it("counts read tools a camelCase tool offers, under no named provider", async () => {
			m.connect.mockResolvedValue({
				serverName: "Example tracker",
				client: { tools: async () => ({ getIssue: {} }) },
			});

			await expect(
				reportSourceConnectionFailure(genericReport, tenant),
			).resolves.toBeNull();
		});

		it("refuses with the source's name when its tool does not connect", async () => {
			m.connect.mockRejectedValue(new Error("401 Unauthorized"));

			await expect(
				reportSourceConnectionFailure(genericReport, tenant),
			).resolves.toContain("Project management tool");
		});
	});

	it("tests nothing for a report whose optional sources are all unbound", async () => {
		await expect(
			reportSourceConnectionFailure(
				{
					connections: {},
					template: {
						definition: {
							dataSources: [
								{
									id: "project-management",
									type: "mcp",
									dataType: "project-management",
									required: false,
									useAgentic: true,
								},
							],
						},
						connections: {},
					},
				},
				tenant,
			),
		).resolves.toBeNull();
		expect(m.connect).not.toHaveBeenCalled();
	});

	it("does nothing for a report without MCP sources", async () => {
		await expect(
			reportSourceConnectionFailure(
				{
					connections: {},
					template: {
						definition: { dataSources: [{ type: "fabric" }] },
						connections: {},
					},
				},
				tenant,
			),
		).resolves.toBeNull();
		expect(m.connect).not.toHaveBeenCalled();
		expect(m.findConfigs).not.toHaveBeenCalled();
	});
});

describe("probeReportConnections", () => {
	it("reads display names in the caller's personal tenant only", async () => {
		await probeReportConnections(
			["config-board"],
			{},
			{
				userId: "example-user",
				organizationId: null,
			},
		);

		expect(m.findConfigs).toHaveBeenCalledWith(
			expect.objectContaining({
				where: {
					id: { in: ["config-board"] },
					userId: "example-user",
					organizationId: null,
				},
			}),
		);
	});
});
