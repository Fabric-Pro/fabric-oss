import { Permissions } from "@repo/permissions";
import { beforeEach, describe, expect, it, vi } from "vitest";

const m = vi.hoisted(() => ({
	visible: vi.fn(),
	access: vi.fn(),
	deleted: vi.fn(),
	member: vi.fn(),
	slack: vi.fn(),
	channels: vi.fn(),
	chats: vi.fn(),
	credentials: vi.fn(),
	project: vi.fn(),
	config: vi.fn(),
}));
vi.mock("@repo/database", () => ({
	hasProjectAccess: m.visible,
	isProjectSoftDeleted: m.deleted,
	db: {
		member: { findUnique: m.member },
		projectLinkedSlackChannel: { findMany: m.slack },
		projectLinkedTeamsChannel: { findMany: m.channels },
		projectLinkedTeamsChat: { findMany: m.chats },
		workflowIntegration: { findMany: m.credentials },
		project: { findFirst: m.project },
		mCPConfig: { findFirst: m.config },
	},
}));
vi.mock("@repo/utils", () => ({ decryptApiKey: (text: string) => text }));
vi.mock("../../../../lib/effective-project-permissions", () => ({
	resolveEffectiveProjectPermissions: m.access,
}));

import {
	getDeliverySignalSourceConfiguration,
	summarizeDeliverySignalSetup,
} from "../delivery-signal-sources";

const actor = { userId: "example-user" };
const projectId = "example-project";
const organizationId = "example-org";
const paused = new Date("2026-11-01T00:00:00Z");
const slack = (deactivatedAt: Date | null = null) => ({
	slackTeamId: "example-team",
	channelId: "example-channel",
	deactivatedAt,
});
const channel = (deactivatedAt: Date | null = null) => ({
	tenantId: "example-tenant",
	teamId: "example-team",
	channelId: "example-channel",
	deactivatedAt,
});
const chat = (deactivatedAt: Date | null = null) => ({
	chatId: "example-chat",
	chatWebUrl:
		"https://teams.microsoft.com/l/chat/example-chat/conversations?tenantId=example-tenant",
	deactivatedAt,
});
const jwt = `example.${Buffer.from(JSON.stringify({ tid: "example-tenant" })).toString("base64url")}.example`;
const connections = [
	{
		provider: "SLACK",
		credentials: JSON.stringify({
			access_token: "example-synthetic-token",
			team_id: "example-team",
		}),
	},
	{
		provider: "MICROSOFT_GRAPH",
		credentials: JSON.stringify({ access_token: jwt }),
	},
];
const state = (
	result: Awaited<ReturnType<typeof getDeliverySignalSourceConfiguration>>,
	provider: string,
) => result.items.find((item) => item.source === provider)?.state;
beforeEach(() => {
	vi.clearAllMocks();
	m.visible.mockResolvedValue(true);
	m.deleted.mockResolvedValue(false);
	m.access.mockResolvedValue({
		organizationId,
		organizationDeleted: false,
		permissions: [Permissions.PROJECT_READ, Permissions.STORY_READ],
	});
	m.member.mockResolvedValue({ role: "owner" });
	m.slack.mockResolvedValue([]);
	m.channels.mockResolvedValue([]);
	m.chats.mockResolvedValue([]);
	m.credentials.mockResolvedValue(connections);
	m.project.mockResolvedValue({ projectManagementMcpConfigId: null });
	m.config.mockResolvedValue(null);
});
describe("own saved source setup", () => {
	it("does not read bindings or credentials on a refused organization permission", async () => {
		m.member.mockResolvedValue(null);
		await expect(
			getDeliverySignalSourceConfiguration(actor, { projectId }),
		).rejects.toMatchObject({
			code: "FORBIDDEN",
			data: { code: "INSUFFICIENT_PERMISSION" },
		});
		for (const query of [
			m.slack,
			m.channels,
			m.chats,
			m.credentials,
			m.project,
			m.config,
		]) {
			expect(query).not.toHaveBeenCalled();
		}
	});
	it("filters every binding by actor, exact project and organization, independently of any tenant extension", async () => {
		const result = await getDeliverySignalSourceConfiguration(actor, {
			projectId,
		});
		for (const query of [m.slack, m.channels, m.chats]) {
			expect(query.mock.calls[0][0].where).toEqual({
				projectId,
				userId: actor.userId,
				organizationId,
				project: { organizationId, deletedAt: null },
			});
		}
		expect(m.credentials.mock.calls[0][0]).toMatchObject({
			where: {
				userId: actor.userId,
				organizationId,
				isActive: true,
				NOT: {
					name: {
						in: ["SLACK_OAUTH_APP", "MICROSOFT_GRAPH_OAUTH_APP"],
					},
				},
			},
		});
		expect(result.items).toHaveLength(5);
		expect(
			result.items.every((item) => item.state === "NOT_CONFIGURED"),
		).toBe(true);
	});
	it.each(["slack", "channels", "chats"] as const)(
		"honors persisted pause and never-started facts for %s",
		async (kind) => {
			const row =
				kind === "slack" ? slack : kind === "channels" ? channel : chat;
			m[kind].mockResolvedValue([{ ...row(), monitorEnabled: false }]);
			expect(
				state(
					await getDeliverySignalSourceConfiguration(actor, {
						projectId,
					}),
					kind === "slack" ? "SLACK" : "TEAMS",
				),
			).toBe("CONFIGURED_NOT_CHECKED");
			m[kind].mockResolvedValue([row(paused)]);
			expect(
				state(
					await getDeliverySignalSourceConfiguration(actor, {
						projectId,
					}),
					kind === "slack" ? "SLACK" : "TEAMS",
				),
			).toBe("PAUSED");
		},
	);
	it("aggregates all Teams conversations together but keeps Slack separate", async () => {
		m.slack.mockResolvedValue([slack(paused)]);
		m.channels.mockResolvedValue([channel(paused)]);
		m.chats.mockResolvedValue([chat()]);
		const result = await getDeliverySignalSourceConfiguration(actor, {
			projectId,
		});
		expect(state(result, "SLACK")).toBe("PAUSED");
		expect(state(result, "TEAMS")).toBe("CONFIGURED_NOT_CHECKED");
	});
	it("discards unknown/mismatched rows before aggregating rather than short-circuiting a provider", async () => {
		m.slack.mockResolvedValue([
			{ ...slack(paused), slackTeamId: "wrong-team" },
			slack(paused),
			slack(),
		]);
		m.channels.mockResolvedValue([
			{ ...channel(), tenantId: null },
			channel(paused),
		]);
		m.chats.mockResolvedValue([
			{ ...chat(), chatWebUrl: "https://example.com/private" },
		]);
		const result = await getDeliverySignalSourceConfiguration(actor, {
			projectId,
		});
		expect(state(result, "SLACK")).toBe("CONFIGURED_NOT_CHECKED");
		expect(state(result, "TEAMS")).toBe("PAUSED");
	});
	it.each(
		[
			[],
			[{ provider: "SLACK", credentials: "not-json" }],
			[{ provider: "SLACK", credentials: '{"team_id":"example-team"}' }],
			[
				{
					provider: "SLACK",
					credentials:
						'{"access_token":"example","team_id":"wrong-team"}',
				},
			],
		].map((credentials) => ({ credentials })),
	)(
		"fails closed on missing credential identity",
		async ({ credentials }) => {
			m.credentials.mockResolvedValue(credentials);
			m.slack.mockResolvedValue([slack()]);
			expect(
				state(
					await getDeliverySignalSourceConfiguration(actor, {
						projectId,
					}),
					"SLACK",
				),
			).toBe("NOT_CONFIGURED");
		},
	);
	it.each(["atlassian", "azure-devops", "fizzy"])(
		"requires the exact actor-owned enabled pinned %s configuration",
		async (key) => {
			m.project.mockResolvedValue({
				projectManagementMcpConfigId: "example-config",
				projectManagementMcpServerId: "example-server",
				projectManagementContainerId:
					key === "azure-devops"
						? "00000000-0000-4000-8000-000000000001"
						: "example-container",
				projectManagementAdditionalContext: {
					cloudId: "example-cloud",
					account_slug: "example-account",
				},
			});
			m.config.mockResolvedValue({
				mcpServerId: "example-server",
				commandArgs: ["example-org"],
				baseUrl: null,
				atlassianCloudCloudId: "example-cloud",
				atlassianCloudAccessibleResources: [],
				mcpServer: { key, defaultUrl: null },
			});
			const result = await getDeliverySignalSourceConfiguration(actor, {
				projectId,
			});
			expect(
				state(
					result,
					key === "atlassian"
						? "JIRA"
						: key === "fizzy"
							? "FIZZY"
							: "AZURE_DEVOPS",
				),
			).toBe("CONFIGURED_NOT_CHECKED");
			expect(m.config.mock.calls[0][0].where).toEqual({
				id: "example-config",
				organizationId,
				userId: actor.userId,
				enabled: true,
			});
			expect(
				JSON.stringify(m.config.mock.calls[0][0].select),
			).not.toMatch(/encrypted|credentials|accessToken/i);
			m.config.mockResolvedValue(null);
			expect(
				state(
					await getDeliverySignalSourceConfiguration(actor, {
						projectId,
					}),
					key === "atlassian"
						? "JIRA"
						: key === "fizzy"
							? "FIZZY"
							: "AZURE_DEVOPS",
				),
			).toBe("NOT_CONFIGURED");
		},
	);
	it("returns only provider/state, never health, owners, private names or tokens", async () => {
		m.slack.mockResolvedValue([
			{
				...slack(),
				lastErrorMessage: "private-error",
				teamName: "private-team",
			},
		]);
		const result = await getDeliverySignalSourceConfiguration(actor, {
			projectId,
		});
		expect(
			result.items.every(
				(item) => Object.keys(item).sort().join() === "source,state",
			),
		).toBe(true);
		expect(JSON.stringify(result)).not.toMatch(
			/token|credential|private|health|freshness|lastSuccess|userId|projectId/i,
		);
	});
	it("has a deterministic per-provider aggregation contract", () => {
		expect(summarizeDeliverySignalSetup([])).toBe("NOT_CONFIGURED");
		expect(summarizeDeliverySignalSetup([{ deactivatedAt: paused }])).toBe(
			"PAUSED",
		);
		expect(
			summarizeDeliverySignalSetup([
				{ deactivatedAt: paused },
				{ deactivatedAt: null },
			]),
		).toBe("CONFIGURED_NOT_CHECKED");
	});
});
