/**
 * Pins the recovery behaviour of `updateMcpConfigTokens` and
 * `clearRefreshFailures`. Writing a fresh access token (or clearing
 * refresh-failure state on a successful refresh) MUST reset
 * `status: "HEALTHY"` + `needsReauth: false` + failure counters,
 * otherwise the UI's MCP-server card stays red after a reconnect even
 * though the tokens are valid.
 *
 * See `.changeset/mcp-status-reset-on-token-write.md`.
 */

import { beforeEach, describe, expect, it, vi } from "vitest";

const updateMock = vi.fn();

vi.mock("../prisma/client", () => ({
	db: {
		mCPConfig: {
			update: (...args: unknown[]) => updateMock(...args),
		},
	},
}));

import {
	clearRefreshFailures,
	updateMcpConfigTokens,
} from "../prisma/queries/mcp";

describe("updateMcpConfigTokens — status reset on fresh tokens", () => {
	beforeEach(() => {
		updateMock.mockReset();
		updateMock.mockResolvedValue({ id: "cfg_1" });
	});

	it("resets status to HEALTHY when writing a non-null access token", async () => {
		await updateMcpConfigTokens({
			configId: "cfg_1",
			encryptedAccessToken: "ct:abc",
			accessTokenHash: "hash:abc",
		});

		expect(updateMock).toHaveBeenCalledTimes(1);
		const callArg = updateMock.mock.calls[0]?.[0] as {
			where: { id: string };
			data: Record<string, unknown>;
		};

		expect(callArg.where).toEqual({ id: "cfg_1" });
		expect(callArg.data).toMatchObject({
			encryptedAccessToken: "ct:abc",
			accessTokenHash: "hash:abc",
			status: "HEALTHY",
			needsReauth: false,
			refreshFailureCount: 0,
			lastRefreshFailedAt: null,
			lastRefreshError: null,
			consecutiveFailures: 0,
		});
	});

	it("does NOT touch status fields when clearing tokens (encryptedAccessToken === null)", async () => {
		await updateMcpConfigTokens({
			configId: "cfg_1",
			encryptedAccessToken: null,
			accessTokenHash: null,
		});

		expect(updateMock).toHaveBeenCalledTimes(1);
		const callArg = updateMock.mock.calls[0]?.[0] as {
			data: Record<string, unknown>;
		};

		expect(callArg.data.encryptedAccessToken).toBeNull();
		expect(callArg.data).not.toHaveProperty("status");
		expect(callArg.data).not.toHaveProperty("needsReauth");
		expect(callArg.data).not.toHaveProperty("refreshFailureCount");
	});

	it("includes refresh token + expiry when provided alongside fresh access token", async () => {
		const expires = new Date("2026-06-01T00:00:00Z");
		await updateMcpConfigTokens({
			configId: "cfg_1",
			encryptedAccessToken: "ct:abc",
			accessTokenHash: "hash:abc",
			encryptedRefreshToken: "rt:xyz",
			tokenExpiresAt: expires,
		});

		const callArg = updateMock.mock.calls[0]?.[0] as {
			data: Record<string, unknown>;
		};
		expect(callArg.data).toMatchObject({
			encryptedRefreshToken: "rt:xyz",
			tokenExpiresAt: expires,
			status: "HEALTHY",
		});
	});
});

describe("clearRefreshFailures — symmetric status restore", () => {
	beforeEach(() => {
		updateMock.mockReset();
		updateMock.mockResolvedValue({ id: "cfg_1" });
	});

	it("resets status to HEALTHY + failure counters + needsReauth: false", async () => {
		await clearRefreshFailures("cfg_1");

		expect(updateMock).toHaveBeenCalledTimes(1);
		const callArg = updateMock.mock.calls[0]?.[0] as {
			where: { id: string };
			data: Record<string, unknown>;
		};

		expect(callArg.where).toEqual({ id: "cfg_1" });
		expect(callArg.data).toMatchObject({
			refreshFailureCount: 0,
			lastRefreshFailedAt: null,
			lastRefreshError: null,
			needsReauth: false,
			status: "HEALTHY",
			consecutiveFailures: 0,
		});
	});
});
