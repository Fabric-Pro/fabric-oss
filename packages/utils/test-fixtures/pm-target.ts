import type { PmTargetConfig } from "../lib/pm-target";

interface PmTargetFixture {
	name: string;
	pmTool: string;
	containerId: string;
	instance: string;
	instanceOrigin?: string;
	config: PmTargetConfig;
	additionalContext: Record<string, string>;
}

/** Synthetic targets shared by the writer/checker contract tests. */
export const pmTargetFixtures: PmTargetFixture[] = [
	{
		name: "ADO",
		pmTool: "azure-devops",
		containerId: "11111111-1111-4111-8111-111111111111",
		instance: "example-org",
		config: {
			commandArgs: ["example-org"],
			mcpServer: { key: "azure-devops" },
		},
		additionalContext: {},
	},
	...[false, true].flatMap((cloud): PmTargetFixture[] =>
		[false, true].map(
			(attachment): PmTargetFixture => ({
				name: `Jira cloud=${cloud} attachment=${attachment}`,
				pmTool: "jira",
				containerId: "example-project",
				instance: cloud ? "example-cloud" : "",
				config: {
					atlassianCloudSiteUrl: attachment
						? "https://example.atlassian.net"
						: null,
					mcpServer: { key: "jira" },
				},
				additionalContext: cloud ? { cloudId: "example-cloud" } : {},
			}),
		),
	),
	...["REST", "MCP"].map(
		(transport): PmTargetFixture => ({
			name: `GitLab ${transport}`,
			pmTool: "gitlab",
			containerId: "42",
			instance: "https://gitlab.example.com",
			config: {
				baseUrl:
					transport === "MCP" ? "https://gitlab.example.com" : null,
				mcpServer: {
					key: "gitlab-official",
					defaultUrl: "https://gitlab.com",
				},
			},
			additionalContext: { gitlabOrigin: "https://gitlab.example.com" },
		}),
	),
	...["REST", "MCP"].map(
		(transport): PmTargetFixture => ({
			name: `GitLab ${transport} legacy`,
			pmTool: "gitlab",
			containerId: "42",
			instance: "https://gitlab.com",
			instanceOrigin: "https://gitlab.com",
			config: {
				baseUrl: null,
				mcpServer: {
					key: "gitlab-official",
					defaultUrl: "https://gitlab.com",
				},
			},
			additionalContext: {},
		}),
	),
	{
		name: "Fizzy",
		pmTool: "fizzy",
		containerId: "example-board",
		instance: "/example-account",
		config: { mcpServer: { key: "fizzy" } },
		additionalContext: { account_slug: "/example-account" },
	},
];
export const mutablePmSettings = {
	fieldMapping: { title: "name" },
	iterationPath: "example-iteration",
	workItemType: "Bug",
	team: "example-team",
	areaPath: "example-area",
	parentId: "example-parent",
	containerName: "Example",
};
export function fixtureTarget(
	fixture: (typeof pmTargetFixtures)[number],
	serverId: string,
) {
	return `pmt1:${JSON.stringify([serverId, fixture.instance, fixture.containerId])}`;
}
