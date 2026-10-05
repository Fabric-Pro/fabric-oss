/**
 * The MCP server tile's OAuth status for the GitLab personal servers reports
 * the person's GitLab connection exactly as every other GitLab screen does:
 * connected, needs reconnect (shown as such, not as "not connected"), or not
 * connected. Other OAuth servers keep reporting their own config's tokens.
 *
 * The GitLab read can write (it classifies a legacy connection row, or
 * refreshes its token), so the route answers only for an organization the
 * caller is a member of now, and with no organization it inspects the stored
 * connection without writing.
 */

import { NextRequest } from "next/server";
import { beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
	getSession: vi.fn(),
	findFirst: vi.fn(),
	getOrganizationMembership: vi.fn(),
	writingReads: [] as unknown[],
	inspections: [] as unknown[],
	summaryState: "connected" as
		| "connected"
		| "needs-reconnect"
		| "not-connected",
}));

vi.mock("@repo/auth", () => ({
	auth: { api: { getSession: mocks.getSession } },
}));

vi.mock("@repo/database", async () => ({
	db: { mCPConfig: { findFirst: mocks.findFirst } },
	getOrganizationMembership: mocks.getOrganizationMembership,
	...(await import(
		"../../../../../../../../../packages/database/prisma/queries/lib/gitlab-personal-keys"
	)),
}));

vi.mock("@repo/integrations/gitlab", () => {
	const status = () => ({
		connected: mocks.summaryState !== "not-connected",
		needsReauth: mocks.summaryState === "needs-reconnect",
		hasRefreshToken: mocks.summaryState !== "not-connected",
		tokenExpiresAt: null,
		generation: 1,
		settings: {},
	});
	const summary = () => ({
		state: mocks.summaryState,
		integrationId: null,
		origin: null,
		account: null,
	});
	return {
		getGitLabConnectionStatus: async () => status(),
		readGitLabPersonalConnection: async (tenant: unknown) => {
			mocks.writingReads.push(tenant);
			return { status: status(), summary: summary() };
		},
		readStoredGitLabConnectionStatus: async (tenant: unknown) => {
			mocks.inspections.push(tenant);
			return status();
		},
		summarizeGitLabConnection: () => summary(),
	};
});

import { GET } from "../route";

const request = (organizationId = "example-org") =>
	new NextRequest(
		`https://app.example.com/api/mcp/oauth/status/cfg-1?organizationId=${organizationId}`,
	);
const call = (organizationId?: string) =>
	GET(request(organizationId), {
		params: Promise.resolve({ configId: "cfg-1" }),
	});

const gitlabConfig = (key = "gitlab-official") => ({
	id: "cfg-1",
	authType: "OAUTH2",
	encryptedAccessToken: "enc:stale-copy",
	encryptedRefreshToken: null,
	tokenExpiresAt: null,
	needsReauth: false,
	mcpServer: { key },
});

beforeEach(() => {
	mocks.getSession.mockResolvedValue({ user: { id: "user-1" } });
	mocks.findFirst.mockReset();
	mocks.getOrganizationMembership.mockReset();
	mocks.getOrganizationMembership.mockResolvedValue({ role: "member" });
	mocks.writingReads.length = 0;
	mocks.inspections.length = 0;
});

describe("GET /api/mcp/oauth/status/[configId]", () => {
	describe.each(["gitlab", "gitlab-official"])("%s server", (key) => {
		beforeEach(() => {
			mocks.findFirst.mockResolvedValue({
				id: "cfg-1",
				authType: "OAUTH2",
				// A legacy token copy left on the row must not decide anything.
				encryptedAccessToken: "enc:stale-copy",
				encryptedRefreshToken: null,
				tokenExpiresAt: null,
				needsReauth: false,
				mcpServer: { key },
			});
		});

		it.each([
			["connected", { authenticated: true, needsReauth: false }],
			["needs-reconnect", { authenticated: false, needsReauth: true }],
			["not-connected", { authenticated: false, needsReauth: false }],
		] as const)(
			"reports the person's connection when it is %s",
			async (summaryState, expected) => {
				mocks.summaryState = summaryState;
				const body = await (await call()).json();
				expect(body.data).toMatchObject({
					...expected,
					connectionState: summaryState,
				});
			},
		);
	});

	it("looks the config up for the caller only, with the explicit organization", async () => {
		mocks.findFirst.mockResolvedValue(null);
		const response = await call();
		expect(response.status).toBe(404);
		expect(mocks.findFirst).toHaveBeenCalledWith(
			expect.objectContaining({
				where: {
					id: "cfg-1",
					userId: "user-1",
					organizationId: "example-org",
				},
			}),
		);
	});

	it("reports a non-GitLab server's own dead grant as needing a reconnect", async () => {
		mocks.findFirst.mockResolvedValue({
			id: "cfg-1",
			authType: "OAUTH2",
			encryptedAccessToken: "enc:token",
			encryptedRefreshToken: "enc:refresh",
			tokenExpiresAt: null,
			needsReauth: true,
			mcpServer: { key: "linear-remote" },
		});
		const body = await (await call()).json();
		expect(body.data).toMatchObject({
			authenticated: false,
			needsReauth: true,
		});
	});

	it("refuses an organization the caller is no longer a member of, before reading anything", async () => {
		mocks.getOrganizationMembership.mockResolvedValue(null);
		mocks.findFirst.mockResolvedValue(gitlabConfig());

		const response = await call("left-org");

		expect(response.status).toBe(403);
		expect(mocks.getOrganizationMembership).toHaveBeenCalledWith(
			"left-org",
			"user-1",
		);
		expect(mocks.findFirst).not.toHaveBeenCalled();
		expect(mocks.writingReads).toEqual([]);
	});

	it("reads a member's GitLab connection with the read that can write", async () => {
		mocks.summaryState = "connected";
		mocks.findFirst.mockResolvedValue(gitlabConfig());

		await call();

		expect(mocks.writingReads).toEqual([
			{ userId: "user-1", organizationId: "example-org" },
		]);
		expect(mocks.inspections).toEqual([]);
	});

	it("with no organization, inspects the GitLab connection without writing", async () => {
		mocks.summaryState = "connected";
		mocks.findFirst.mockResolvedValue(gitlabConfig());

		const body = await (await call("")).json();

		expect(body.data).toMatchObject({ connectionState: "connected" });
		expect(mocks.writingReads).toEqual([]);
		expect(mocks.inspections).toEqual([
			{ userId: "user-1", organizationId: null },
		]);
		expect(mocks.getOrganizationMembership).not.toHaveBeenCalled();
	});
});
