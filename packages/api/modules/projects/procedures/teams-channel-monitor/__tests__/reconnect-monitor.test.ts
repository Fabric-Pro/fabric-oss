import { beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
	projectFindFirst: vi.fn(),
	channelFindMany: vi.fn(),
	teamsTool: vi.fn(),
}));

vi.mock("@repo/database", () => ({
	db: {
		project: { findFirst: mocks.projectFindFirst },
		projectLinkedTeamsChannel: { findMany: mocks.channelFindMany },
	},
}));

vi.mock("@repo/integrations/microsoft", () => ({
	executeMicrosoftTeamsTool: mocks.teamsTool,
}));

vi.mock("../../../../../lib/audit", () => ({
	recordAuditFromRequest: vi.fn(),
}));

vi.mock("../../../../../orpc/procedures", () => {
	const procedure = {
		use: () => procedure,
		route: () => procedure,
		input: () => procedure,
		handler: (handler: unknown) => handler,
	};
	return {
		tenantProtectedProcedure: procedure,
		Permissions: { PROJECT_UPDATE: "project:update" },
		requireProjectPermission: vi.fn(),
	};
});

import { reconnectMonitorProcedure } from "../reconnect-monitor";

const preflight = () =>
	(
		reconnectMonitorProcedure as unknown as (
			args: unknown,
		) => Promise<unknown>
	)({
		input: { projectId: "project-1", preflightOnly: true },
		context: { user: { id: "user-1" } },
	});

beforeEach(() => {
	vi.clearAllMocks();
	mocks.projectFindFirst.mockResolvedValue({
		id: "project-1",
		organizationId: "org-1",
	});
	mocks.channelFindMany.mockResolvedValue([
		{
			id: "row-1",
			teamId: "team-1",
			channelId: "channel-1",
			channelName: "Alpha",
		},
	]);
});

describe("Teams channel reconnect preflight", () => {
	it("checks one page using the calling account and the project's organization", async () => {
		mocks.teamsTool.mockResolvedValue({ threads: [] });

		await expect(preflight()).resolves.toMatchObject({ reachableCount: 1 });
		expect(mocks.teamsTool).toHaveBeenCalledWith(
			"list_channel_threads",
			{ teamId: "team-1", channelId: "channel-1", top: 1 },
			"user-1",
			"org-1",
		);
	});

	it("reports a response without channel threads as inconclusive", async () => {
		mocks.teamsTool.mockResolvedValue({ messages: [] });

		await expect(preflight()).resolves.toMatchObject({
			reachableCount: 0,
			indeterminateLabels: ["Alpha"],
		});
	});

	it.each([
		{
			name: "a Graph access denial",
			message:
				'Microsoft Graph API error: 403 Forbidden - {"error":{"code":"Forbidden","message":"UnknownError"}}',
			unreachableLabels: ["Alpha"],
			indeterminateLabels: [],
		},
		{
			name: "a Graph service outage",
			message:
				'Microsoft Graph API error: 503 Service Unavailable - {"error":{"code":"Forbidden"}}',
			unreachableLabels: [],
			indeterminateLabels: ["Alpha"],
		},
		{
			name: "an invalid Microsoft token",
			message:
				'Microsoft Graph API error: 403 Forbidden - {"error":{"code":"InvalidAuthenticationToken"}}',
			unreachableLabels: [],
			indeterminateLabels: ["Alpha"],
		},
	])(
		"reports $name",
		async ({ message, unreachableLabels, indeterminateLabels }) => {
			mocks.teamsTool.mockRejectedValue(new Error(message));

			await expect(preflight()).resolves.toMatchObject({
				mode: "preflight",
				reachableCount: 0,
				unreachableLabels,
				indeterminateLabels,
			});
		},
	);
});
