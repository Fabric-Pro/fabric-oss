/**
 * `revokeOAuthTokens` clears a config's own OAuth tokens AND its chained
 * Atlassian Cloud tokens in ONE update, owner-scoped with the exclusive
 * tenant filter. Two separate updates could fail between them and leave the
 * chained tokens stored on a config the MCP tile then shows as revoked.
 */

import { beforeEach, describe, expect, it, vi } from "vitest";

const updateMock = vi.fn();
const updateManyMock = vi.fn();

vi.mock("../prisma/client", () => ({
	Prisma: { DbNull: "DbNull" },
	db: {
		mCPConfig: {
			update: (...args: unknown[]) => updateMock(...args),
			updateMany: (...args: unknown[]) => updateManyMock(...args),
		},
	},
}));

import { revokeOAuthTokens } from "../prisma/queries/mcp";

beforeEach(() => {
	updateMock.mockReset();
	updateManyMock.mockReset();
	updateManyMock.mockResolvedValue({ count: 1 });
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
