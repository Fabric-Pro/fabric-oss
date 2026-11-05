import {
	ownProjectPmConfig,
	projectConnectionDefaults,
	unboundRequiredSources,
} from "@saas/reports/lib/report-template-definition";
import type { DataSourceDefinition } from "@saas/shared/components/DataSourceDefinitionBuilder";
import { describe, expect, it } from "vitest";

describe("ownProjectPmConfig", () => {
	const mine = { id: "config-mine", mcpServerId: "server-fizzy" };
	const project = {
		projectManagementMcpConfigId: "config-someone-else",
		projectManagementMcpServerId: "server-fizzy",
	};

	it("prefers the config the project pinned when it is the person's own", () => {
		const pinned = {
			id: "config-someone-else",
			mcpServerId: "server-fizzy",
		};

		expect(ownProjectPmConfig(project, [mine, pinned])).toBe(pinned);
	});

	it("falls back to the person's own config for the same server", () => {
		expect(ownProjectPmConfig(project, [mine])).toBe(mine);
	});

	it("binds nothing without a config of that server: another person's is never listed", () => {
		expect(
			ownProjectPmConfig(project, [
				{ id: "config-other", mcpServerId: "server-github" },
			]),
		).toBeUndefined();
		expect(
			ownProjectPmConfig(
				{ projectManagementMcpConfigId: "config-someone-else" },
				[mine],
			),
		).toBeUndefined();
	});

	it("skips a config the person has switched off", () => {
		expect(
			ownProjectPmConfig(project, [{ ...mine, enabled: false }]),
		).toBeUndefined();
	});
});

describe("projectConnectionDefaults for a person the project did not pin", () => {
	const isBoardProvider = (provider: string) => provider === "fizzy";
	const ownFizzy = {
		id: "config-mine",
		mcpServerId: "server-fizzy",
		mcpServer: { key: "fizzy", name: "Fizzy" },
	};
	const project = {
		projectManagementMcpConfigId: "config-someone-else",
		projectManagementMcpServerId: "server-fizzy",
		projectManagementContainerId: "board-7",
		projectManagementContainerName: "Example Board",
		projectManagementAdditionalContext: { account_slug: "/123456" },
	};
	const board: DataSourceDefinition[] = [
		{ id: "ds-board", type: "mcp", provider: "fizzy" },
	];

	it("binds their own config with the project's board and account", () => {
		expect(
			projectConnectionDefaults(
				board,
				project,
				[ownFizzy],
				isBoardProvider,
			),
		).toEqual({
			bindings: { "ds-board": ownFizzy },
			context: {
				boardId: "board-7",
				boardName: "Example Board",
				accountSlug: "123456",
			},
		});
	});

	it("binds nothing when they have no connection to that server", () => {
		expect(
			projectConnectionDefaults(board, project, [], isBoardProvider),
		).toEqual({ bindings: {}, context: {} });
	});

	it("answers an Azure DevOps source with the project's container", () => {
		const ownAzure = {
			id: "config-azure",
			mcpServerId: "server-azure",
			mcpServer: { key: "azure-devops", name: "Azure DevOps" },
		};

		expect(
			projectConnectionDefaults(
				[{ id: "ds-work", type: "mcp", provider: "azure_devops" }],
				{
					projectManagementMcpServerId: "server-azure",
					projectManagementContainerName: "Example Project",
					projectManagementAdditionalContext: {
						team: "Example Team",
					},
				},
				[ownAzure],
				isBoardProvider,
			).context,
		).toEqual({ project: "Example Project", team: "Example Team" });
	});

	describe("the project's repository", () => {
		const ownGithub = {
			id: "config-github",
			mcpServer: { key: "github-remote", name: "GitHub" },
		};
		const withRepository = {
			repositoryIntegrations: [
				{
					provider: "GITHUB" as const,
					status: "DISCONNECTED",
					repositoryOwner: "stale-org",
					repositoryName: "stale-repo",
				},
				{
					provider: "GITHUB" as const,
					status: "ACTIVE",
					repositoryOwner: "example-org",
					repositoryName: "example-repo",
				},
			],
		};
		const repositorySource: DataSourceDefinition[] = [
			{ id: "ds-code", type: "mcp", dataType: "repository" },
		];

		it("fills from the first active one, through the person's own connection", () => {
			expect(
				projectConnectionDefaults(
					repositorySource,
					withRepository,
					[ownGithub],
					isBoardProvider,
				),
			).toEqual({
				bindings: { "ds-code": ownGithub },
				context: {
					organization: "example-org",
					repository: "example-repo",
				},
			});
		});

		it("binds nothing for a person without a connection to its host", () => {
			expect(
				projectConnectionDefaults(
					repositorySource,
					withRepository,
					[],
					isBoardProvider,
				),
			).toEqual({ bindings: {}, context: {} });
		});
	});
});

describe("unboundRequiredSources", () => {
	const sources: DataSourceDefinition[] = [
		{ id: "ds-knowledge", type: "fabric", provider: "fabric_project" },
		{ id: "ds-pm", type: "mcp", dataType: "project-management" },
		{ id: "ds-board", type: "mcp", provider: "fizzy" },
		{ id: "ds-code", type: "mcp", provider: "github", required: false },
	];

	it("names the required sources with no connection, and nothing else", () => {
		const missing = unboundRequiredSources(sources, {
			"ds-board": { mcpConfigId: "config-mine" },
		});

		expect(missing).toHaveLength(1);
		expect(
			unboundRequiredSources(sources, {
				"ds-pm": { mcpConfigId: "config-mine" },
				"ds-board": { mcpConfigId: "config-mine" },
			}),
		).toEqual([]);
	});
});
