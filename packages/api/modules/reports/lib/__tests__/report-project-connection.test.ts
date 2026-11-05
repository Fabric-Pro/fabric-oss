import { beforeEach, describe, expect, it, vi } from "vitest";

const m = vi.hoisted(() => ({
	findProject: vi.fn(),
	availableConfigs: vi.fn(),
	resolveConfig: vi.fn(),
	resolvePmConfig: vi.fn(),
	findConfigs: vi.fn(),
	boardListed: vi.fn(),
	OriginMismatch: class extends Error {},
}));

vi.mock("@repo/database", () => ({
	db: {
		project: { findUnique: m.findProject },
		mCPConfig: { findMany: m.findConfigs },
	},
	getAvailableMcpConfigsForKeys: m.availableConfigs,
	resolveReportMcpConfig: m.resolveConfig,
}));
vi.mock("@repo/integrations/gitlab", () => ({
	GitLabPmOriginMismatchError: m.OriginMismatch,
	resolveProjectPMConfigForUser: m.resolvePmConfig,
}));
vi.mock("../report-board-access", () => ({
	boardIsListedForConfig: m.boardListed,
}));

import {
	missingReportSetup,
	projectReportConnections,
	resolveProjectReportBindings,
} from "../report-project-connection";
import { validateReportConnections } from "../validate-connections";

const boardDefinition = {
	dataSources: [{ id: "task-board", type: "mcp", provider: "fizzy" }],
};
const args = {
	projectId: "project-1",
	definition: boardDefinition,
	userId: "example-user",
	organizationId: "example-org",
};

function configGroup(key: string, configId: string) {
	return { key, configs: [{ configId }] };
}

function ownConfig(id: string, key = "fizzy") {
	return {
		id,
		enabled: true,
		mcpServer: { key, category: "Project Management", tags: [] },
	};
}

beforeEach(() => {
	vi.clearAllMocks();
	m.findProject.mockResolvedValue({
		projectManagementMcpConfigId: "config-project",
		projectManagementContainerId: "board-1",
		projectManagementContainerName: "Example board",
		projectManagementAdditionalContext: { account_slug: "/000000" },
	});
	m.availableConfigs.mockResolvedValue([
		configGroup("fizzy", "config-project"),
	]);
	m.resolvePmConfig.mockResolvedValue(ownConfig("config-project"));
	m.findConfigs.mockResolvedValue([]);
});

describe("projectReportConnections", () => {
	it("binds the caller's own project connection in the shape the dialog stores", async () => {
		const board = {
			resourceId: "board-1",
			resourceName: "Example board",
			resourceType: "board",
		};

		await expect(projectReportConnections(args)).resolves.toEqual({
			mcpConfigs: ["config-project"],
			mcpBindings: {
				"task-board": "config-project",
				fizzy: "config-project",
			},
			resourceBindings: { "task-board": board, fizzy: board },
			context: {
				boardId: "board-1",
				boardName: "Example board",
				accountSlug: "000000",
			},
		});
	});

	it("produces connections the report validator accepts", async () => {
		m.resolveConfig.mockResolvedValue({
			configId: "config-project",
			healed: false,
			enabled: true,
		});

		const connections = await projectReportConnections(args);

		await expect(
			validateReportConnections(
				connections,
				"example-user",
				"example-org",
				boardDefinition.dataSources,
			),
		).resolves.toMatchObject({ valid: true, errors: [] });
	});

	it("asks with the caller's tenancy and every key that names the server", async () => {
		await projectReportConnections({
			...args,
			definition: {
				dataSources: [
					{
						id: "task-board",
						key: "tasks",
						type: "mcp",
						provider: "fizzy",
						config: { mcpServerKey: "fizzy-custom" },
					},
				],
			},
		});

		expect(m.availableConfigs).toHaveBeenCalledWith({
			keys: ["fizzy", "tasks", "task-board", "fizzy-custom"],
			userId: "example-user",
			organizationId: "example-org",
		});
	});

	it("never binds a config that is not among the caller's own matches", async () => {
		m.availableConfigs.mockResolvedValue([
			configGroup("fizzy", "config-mine"),
		]);

		await expect(projectReportConnections(args)).resolves.toBeNull();
	});

	it("binds only the data sources the connection serves", async () => {
		m.availableConfigs.mockResolvedValue([
			configGroup("fizzy", "config-project"),
			{ key: "github", configs: [] },
		]);

		const result = await projectReportConnections({
			...args,
			definition: {
				dataSources: [
					{ id: "task-board", type: "mcp", provider: "fizzy" },
					{ id: "code", type: "mcp", provider: "github" },
				],
			},
		});

		expect(result?.mcpBindings).toEqual({
			"task-board": "config-project",
			fizzy: "config-project",
		});
	});

	it("binds another tool's connection without a board", async () => {
		m.availableConfigs.mockResolvedValue([
			configGroup("github", "config-project"),
		]);

		await expect(
			projectReportConnections({
				...args,
				definition: {
					dataSources: [
						{ id: "code", type: "mcp", provider: "github" },
					],
				},
			}),
		).resolves.toEqual({
			mcpConfigs: ["config-project"],
			mcpBindings: { code: "config-project", github: "config-project" },
			resourceBindings: {},
			context: {},
		});
	});

	it("binds the connection without a board when the project has picked none", async () => {
		m.findProject.mockResolvedValue({
			projectManagementMcpConfigId: "config-project",
			projectManagementContainerId: null,
			projectManagementContainerName: null,
			projectManagementAdditionalContext: null,
		});

		const result = await projectReportConnections(args);

		expect(result?.mcpConfigs).toEqual(["config-project"]);
		expect(result?.resourceBindings).toEqual({});
		expect(result?.context).toEqual({});
	});

	it("falls back to the board id when the project holds no board name", async () => {
		m.findProject.mockResolvedValue({
			projectManagementMcpConfigId: "config-project",
			projectManagementContainerId: "board-1",
			projectManagementContainerName: null,
			projectManagementAdditionalContext: { slug: "example-account" },
		});

		const result = await projectReportConnections(args);

		expect(result?.context).toEqual({
			boardId: "board-1",
			boardName: "board-1",
			accountSlug: "example-account",
		});
	});

	it("reads nothing for a connector-free template", async () => {
		await expect(
			projectReportConnections({
				...args,
				definition: {
					dataSources: [
						{
							id: "knowledge",
							type: "fabric",
							provider: "fabric_project",
						},
					],
				},
			}),
		).resolves.toBeNull();
		expect(m.findProject).not.toHaveBeenCalled();
	});

	it("stays unconnected when the project has no connection", async () => {
		m.findProject.mockResolvedValue({
			projectManagementMcpConfigId: null,
		});

		await expect(projectReportConnections(args)).resolves.toBeNull();
		expect(m.availableConfigs).not.toHaveBeenCalled();
	});

	it("stays unconnected when the project is gone", async () => {
		m.findProject.mockResolvedValue(null);

		await expect(projectReportConnections(args)).resolves.toBeNull();
	});

	describe("a source that asks for a data type", () => {
		const genericArgs = (dataType: string) => ({
			...args,
			definition: {
				dataSources: [{ id: dataType, type: "mcp", dataType }],
			},
		});
		const fizzyServer = {
			key: "fizzy",
			category: "Project Management",
			tags: ["tasks"],
		};

		beforeEach(() => {
			m.availableConfigs.mockResolvedValue([]);
			m.resolvePmConfig.mockResolvedValue({
				id: "config-project",
				enabled: true,
				mcpServer: fizzyServer,
			});
		});

		it("binds the project's tool under the source's id, with its board", async () => {
			const board = {
				resourceId: "board-1",
				resourceName: "Example board",
				resourceType: "board",
			};

			await expect(
				projectReportConnections(genericArgs("project-management")),
			).resolves.toEqual({
				mcpConfigs: ["config-project"],
				mcpBindings: { "project-management": "config-project" },
				resourceBindings: {
					"project-management": board,
					fizzy: board,
				},
				context: {
					boardId: "board-1",
					boardName: "Example board",
					accountSlug: "000000",
				},
			});
		});

		it("does not bind a source of one data type to a tool of another", async () => {
			await expect(
				projectReportConnections(genericArgs("repository")),
			).resolves.toBeNull();
		});

		it("binds only the source whose type the project's tool supplies", async () => {
			const connections = await projectReportConnections({
				...args,
				definition: {
					dataSources: [
						{
							id: "project-management",
							type: "mcp",
							dataType: "project-management",
							required: true,
						},
						{
							id: "repository",
							type: "mcp",
							dataType: "repository",
							required: false,
						},
					],
				},
			});

			expect(connections?.mcpBindings).toEqual({
				"project-management": "config-project",
			});
		});

		it("reads the config in the caller's own tenancy", async () => {
			await projectReportConnections(genericArgs("project-management"));

			expect(m.resolvePmConfig).toHaveBeenCalledWith(
				expect.objectContaining({
					configId: "config-project",
					userId: "example-user",
					organizationId: "example-org",
				}),
			);
		});

		it("stays unconnected when the project's tool is not the caller's own", async () => {
			m.resolvePmConfig.mockResolvedValue(null);

			await expect(
				projectReportConnections(genericArgs("project-management")),
			).resolves.toBeNull();
		});

		it("binds a tool with no board without a board", async () => {
			m.resolvePmConfig.mockResolvedValue(
				ownConfig("config-project", "linear"),
			);

			await expect(
				projectReportConnections(genericArgs("project-management")),
			).resolves.toEqual({
				mcpConfigs: ["config-project"],
				mcpBindings: { "project-management": "config-project" },
				resourceBindings: {},
				context: {},
			});
		});

		it("produces connections the report validator accepts", async () => {
			m.resolveConfig.mockResolvedValue({
				configId: "config-project",
				healed: false,
				enabled: true,
			});
			const definition = genericArgs("project-management").definition;

			const connections = await projectReportConnections({
				...args,
				definition,
			});

			await expect(
				validateReportConnections(
					connections,
					"example-user",
					"example-org",
					definition.dataSources,
				),
			).resolves.toMatchObject({ valid: true, errors: [] });
			expect(m.resolveConfig).toHaveBeenCalledWith(
				expect.objectContaining({
					storedConfigId: "config-project",
					serverKeys: [],
				}),
			);
		});
	});

	it("reads a source naming only a server key as that tool", async () => {
		await expect(
			projectReportConnections({
				...args,
				definition: {
					dataSources: [
						{
							id: "task-board",
							type: "mcp",
							config: { mcpServerKey: "fizzy" },
						},
					],
				},
			}),
		).resolves.toMatchObject({
			mcpBindings: {
				"task-board": "config-project",
				fizzy: "config-project",
			},
		});
	});

	describe("a person whose own connection is not the one the project pinned", () => {
		const board = {
			boardId: "board-1",
			boardName: "Example board",
			accountSlug: "000000",
		};

		beforeEach(() => {
			m.resolvePmConfig.mockResolvedValue(ownConfig("config-mine"));
			m.availableConfigs.mockResolvedValue([
				configGroup("fizzy", "config-mine"),
			]);
		});

		it("binds their own connection, with the board when it lists the board", async () => {
			m.boardListed.mockResolvedValue(true);

			const result = await projectReportConnections(args);

			expect(result?.mcpConfigs).toEqual(["config-mine"]);
			expect(result?.context).toEqual(board);
			expect(m.boardListed).toHaveBeenCalledWith({
				configId: "config-mine",
				userId: "example-user",
				organizationId: "example-org",
				boardId: "board-1",
				accountSlug: "000000",
			});
		});

		it("drops the board and its account when their connection does not list it", async () => {
			m.boardListed.mockResolvedValue(false);

			const result = await projectReportConnections(args);

			expect(result?.mcpConfigs).toEqual(["config-mine"]);
			expect(result?.resourceBindings).toEqual({});
			expect(result?.context).toEqual({});
		});

		it("does not ask a connection the project pinned whether it lists its board", async () => {
			m.resolvePmConfig.mockResolvedValue(ownConfig("config-project"));
			m.availableConfigs.mockResolvedValue([
				configGroup("fizzy", "config-project"),
			]);

			await projectReportConnections(args);

			expect(m.boardListed).not.toHaveBeenCalled();
		});
	});

	it("never binds another person's connection: the resolver finds none of the caller's", async () => {
		m.resolvePmConfig.mockResolvedValue(null);

		await expect(projectReportConnections(args)).resolves.toBeNull();
		expect(m.availableConfigs).not.toHaveBeenCalled();
	});

	it("passes the project's context, so the resolver can check the GitLab instance", async () => {
		await projectReportConnections(args);

		expect(m.resolvePmConfig).toHaveBeenCalledWith(
			expect.objectContaining({
				pmAdditionalContext: { account_slug: "/000000" },
			}),
		);
	});

	it("stays unconnected when the caller's GitLab is on another instance than the project's", async () => {
		m.resolvePmConfig.mockRejectedValue(new m.OriginMismatch());

		await expect(projectReportConnections(args)).resolves.toBeNull();
		expect(m.availableConfigs).not.toHaveBeenCalled();
	});

	it("does not swallow another failure to read the connection", async () => {
		m.resolvePmConfig.mockRejectedValue(new Error("database unavailable"));

		await expect(projectReportConnections(args)).rejects.toThrow(
			"database unavailable",
		);
	});

	it("does not bind a connection the caller has switched off", async () => {
		m.resolvePmConfig.mockResolvedValue({
			...ownConfig("config-project"),
			enabled: false,
		});

		await expect(projectReportConnections(args)).resolves.toBeNull();
	});

	it("answers an Azure DevOps source with the project's container", async () => {
		m.findProject.mockResolvedValue({
			projectManagementMcpConfigId: "config-project",
			projectManagementContainerId: "container-1",
			projectManagementContainerName: "Example Project",
			projectManagementAdditionalContext: { team: "Example Team" },
		});
		m.availableConfigs.mockResolvedValue([]);
		m.resolvePmConfig.mockResolvedValue(
			ownConfig("config-project", "azure-devops"),
		);

		const result = await projectReportConnections({
			...args,
			definition: {
				dataSources: [
					{
						id: "project-management",
						type: "mcp",
						dataType: "project-management",
					},
				],
			},
		});

		expect(result?.context).toEqual({
			project: "Example Project",
			team: "Example Team",
		});
		expect(result?.resourceBindings).toEqual({});
	});

	describe("the project's repository", () => {
		const repositoryArgs = {
			...args,
			definition: {
				dataSources: [
					{ id: "code", type: "mcp", dataType: "repository" },
				],
			},
		};

		beforeEach(() => {
			m.findProject.mockResolvedValue({
				projectManagementMcpConfigId: null,
				repositoryIntegrations: [
					{
						provider: "GITHUB",
						repositoryOwner: "example-org",
						repositoryName: "example-repo",
					},
				],
			});
		});

		it("is read through the caller's own connection to its host", async () => {
			m.findConfigs.mockResolvedValue([
				{ id: "config-slack", mcpServer: { key: "slack" } },
				{ id: "config-github", mcpServer: { key: "github-remote" } },
			]);

			await expect(
				projectReportConnections(repositoryArgs),
			).resolves.toEqual({
				mcpConfigs: ["config-github"],
				mcpBindings: { code: "config-github" },
				resourceBindings: {},
				context: {
					organization: "example-org",
					repository: "example-repo",
				},
			});
			expect(m.findConfigs).toHaveBeenCalledWith(
				expect.objectContaining({
					where: {
						userId: "example-user",
						organizationId: "example-org",
						enabled: true,
					},
				}),
			);
		});

		it("binds nothing for a caller without a connection to its host", async () => {
			m.findConfigs.mockResolvedValue([
				{ id: "config-slack", mcpServer: { key: "slack" } },
			]);

			await expect(
				projectReportConnections(repositoryArgs),
			).resolves.toBeNull();
		});
	});
});

describe("missingReportSetup", () => {
	const definition = {
		dataSources: [
			{ id: "pm", type: "mcp", dataType: "project-management" },
			{
				id: "code",
				type: "mcp",
				dataType: "repository",
				required: false,
			},
		],
	};

	it("names a required source left unbound, and not an optional one", () => {
		const missing = missingReportSetup(definition, null, {});

		expect(missing).toHaveLength(1);
		expect(missing[0]).toMatch(/^Connect /);
	});

	it("names a required field of a bound tool left empty", async () => {
		m.availableConfigs.mockResolvedValue([]);
		m.findProject.mockResolvedValue({
			projectManagementMcpConfigId: "config-project",
			projectManagementContainerId: null,
		});
		const bindings = await resolveProjectReportBindings({
			...args,
			definition,
		});

		expect(missingReportSetup(definition, bindings, {})).toEqual([
			"Fill Account Slug",
			"Fill Board",
		]);
		expect(
			missingReportSetup(definition, bindings, {
				accountSlug: "000000",
				boardId: "board-1",
			}),
		).toEqual([]);
	});

	it("asks nothing of a connector-free template", () => {
		expect(
			missingReportSetup(
				{
					dataSources: [
						{
							id: "knowledge",
							type: "fabric",
							provider: "fabric_project",
						},
					],
				},
				null,
				{},
			),
		).toEqual([]);
	});
});
