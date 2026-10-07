/**
 * `revokeOAuthTokens` clears a config's own OAuth tokens AND its chained
 * Atlassian Cloud tokens in ONE update, owner-scoped with the exclusive
 * tenant filter. Two separate updates could fail between them and leave the
 * chained tokens stored on a config the MCP tile then shows as revoked.
 */

import { beforeEach, describe, expect, it, vi } from "vitest";

const updateMock = vi.fn();
const updateManyMock = vi.fn();
const findUniqueMock = vi.fn();
const findManyMock = vi.fn();

vi.mock("../prisma/client", () => ({
	Prisma: { DbNull: "DbNull" },
	db: {
		mCPConfig: {
			update: (...args: unknown[]) => updateMock(...args),
			updateMany: (...args: unknown[]) => updateManyMock(...args),
			findUnique: (...args: unknown[]) => findUniqueMock(...args),
			findMany: (...args: unknown[]) => findManyMock(...args),
		},
	},
}));

import {
	revokeAllOrgOAuthTokens,
	revokeAllUserOAuthTokens,
	revokeOAuthTokens,
} from "../prisma/queries/mcp";

beforeEach(() => {
	updateMock.mockReset();
	updateManyMock.mockReset();
	updateManyMock.mockResolvedValue({ count: 1 });
	// The wipe reads the client it keeps (to fingerprint the binding it
	// keeps, and to fence on); a bulk wipe that keeps bindings goes row by
	// row.
	findUniqueMock.mockReset();
	findUniqueMock.mockResolvedValue({
		oauthClientId: "client-1",
		encryptedOauthClientSecret: "ct:secret",
		encryptedRefreshToken: "ct:refresh",
		oauthBinding: null,
	});
	findManyMock.mockReset();
	findManyMock.mockImplementation(async (args: { where: object }) => [
		{ id: `row-for-${JSON.stringify(args.where)}` },
	]);
});

describe("revokeOAuthTokens", () => {
	it("clears the server's tokens and the chained Atlassian Cloud tokens in one write", async () => {
		await revokeOAuthTokens("cfg_1", {
			userId: "user-1",
			organizationId: "example-org",
		});

		expect(updateMock).not.toHaveBeenCalled();
		expect(updateManyMock).toHaveBeenCalledTimes(1);
		const { data } = updateManyMock.mock.calls[0]?.[0] as {
			data: Record<string, unknown>;
		};
		expect(data).toMatchObject({
			encryptedAccessToken: null,
			accessTokenHash: null,
			encryptedRefreshToken: null,
			tokenExpiresAt: null,
			status: "UNAVAILABLE",
			encryptedAtlassianCloudAccessToken: null,
			encryptedAtlassianCloudRefreshToken: null,
			atlassianCloudTokenExpiresAt: null,
		});
	});

	it("matches only the owner's config in that organization", async () => {
		await revokeOAuthTokens("cfg_1", {
			userId: "user-1",
			organizationId: "example-org",
		});

		expect(updateManyMock.mock.calls[0]?.[0]).toMatchObject({
			where: {
				id: "cfg_1",
				userId: "user-1",
				organizationId: "example-org",
			},
		});
	});

	it("reports how many rows it changed, so another tenant's id changes nothing visibly", async () => {
		updateManyMock.mockResolvedValue({ count: 0 });

		await expect(
			revokeOAuthTokens("cfg_other", {
				userId: "user-1",
				organizationId: "example-org",
			}),
		).resolves.toBe(0);
	});
});

describe("revocation moves the grant generation", () => {
	it("so a refresh already in flight cannot write the revoked tokens back", async () => {
		await revokeOAuthTokens("cfg_1", {
			userId: "user-1",
			organizationId: "example-org",
		});

		const { data } = updateManyMock.mock.calls[0]?.[0] as {
			data: Record<string, unknown>;
		};
		expect(data.oauthGrantGeneration).toEqual({ increment: 1 });
		// The binding stays: only the connect flow rebinds.
		expect(data).not.toHaveProperty("oauthBinding");
	});

	it("for the bulk personal and organization revocations too", async () => {
		await revokeAllUserOAuthTokens("user-1");
		await revokeAllOrgOAuthTokens("example-org");

		// Each selects its tenant's OAuth configs, then wipes them one by one.
		expect(findManyMock.mock.calls[0]?.[0].where).toMatchObject({
			userId: "user-1",
			organizationId: null,
			authType: "OAUTH2",
		});
		expect(findManyMock.mock.calls[1]?.[0].where).toMatchObject({
			organizationId: "example-org",
			authType: "OAUTH2",
		});
		expect(updateManyMock).toHaveBeenCalledTimes(2);
		for (const call of updateManyMock.mock.calls) {
			const { data } = call[0] as {
				where: Record<string, unknown>;
				data: Record<string, unknown>;
			};
			expect(data).toMatchObject({
				encryptedAccessToken: null,
				accessTokenHash: null,
				encryptedRefreshToken: null,
				status: "UNAVAILABLE",
				oauthGrantGeneration: { increment: 1 },
			});
		}
		expect(updateManyMock.mock.calls[0]?.[0].where).toMatchObject({
			id: expect.stringContaining('"userId":"user-1"'),
		});
		expect(updateManyMock.mock.calls[1]?.[0].where).toMatchObject({
			id: expect.stringContaining('"organizationId":"example-org"'),
		});
	});
});
