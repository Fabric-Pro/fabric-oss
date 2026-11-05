import {
	accountSlugFromContext,
	boardResourceBindings,
	contextFieldsForProviders,
	contextWithBoundBoard,
	contextWithListedBoard,
	isRequiredDataSource,
	parseTemplateDefinition,
	parseTemplateWorkspaces,
	pickPrefillContext,
	projectConnectionDefaults,
	promptOverrideFields,
	promptOverrideFor,
	providerForServerKey,
	reportDataSourceLabel,
	reportProviderLabel,
	sourceProviderKey,
	templateSystemPrompt,
} from "@saas/reports/lib/report-template-definition";
import type { ProviderContextField } from "@saas/shared/components/provider-context-fields";
import { describe, expect, it } from "vitest";

const FIELDS: Record<string, ProviderContextField[]> = {
	fizzy: [
		{
			key: "accountSlug",
			label: "Account Slug",
			placeholder: "123456",
			required: true,
			helpText: "",
		},
		{
			key: "boardId",
			label: "Board",
			placeholder: "12345",
			required: true,
			helpText: "",
		},
	],
	azure_devops: [
		{
			key: "project",
			label: "Project Name",
			placeholder: "MyProject",
			required: true,
			helpText: "",
		},
		{
			key: "team",
			label: "Team Name",
			placeholder: "MyTeam",
			required: false,
			helpText: "",
		},
	],
	linear: [
		{
			key: "team",
			label: "Team Name",
			placeholder: "Engineering",
			required: true,
			helpText: "",
		},
	],
};

describe("parseTemplateDefinition", () => {
	it("keeps data sources that name a provider, and the user prompt", () => {
		const parsed = parseTemplateDefinition({
			userPrompt: "Summarize the sprint",
			dataSources: [
				{ id: "ds-1", type: "mcp", provider: "fizzy" },
				{ id: "ds-2", type: "mcp", provider: "" },
				{ id: "ds-3", type: "workspace" },
				"not an object",
			],
		});
		expect(parsed.userPrompt).toBe("Summarize the sprint");
		expect(parsed.dataSources).toEqual([
			{
				id: "ds-1",
				type: "mcp",
				provider: "fizzy",
				operation: undefined,
			},
		]);
	});

	it("reads a source without a known type as an MCP source", () => {
		const parsed = parseTemplateDefinition({
			dataSources: [{ id: "ds-1", provider: "fizzy" }],
		});
		expect(parsed.dataSources[0]?.type).toBe("mcp");
	});

	it("keeps a source that asks for a data type, and names no provider for it", () => {
		const parsed = parseTemplateDefinition({
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
		});
		expect(parsed.dataSources).toEqual([
			{
				id: "project-management",
				type: "mcp",
				dataType: "project-management",
				operation: undefined,
			},
			{
				id: "repository",
				type: "mcp",
				dataType: "repository",
				operation: undefined,
				required: false,
			},
		]);
	});

	it("reads a server key as the provider", () => {
		const parsed = parseTemplateDefinition({
			dataSources: [
				{
					id: "ds-1",
					type: "mcp",
					config: { mcpServerKey: "fizzy" },
				},
			],
		});
		expect(parsed.dataSources[0]).toMatchObject({
			id: "ds-1",
			provider: "fizzy",
		});
	});

	it("reads a source naming a tool as that tool, whatever data type it declares", () => {
		const parsed = parseTemplateDefinition({
			dataSources: [
				{
					id: "ds-1",
					type: "mcp",
					provider: "fizzy",
					dataType: "project-management",
				},
			],
		});
		expect(parsed.dataSources[0]).toMatchObject({ provider: "fizzy" });
		expect(parsed.dataSources[0]).not.toHaveProperty("dataType");
	});

	describe("without the report suite", () => {
		const off = { reportSuite: false };

		it("adds no connection for a source naming only a server key", () => {
			expect(
				parseTemplateDefinition(
					{
						dataSources: [
							{
								id: "github-prs",
								type: "mcp",
								config: {
									toolName: "list_pull_requests",
									mcpServerKey: "github",
								},
							},
						],
					},
					off,
				).dataSources,
			).toEqual([]);
		});

		it("adds no connection for a source asking for a data type", () => {
			expect(
				parseTemplateDefinition(
					{
						dataSources: [
							{
								id: "project-management",
								type: "mcp",
								dataType: "project-management",
								required: false,
							},
						],
					},
					off,
				).dataSources,
			).toEqual([]);
		});

		it("still reads a source naming a provider", () => {
			expect(
				parseTemplateDefinition(
					{
						dataSources: [
							{ id: "ds-1", type: "mcp", provider: "fizzy" },
						],
					},
					off,
				).dataSources,
			).toEqual([
				{
					id: "ds-1",
					type: "mcp",
					provider: "fizzy",
					operation: undefined,
				},
			]);
		});
	});

	it("drops a source with an unknown data type and no tool", () => {
		expect(
			parseTemplateDefinition({
				dataSources: [
					{ id: "ds-1", type: "mcp", dataType: "documents" },
				],
			}).dataSources,
		).toEqual([]);
	});

	it("returns no data sources for a missing or malformed definition", () => {
		expect(parseTemplateDefinition(null).dataSources).toEqual([]);
		expect(parseTemplateDefinition("x").dataSources).toEqual([]);
		expect(
			parseTemplateDefinition({ dataSources: "x" }).dataSources,
		).toEqual([]);
	});
});

describe("parseTemplateWorkspaces", () => {
	it("reads the document-library requirement", () => {
		expect(
			parseTemplateWorkspaces({
				workspaces: { enabled: true, description: "Pick a library" },
			}),
		).toEqual({ enabled: true, description: "Pick a library" });
		expect(parseTemplateWorkspaces(null)).toEqual({ enabled: false });
	});
});

describe("contextFieldsForProviders", () => {
	it("lists each key once, owned by the first provider that declares it", () => {
		const fields = contextFieldsForProviders(
			["azure_devops", "linear"],
			FIELDS,
		);
		expect(fields.map((f) => `${f.provider}:${f.key}`)).toEqual([
			"azure_devops:project",
			"azure_devops:team",
		]);
	});

	it("skips providers without context fields", () => {
		expect(contextFieldsForProviders(["slack"], FIELDS)).toEqual([]);
	});
});

describe("pickPrefillContext", () => {
	const fizzyFields = contextFieldsForProviders(["fizzy"], FIELDS);

	it("copies a saved context of a report bound to the same provider", () => {
		const prefill = pickPrefillContext(
			{
				mcpBindings: { fizzy: "cfg-1", "ds-1": "cfg-1" },
				context: { accountSlug: " 123 ", boardId: "42", other: "x" },
			},
			fizzyFields,
		);
		expect(prefill).toEqual({ accountSlug: "123", boardId: "42" });
	});

	it("copies nothing across providers", () => {
		const adoFields = contextFieldsForProviders(["azure_devops"], FIELDS);
		const prefill = pickPrefillContext(
			{
				mcpBindings: { linear: "cfg-2" },
				context: { team: "Engineering" },
			},
			adoFields,
		);
		expect(prefill).toEqual({});
	});

	it("copies a saved context when the bound config says a generic source is that provider", () => {
		const connections = {
			mcpBindings: { "project-management": "cfg-1" },
			context: { boardId: "42" },
		};
		expect(pickPrefillContext(connections, fizzyFields)).toEqual({});
		expect(
			pickPrefillContext(connections, fizzyFields, [
				{ id: "cfg-1", mcpServer: { key: "fizzy" } },
			]),
		).toEqual({ boardId: "42" });
		expect(
			pickPrefillContext(connections, fizzyFields, [
				{ id: "cfg-1", mcpServer: { key: "linear" } },
			]),
		).toEqual({});
	});

	it("ignores empty values and malformed connections", () => {
		expect(
			pickPrefillContext(
				{ mcpBindings: { fizzy: "cfg-1" }, context: { boardId: "  " } },
				fizzyFields,
			),
		).toEqual({});
		expect(pickPrefillContext(null, fizzyFields)).toEqual({});
		expect(
			pickPrefillContext({ mcpBindings: "x", context: 3 }, fizzyFields),
		).toEqual({});
	});
});

describe("boardResourceBindings", () => {
	const isBoardProvider = (provider: string) => provider === "fizzy";

	it("binds the picked board under the data source id and the provider", () => {
		const board = {
			resourceId: "board-1",
			resourceName: "Example Board",
			resourceType: "board",
		};
		expect(
			boardResourceBindings(
				[{ id: "ds-1", provider: "fizzy" }],
				{
					accountSlug: "123",
					boardId: "board-1",
					boardName: "Example Board",
				},
				isBoardProvider,
			),
		).toEqual({ "ds-1": board, fizzy: board });
	});

	it("names the board by its id when no name was given", () => {
		expect(
			boardResourceBindings(
				[{ id: "ds-1", provider: "fizzy" }],
				{ boardId: "board-1" },
				isBoardProvider,
			)["ds-1"]?.resourceName,
		).toBe("board-1");
	});

	it("binds nothing without a board or for providers without boards", () => {
		expect(
			boardResourceBindings(
				[{ id: "ds-1", provider: "fizzy" }],
				{ boardId: "  " },
				isBoardProvider,
			),
		).toEqual({});
		expect(
			boardResourceBindings(
				[{ id: "ds-2", provider: "github" }],
				{ boardId: "board-1" },
				isBoardProvider,
			),
		).toEqual({});
	});
});

describe("contextWithBoundBoard", () => {
	const boardBinding = {
		resourceId: "board-1",
		resourceName: "Example Board",
		resourceType: "board",
	};

	it("fills the board from the data source's bound resource", () => {
		expect(
			contextWithBoundBoard(
				{ accountSlug: "123" },
				{ fizzy: { ...boardBinding } },
			),
		).toEqual({
			accountSlug: "123",
			boardId: "board-1",
			boardName: "Example Board",
		});
	});

	it("keeps a board typed into the context", () => {
		const context = { boardId: "board-typed" };
		expect(
			contextWithBoundBoard(context, { fizzy: { ...boardBinding } }),
		).toBe(context);
	});

	it("ignores bound resources that are not boards", () => {
		const context = { accountSlug: "123" };
		expect(
			contextWithBoundBoard(context, {
				github: {
					resourceId: "repo-1",
					resourceName: "example-repo",
					resourceType: "repository",
				},
				slack: undefined,
			}),
		).toBe(context);
	});

	it("round-trips the board the create dialog binds", () => {
		const resourceBindings = boardResourceBindings(
			[{ id: "ds-1", provider: "fizzy" }],
			{ boardId: "board-1", boardName: "Example Board" },
			(provider) => provider === "fizzy",
		);
		expect(contextWithBoundBoard({}, resourceBindings)).toMatchObject({
			boardId: "board-1",
			boardName: "Example Board",
		});
	});
});

describe("data source requirement", () => {
	it("keeps a template's optional data source optional", () => {
		const { dataSources } = parseTemplateDefinition({
			dataSources: [
				{ id: "ds-1", type: "mcp", provider: "fizzy" },
				{
					id: "ds-2",
					type: "mcp",
					provider: "github",
					required: false,
				},
			],
		});
		expect(dataSources.map(isRequiredDataSource)).toEqual([true, false]);
	});
});

describe("reportProviderLabel", () => {
	it("labels registry and seeded-template provider keys", () => {
		expect(reportProviderLabel("azure_devops")).toBe("Azure DevOps");
		expect(reportProviderLabel("fizzy")).toBe("Fizzy");
		expect(reportProviderLabel("slack")).toBe("Slack");
	});

	it("keeps a name that is already a label or unknown", () => {
		expect(reportProviderLabel("Fizzy")).toBe("Fizzy");
		expect(reportProviderLabel("custom_server")).toBe("custom_server");
	});
});

describe("reportDataSourceLabel", () => {
	it("names a provider source by its label, never its generated id", () => {
		expect(
			reportDataSourceLabel({
				id: "ds-1793816924540",
				type: "mcp",
				provider: "fizzy",
			}),
		).toBe("Fizzy");
		expect(
			reportDataSourceLabel({
				id: "ds-1793816941644",
				type: "mcp",
				provider: "azure_devops",
			}),
		).toBe("Azure DevOps");
	});

	it("adds the tool for a source pinned to one", () => {
		expect(
			reportDataSourceLabel({
				id: "sprint-items",
				type: "mcp",
				config: { mcpServerKey: "fizzy", toolName: "fizzy_get_cards" },
			}),
		).toBe("Fizzy → fizzy_get_cards");
	});

	it("marks an integration source as an API", () => {
		expect(
			reportDataSourceLabel({
				id: "ds-3",
				type: "integration",
				provider: "azure_devops",
			}),
		).toBe("Azure DevOps API");
	});

	it("names a source that asks for a data type after the type", () => {
		expect(
			reportDataSourceLabel({
				id: "project-management",
				type: "mcp",
				dataType: "project-management",
			}),
		).toBe("Project management");
	});

	it("falls back to a generic name when the provider is unknown", () => {
		expect(reportDataSourceLabel({ id: "ds-4", type: "mcp" })).toBe(
			"MCP server",
		);
		expect(
			reportDataSourceLabel({
				id: "ds-5",
				type: "mcp",
				provider: "custom_server",
			}),
		).toBe("custom_server");
	});
});

describe("promptOverrideFor", () => {
	it("saves nothing while the instructions are the template's own", () => {
		expect(
			promptOverrideFor(
				" Summarize the sprint. ",
				"Summarize the sprint.",
			),
		).toBeUndefined();
		expect(
			promptOverrideFor("   ", "Summarize the sprint."),
		).toBeUndefined();
	});

	it("saves instructions the person changed", () => {
		expect(
			promptOverrideFor(
				"Summarize the release.",
				"Summarize the sprint.",
			),
		).toBe("Summarize the release.");
		expect(promptOverrideFor("Summarize the release.", undefined)).toBe(
			"Summarize the release.",
		);
	});
});

describe("promptOverrideFields", () => {
	it("marks instructions a person wrote on create", () => {
		expect(
			promptOverrideFields(
				"Summarize the release.",
				"Summarize the sprint.",
			),
		).toEqual({
			promptOverride: "Summarize the release.",
			promptOverrideSource: "user",
		});
	});

	it("saves nothing while the instructions are the template's own", () => {
		expect(
			promptOverrideFields(
				"Summarize the sprint.",
				"Summarize the sprint.",
				{
					promptOverride: "Summarize the sprint.",
					promptOverrideSource: "user",
				},
			),
		).toEqual({});
	});

	it("leaves an unchanged copy of an older template prompt unmarked", () => {
		expect(
			promptOverrideFields(
				"Summarize last sprint.",
				"Summarize the sprint.",
				{
					promptOverride: "Summarize last sprint.",
				},
			),
		).toEqual({ promptOverride: "Summarize last sprint." });
	});

	it("keeps the mark of an unchanged override a person wrote", () => {
		expect(
			promptOverrideFields(
				"Focus on payments.",
				"Summarize the sprint.",
				{
					promptOverride: "Focus on payments.",
					promptOverrideSource: "user",
				},
			),
		).toEqual({
			promptOverride: "Focus on payments.",
			promptOverrideSource: "user",
		});
	});

	it("marks a stored override the person changed", () => {
		expect(
			promptOverrideFields(
				"Focus on payments.",
				"Summarize the sprint.",
				{
					promptOverride: "Summarize last sprint.",
				},
			),
		).toEqual({
			promptOverride: "Focus on payments.",
			promptOverrideSource: "user",
		});
	});
});

describe("templateSystemPrompt", () => {
	it("reads the template's system prompt", () => {
		expect(
			templateSystemPrompt({ defaultSystemPrompt: "You write reports." }),
		).toBe("You write reports.");
	});

	it("is undefined when the template sets none", () => {
		expect(
			templateSystemPrompt({ defaultSystemPrompt: "  " }),
		).toBeUndefined();
		expect(templateSystemPrompt(null)).toBeUndefined();
	});
});

describe("projectConnectionDefaults", () => {
	const fizzyConfig = {
		id: "config-fizzy",
		mcpServer: { key: "fizzy", name: "Fizzy" },
	};
	const githubConfig = {
		id: "config-github",
		mcpServer: { key: "github", name: "GitHub" },
	};
	const project = {
		projectManagementMcpConfigId: "config-fizzy",
		projectManagementContainerId: "board-7",
		projectManagementContainerName: "Example Board",
		projectManagementAdditionalContext: { account_slug: "/123456" },
	};
	const isBoardProvider = (provider: string) => provider === "fizzy";

	it("binds the project's connection and board for the matching data source", () => {
		expect(
			projectConnectionDefaults(
				[
					{ id: "ds-board", type: "mcp", provider: "fizzy" },
					{ id: "ds-repo", type: "mcp", provider: "github" },
				],
				project,
				[fizzyConfig, githubConfig],
				isBoardProvider,
			),
		).toEqual({
			bindings: { "ds-board": fizzyConfig },
			context: {
				boardId: "board-7",
				boardName: "Example Board",
				accountSlug: "123456",
			},
		});
	});

	it("falls back to nothing when the creator cannot use the project's connection", () => {
		expect(
			projectConnectionDefaults(
				[{ id: "ds-board", type: "mcp", provider: "fizzy" }],
				project,
				[githubConfig],
				isBoardProvider,
			),
		).toEqual({ bindings: {}, context: {} });
	});

	it("binds without a board when the template reads no board", () => {
		expect(
			projectConnectionDefaults(
				[{ id: "ds-issues", type: "mcp", provider: "fizzy" }],
				project,
				[fizzyConfig],
				() => false,
			),
		).toEqual({ bindings: { "ds-issues": fizzyConfig }, context: {} });
	});

	describe("a source that asks for a data type", () => {
		const fizzyTool = {
			id: "config-fizzy",
			mcpServer: {
				key: "fizzy",
				name: "Fizzy",
				category: "Project Management",
				tags: [],
			},
		};
		const projectManagement = {
			id: "project-management",
			type: "mcp" as const,
			dataType: "project-management" as const,
		};
		const repository = {
			id: "repository",
			type: "mcp" as const,
			dataType: "repository" as const,
		};

		it("takes the project's tool of that type, and its board", () => {
			expect(
				projectConnectionDefaults(
					[projectManagement],
					project,
					[fizzyTool],
					isBoardProvider,
				),
			).toEqual({
				bindings: { "project-management": fizzyTool },
				context: {
					boardId: "board-7",
					boardName: "Example Board",
					accountSlug: "123456",
				},
			});
		});

		it("does not take a tool of another data type", () => {
			expect(
				projectConnectionDefaults(
					[repository],
					project,
					[fizzyTool],
					isBoardProvider,
				),
			).toEqual({ bindings: {}, context: {} });
		});

		it("takes a repository host by its tags", () => {
			const gitTool = {
				id: "config-fizzy",
				mcpServer: {
					key: "gitlab",
					name: "GitLab",
					category: "Developer Tools",
					tags: ["git"],
				},
			};
			expect(
				projectConnectionDefaults(
					[projectManagement, repository],
					project,
					[gitTool],
					isBoardProvider,
				),
			).toEqual({
				bindings: { repository: gitTool },
				context: {},
			});
		});
	});

	it("names the board by its id when the project saved no name", () => {
		expect(
			projectConnectionDefaults(
				[{ id: "ds-board", type: "mcp", provider: "fizzy" }],
				{
					projectManagementMcpConfigId: "config-fizzy",
					projectManagementContainerId: "board-7",
				},
				[fizzyConfig],
				isBoardProvider,
			).context,
		).toEqual({ boardId: "board-7", boardName: "board-7" });
	});
});

describe("providerForServerKey", () => {
	it("maps a server key to the provider key the setup screens use", () => {
		expect(providerForServerKey("atlassian")).toBe("jira");
		expect(providerForServerKey("github-remote")).toBe("github");
		expect(providerForServerKey("azure-devops")).toBe("azure_devops");
	});

	it("keeps a key it does not know, and is null without one", () => {
		expect(providerForServerKey("example-tracker")).toBe("example-tracker");
		expect(providerForServerKey(null)).toBeNull();
		expect(providerForServerKey("")).toBeNull();
	});
});

describe("sourceProviderKey", () => {
	it("is the provider a source names, whatever is bound", () => {
		expect(
			sourceProviderKey(
				{ provider: "fizzy" },
				{ mcpServer: { key: "github" } },
			),
		).toBe("fizzy");
	});

	it("follows the bound server for a generic source, and is null until one is bound", () => {
		expect(sourceProviderKey({}, { mcpServer: { key: "atlassian" } })).toBe(
			"jira",
		);
		expect(sourceProviderKey({})).toBeNull();
		expect(sourceProviderKey({}, null)).toBeNull();
	});
});

describe("accountSlugFromContext", () => {
	it("reads the slug a container lookup recorded, without a leading slash", () => {
		expect(accountSlugFromContext({ accountSlug: "/654321" })).toBe(
			"654321",
		);
		expect(accountSlugFromContext({})).toBeNull();
	});
});

describe("contextWithListedBoard", () => {
	const boards = [
		{ id: "board-1", name: "Board one" },
		{ id: "board-2", name: "Board two" },
	];

	it("drops a board the loaded list no longer offers", () => {
		expect(
			contextWithListedBoard(
				{ accountSlug: "123", boardId: "gone", boardName: "Old board" },
				boards,
			),
		).toEqual({});
	});

	it("falls back to the account the board list came from", () => {
		expect(
			contextWithListedBoard(
				{ accountSlug: "123", boardId: "gone", boardName: "Old board" },
				boards,
				"456",
			),
		).toEqual({ accountSlug: "456" });
	});

	it("keeps a board the list offers, unchanged", () => {
		const context = { boardId: "board-2", boardName: "Board two" };

		expect(contextWithListedBoard(context, boards)).toBe(context);
	});

	it("keeps the board while the list is empty or not loaded", () => {
		const context = { boardId: "gone", boardName: "Old board" };

		expect(contextWithListedBoard(context, [])).toBe(context);
	});
});
