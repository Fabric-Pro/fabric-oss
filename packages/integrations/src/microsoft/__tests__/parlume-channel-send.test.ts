import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
	integration: vi.fn(),
	session: vi.fn(),
	access: vi.fn(),
	canUse: vi.fn(),
	fetch: vi.fn(),
}));
vi.mock("@repo/database", () => ({
	canUseWorkflowIntegrations: mocks.canUse,
	workflowIntegrationAccessWhere: (
		userId: string,
		organizationId: string,
	) => ({ userId, organizationId }),
	getProjectAccessContext: mocks.access,
	resolveWorkflowIntegrationForProvider: mocks.integration,
	db: {
		workflowIntegration: { findFirst: mocks.integration },
		parlumeMeetingSession: { findFirst: mocks.session },
	},
}));
vi.mock("@repo/utils", () => ({
	decryptApiKey: (value: string) => value,
	encryptApiKey: (value: string) => value,
}));
vi.mock("@repo/ai", () => ({ extractRelevantExcerpts: vi.fn() }));

import { executeMicrosoftTeamsTool } from "../index";

const destination = {
	teamId: "example-team",
	channelId: "19:example@thread.tacv2",
	rootMessageId: "1700000000000",
	tenantId: "example-tenant",
};
const operation = {
	kind: "send",
	sessionId: "example-session",
	destination,
	text: "[P1] Fabric Parlume: Answer",
};
const send = () =>
	executeMicrosoftTeamsTool(
		"parlume_channel",
		operation,
		"example-user",
		"example-org",
		"example-integration",
	);

beforeEach(() => {
	vi.resetAllMocks();
	vi.stubGlobal("fetch", mocks.fetch);
	mocks.canUse.mockResolvedValue(true);
	mocks.integration.mockResolvedValue({
		id: "example-integration",
		credentials: JSON.stringify({
			access_token: "example-token",
			refresh_token: "example-refresh",
		}),
	});
	mocks.session.mockResolvedValue({ projectId: "example-project" });
	mocks.access.mockResolvedValue({ organizationId: "example-org" });
});
afterEach(() => vi.unstubAllGlobals());

describe("single-dispatch Parlume Graph reply", () => {
	it.each([401, 429, 502, 503, 504])(
		"never retries an ambiguous channel POST (HTTP %s), including authentication replay",
		async (status) => {
			mocks.fetch.mockResolvedValue(new Response(null, { status }));
			await expect(send()).rejects.toThrow(`HTTP ${status}`);
			expect(mocks.fetch).toHaveBeenCalledTimes(1);
			expect(mocks.fetch.mock.calls[0][0]).toBe(
				`https://graph.microsoft.com/v1.0/teams/example-team/channels/${encodeURIComponent(destination.channelId)}/messages/${destination.rootMessageId}/replies`,
			);
		},
	);
	it("checks exact current binding, access and hard stop at dispatch", async () => {
		mocks.fetch.mockResolvedValue(Response.json({ id: "example-reply" }));
		expect(await send()).toEqual({ messageId: "example-reply" });
		expect(mocks.session.mock.calls[0][0].where).toMatchObject({
			id: operation.sessionId,
			status: "ACTIVE",
			userId: "example-user",
			organizationId: "example-org",
			channelIntegrationId: "example-integration",
			channelRootMessageId: destination.rootMessageId,
			channelTenantId: destination.tenantId,
			leaveRequestedAt: null,
			captureStoppedAt: null,
			endedAt: null,
			hardStopAt: { gt: expect.any(Date) },
		});
	});
	it("does not send after the session stops during token/access preflight", async () => {
		mocks.session.mockResolvedValue(null);
		await expect(send()).rejects.toThrow("no longer authorized");
		expect(mocks.fetch).not.toHaveBeenCalled();
	});
	it("does not send after project access is revoked or the tenant changes", async () => {
		mocks.access.mockResolvedValue({ organizationId: "another-org" });
		await expect(send()).rejects.toThrow("no longer authorized");
		expect(mocks.fetch).not.toHaveBeenCalled();
	});
	it("cannot switch to a different Microsoft integration after access is revoked", async () => {
		mocks.integration.mockResolvedValue(null);
		await expect(send()).rejects.toThrow("not connected");
		expect(mocks.fetch).not.toHaveBeenCalled();
	});
	it("does not post a captured token when the pinned connection is disabled or unshared after resolution", async () => {
		mocks.integration
			.mockResolvedValueOnce({
				id: "example-integration",
				credentials: JSON.stringify({
					access_token: "example-token",
					refresh_token: "example-refresh",
				}),
			})
			.mockResolvedValueOnce(null);
		await expect(send()).rejects.toThrow(
			"connection is no longer authorized",
		);
		expect(mocks.integration).toHaveBeenLastCalledWith({
			where: {
				userId: "example-user",
				organizationId: "example-org",
				id: "example-integration",
				provider: "MICROSOFT_GRAPH",
				isActive: true,
			},
			select: { id: true },
		});
		expect(mocks.fetch).not.toHaveBeenCalled();
	});
	it("rechecks integration-use membership after token resolution", async () => {
		mocks.canUse.mockResolvedValueOnce(true).mockResolvedValueOnce(false);
		await expect(send()).rejects.toThrow(
			"connection is no longer authorized",
		);
		expect(mocks.fetch).not.toHaveBeenCalled();
	});
});
