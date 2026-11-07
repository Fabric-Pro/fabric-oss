import { beforeEach, describe, expect, it, vi } from "vitest";

const m = vi.hoisted(() => ({
	instance: vi.fn(),
	metadata: vi.fn(),
	connect: vi.fn(),
	labels: vi.fn(),
}));
vi.mock("@repo/database", () => ({
	getTemplateInstance: m.instance,
	db: { mCPConfig: { findMany: m.metadata } },
}));
vi.mock("@repo/database/prisma/queries/report-diagnostic-labels", () => ({
	loadReportDiagnosticSources: m.labels,
}));
vi.mock("@repo/mcp", () => ({ getCachedMcpClientForConfig: m.connect }));
vi.mock("../../../../../orpc/procedures", () => {
	const chain = {
		use: () => chain,
		input: () => chain,
		output: () => chain,
		handler: (handler: unknown) => ({ _handler: handler }),
	};
	return {
		tenantProtectedProcedure: chain,
		Permissions: { REPORT_EXECUTE: "report.execute" },
		requireInputOrgPermission: () => () => {},
		resolveOrganizationId: () => "example-org",
	};
});

import { testInstanceConnectionsProcedure } from "../test-connections";

const invoke = () =>
	(
		testInstanceConnectionsProcedure as unknown as {
			_handler: (args: unknown) => Promise<{ diagnostics: unknown[] }>;
		}
	)._handler({
		input: { instanceId: "example-report" },
		context: {
			user: { id: "example-user" },
			session: { activeOrganizationId: "example-org" },
		},
	});
beforeEach(() => {
	vi.clearAllMocks();
	m.instance.mockResolvedValue({
		connections: { mcpConfigs: ["example-issues", "example-docs"] },
		template: { definition: { dataSources: [] } },
	});
	m.metadata.mockResolvedValue([
		{ id: "example-issues", displayName: "https://private.example.com" },
		{ id: "example-docs", displayName: "Bearer example-private-token" },
	]);
	m.labels.mockResolvedValue(
		new Map([
			[
				"example-issues",
				{ displayLabel: "Delivery board", providerType: "github" },
			],
			[
				"example-docs",
				{ displayLabel: "Team documentation", providerType: "notion" },
			],
		]),
	);
	m.connect.mockRejectedValue(
		Object.assign(
			new Error(
				"401 Unauthorized Bearer example-private-token https://private.example.com",
			),
			{ serverName: "https://remote-private.example.com" },
		),
	);
});
describe("report connection preflight public diagnostics", () => {
	it("identifies two failed sources using approved labels while suppressing remote errors, hostnames and IDs", async () => {
		const output = await invoke();
		expect(output.diagnostics).toEqual([
			{
				displayLabel: "Delivery board",
				providerType: "github",
				status: "auth_failed",
				reasonCode: "AUTH_REQUIRED",
				toolCount: 0,
				readOnlyToolCount: 0,
			},
			{
				displayLabel: "Team documentation",
				providerType: "notion",
				status: "auth_failed",
				reasonCode: "AUTH_REQUIRED",
				toolCount: 0,
				readOnlyToolCount: 0,
			},
		]);
		expect(JSON.stringify(output)).not.toMatch(
			/private|https|Bearer|example-issues|example-docs|serverName|configId/,
		);
		expect(m.labels).toHaveBeenCalledWith(
			{ userId: "example-user", organizationId: "example-org" },
			expect.anything(),
			{ includeOwnedConnectionLabels: true },
		);
	});
	it("checks current report authority before probing connections or loading labels", async () => {
		m.instance.mockResolvedValue(null);
		await expect(invoke()).rejects.toMatchObject({ code: "NOT_FOUND" });
		expect(m.connect).not.toHaveBeenCalled();
		expect(m.labels).not.toHaveBeenCalled();
	});
});
