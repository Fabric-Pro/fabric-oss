import { beforeEach, describe, expect, it, vi } from "vitest";

const m = vi.hoisted(() => ({ find: vi.fn(), canRead: vi.fn() }));
vi.mock("../prisma/client", () => ({
	db: { mCPConfig: { findMany: m.find } },
}));

vi.mock("../prisma/queries/organization-permissions", () => ({
	canReadOrganizationMcpConfigs: m.canRead,
}));

import { projectReportDiagnostics } from "../prisma/queries/lib/report-public-diagnostics";
import { loadReportDiagnosticSources } from "../prisma/queries/report-diagnostic-labels";

const actor = { userId: "example-reader", organizationId: "example-org" };
const instance = {
	connections: {
		mcpConfigs: ["example-issues-config", "example-docs-config"],
		mcpBindings: {
			issues: "example-issues-config",
			docs: "example-docs-config",
		},
	},
	template: {
		definition: {
			dataSources: [
				{ id: "issues", provider: "github" },
				{ id: "docs", provider: "notion" },
			],
		},
		connections: {
			mcpServers: [
				{ key: "github", name: "Delivery board" },
				{ key: "notion", name: "Team documentation" },
			],
		},
	},
};
beforeEach(() => {
	vi.clearAllMocks();
	m.find.mockResolvedValue([]);
	m.canRead.mockResolvedValue(true);
});
describe("authorized report diagnostic source identity", () => {
	it("labels two provider-less MCP failures from current shared report requirements without trusting remote names", async () => {
		const sources = await loadReportDiagnosticSources(actor, instance);
		const result = projectReportDiagnostics(
			[
				{
					configId: "example-issues-config",
					serverName: "https://private.example.com",
					outcome: "auth_failed",
					toolCount: 0,
					readOnlyToolCount: 0,
					errorMessage: "Bearer example-secret",
				},
				{
					configId: "example-docs-config",
					serverName: "https://private.example.com",
					outcome: "unreachable",
					toolCount: 0,
					readOnlyToolCount: 0,
				},
			],
			sources,
		);
		expect(result?.map((row) => row.displayLabel)).toEqual([
			"Delivery board",
			"Team documentation",
		]);
		expect(result?.map((row) => row.providerType)).toEqual([
			"github",
			"notion",
		]);
		expect(JSON.stringify(result)).not.toMatch(
			/private|Bearer|secret|configId|example-issues/,
		);
		expect(m.find).not.toHaveBeenCalled();
		expect(m.canRead).not.toHaveBeenCalled();
	});
	it("uses only the current actor's own first-party names when the report has no shared source names", async () => {
		m.find.mockResolvedValue([
			{
				id: "example-issues-config",
				displayName: "My delivery board",
				mcpServer: { name: "GitHub", key: "github" },
			},
			{
				id: "example-docs-config",
				displayName: "Team docs",
				mcpServer: { name: "Notion", key: "notion" },
			},
		]);
		const own = await loadReportDiagnosticSources(
			actor,
			{
				connections: instance.connections,
			},
			{ includeOwnedConnectionLabels: true },
		);
		expect(own.get("example-issues-config")?.displayLabel).toBe(
			"My delivery board",
		);
		m.find.mockResolvedValue([]);
		const teammate = await loadReportDiagnosticSources(
			{ ...actor, userId: "example-teammate" },
			{ connections: instance.connections },
			{ includeOwnedConnectionLabels: true },
		);
		expect(
			[...teammate.values()].map((source) => source.displayLabel),
		).toEqual(["Source 1", "Source 2"]);
		expect(m.find.mock.lastCall?.[0].where.userId).toBe("example-teammate");
	});
	it("rejects host, credential-like and opaque config labels and gives duplicate source names distinct labels", async () => {
		const unsafe = {
			...instance,
			template: {
				...instance.template,
				connections: {
					mcpServers: [
						{ key: "github", name: "https://private.example.com" },
						{ key: "notion", name: "Bearer example-secret" },
					],
				},
			},
		};
		const hidden = await loadReportDiagnosticSources(actor, unsafe);
		expect(
			[...hidden.values()].map((source) => source.displayLabel),
		).toEqual(["Source 1", "Source 2"]);
		const duplicate = {
			...instance,
			template: {
				...instance.template,
				connections: {
					mcpServers: [
						{ key: "github", name: "Team source" },
						{ key: "notion", name: "Team source" },
					],
				},
			},
		};
		expect(
			[...(await loadReportDiagnosticSources(actor, duplicate))].map(
				([, source]) => source.displayLabel,
			),
		).toEqual(["Team source (1)", "Team source (2)"]);
	});
});

it("denies private connection metadata by default and after current MCP read authority is revoked", async () => {
	m.find.mockResolvedValue([
		{
			id: "example-issues-config",
			displayName: "Private delivery system",
			mcpServer: { key: "github", name: "Private server" },
		},
	]);
	const publicSources = await loadReportDiagnosticSources(actor, {
		connections: instance.connections,
	});
	expect(
		[...publicSources.values()].map((source) => source.displayLabel),
	).toEqual(["Source 1", "Source 2"]);
	expect(m.find).not.toHaveBeenCalled();
	m.canRead.mockResolvedValue(false);
	const revoked = await loadReportDiagnosticSources(
		actor,
		{ connections: instance.connections },
		{ includeOwnedConnectionLabels: true },
	);
	expect([...revoked.values()].map((source) => source.displayLabel)).toEqual([
		"Source 1",
		"Source 2",
	]);
	expect(m.find).not.toHaveBeenCalled();
	expect(m.canRead).toHaveBeenCalledWith(actor.userId, actor.organizationId);
});
