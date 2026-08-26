import { beforeEach, describe, expect, it, vi } from "vitest";

// db is mocked structurally — only the methods the helper uses.
vi.mock("@repo/database", () => ({
	db: {
		workflowIntegration: {
			findFirst: vi.fn(),
			update: vi.fn(),
		},
	},
}));

// Crypto helpers are identity-ish stubs; decrypt returns whatever the test
// queued via the hoisted `state.decryptedPayload`. Hoisted so the vi.mock
// factory can reference it without TDZ issues.
const state = vi.hoisted(() => ({ decryptedPayload: "" }));
vi.mock("@repo/utils", () => ({
	decryptApiKey: vi.fn(() => state.decryptedPayload),
	encryptApiKey: vi.fn((s: string) => `enc:${s}`),
}));

// Stub the GOOGLE_DRIVE provider's refreshAccessToken so the refresh path is
// deterministic and never hits the network. Declared via vi.hoisted so it is
// initialized before the hoisted vi.mock factory references it.
const { refreshAccessToken } = vi.hoisted(() => ({
	refreshAccessToken: vi.fn(),
}));
vi.mock("../oauth-providers", () => ({
	oauthProviders: {
		GOOGLE_DRIVE: {
			type: "GOOGLE_DRIVE",
			name: "Google Drive",
			refreshAccessToken,
		},
	},
}));

import { db } from "@repo/database";
import {
	GoogleDriveNotConnectedError,
	GoogleDriveTokenExpiredError,
	getGoogleDriveAccessToken,
} from "../google-drive-token";

const findFirst = db.workflowIntegration.findFirst as ReturnType<typeof vi.fn>;
const update = db.workflowIntegration.update as ReturnType<typeof vi.fn>;

function creds(overrides: Record<string, unknown> = {}): string {
	return JSON.stringify({
		access_token: "valid-token",
		refresh_token: "refresh-token",
		scope: "drive.readonly",
		token_obtained_at: new Date().toISOString(),
		expires_in: 3600,
		...overrides,
	});
}

describe("getGoogleDriveAccessToken", () => {
	beforeEach(() => {
		findFirst.mockReset();
		update.mockReset();
		refreshAccessToken.mockReset();
		process.env.GOOGLE_CLIENT_ID = "client-id";
		process.env.GOOGLE_CLIENT_SECRET = "client-secret";
	});

	it("throws GoogleDriveNotConnectedError when no integration row exists", async () => {
		findFirst.mockResolvedValue(null);
		await expect(
			getGoogleDriveAccessToken({
				userId: "u1",
				organizationId: undefined,
			}),
		).rejects.toBeInstanceOf(GoogleDriveNotConnectedError);
	});

	it("throws GoogleDriveNotConnectedError when the row has no credentials", async () => {
		findFirst.mockResolvedValue({
			id: "i1",
			credentials: "",
			settings: {},
		});
		await expect(
			getGoogleDriveAccessToken({
				userId: "u1",
				organizationId: undefined,
			}),
		).rejects.toBeInstanceOf(GoogleDriveNotConnectedError);
	});

	it("returns the decrypted access token when not expired", async () => {
		state.decryptedPayload = creds();
		findFirst.mockResolvedValue({
			id: "i1",
			credentials: "encrypted",
			settings: {},
		});
		const token = await getGoogleDriveAccessToken({
			userId: "u1",
			organizationId: undefined,
		});
		expect(token).toBe("valid-token");
		expect(update).not.toHaveBeenCalled();
	});

	it("queries with org filter scoped to the calling user (PR-2 regression)", async () => {
		// A Google connection is personal even in org context: the callback
		// stores one row per (userId, organizationId). The org query MUST keep
		// userId, or findFirst could return another member's connection and
		// expose their private Docs. See PR-2 in card #1397.
		state.decryptedPayload = creds();
		findFirst.mockResolvedValue({
			id: "i1",
			credentials: "encrypted",
			settings: {},
		});
		await getGoogleDriveAccessToken({
			userId: "u1",
			organizationId: "org1",
		});
		expect(findFirst).toHaveBeenCalledWith(
			expect.objectContaining({
				where: expect.objectContaining({
					userId: "u1",
					organizationId: "org1",
					provider: "GOOGLE_DRIVE",
					isActive: true,
				}),
			}),
		);
	});

	it("queries with personal (organizationId: null) filter when none provided", async () => {
		state.decryptedPayload = creds();
		findFirst.mockResolvedValue({
			id: "i1",
			credentials: "encrypted",
			settings: {},
		});
		await getGoogleDriveAccessToken({
			userId: "u1",
			organizationId: undefined,
		});
		expect(findFirst).toHaveBeenCalledWith(
			expect.objectContaining({
				where: expect.objectContaining({
					userId: "u1",
					organizationId: null,
					provider: "GOOGLE_DRIVE",
					isActive: true,
				}),
			}),
		);
	});

	it("refreshes and persists a new token when expired", async () => {
		state.decryptedPayload = creds({
			token_obtained_at: new Date(Date.now() - 7_200_000).toISOString(),
			expires_in: 3600,
		});
		findFirst.mockResolvedValue({
			id: "i1",
			credentials: "encrypted",
			settings: {},
		});
		refreshAccessToken.mockResolvedValue({
			access_token: "fresh-token",
			expires_in: 3600,
		});
		update.mockResolvedValue({});

		const token = await getGoogleDriveAccessToken({
			userId: "u1",
			organizationId: undefined,
		});

		expect(token).toBe("fresh-token");
		expect(refreshAccessToken).toHaveBeenCalledWith(
			"refresh-token",
			"client-id",
			"client-secret",
		);
		expect(update).toHaveBeenCalledWith(
			expect.objectContaining({ where: { id: "i1" } }),
		);
	});

	it("throws GoogleDriveTokenExpiredError when expired and no refresh token", async () => {
		state.decryptedPayload = creds({
			refresh_token: undefined,
			token_obtained_at: new Date(Date.now() - 7_200_000).toISOString(),
			expires_in: 3600,
		});
		findFirst.mockResolvedValue({
			id: "i1",
			credentials: "encrypted",
			settings: {},
		});
		await expect(
			getGoogleDriveAccessToken({
				userId: "u1",
				organizationId: undefined,
			}),
		).rejects.toBeInstanceOf(GoogleDriveTokenExpiredError);
	});

	it("throws GoogleDriveTokenExpiredError when refresh fails", async () => {
		state.decryptedPayload = creds({
			token_obtained_at: new Date(Date.now() - 7_200_000).toISOString(),
			expires_in: 3600,
		});
		findFirst.mockResolvedValue({
			id: "i1",
			credentials: "encrypted",
			settings: {},
		});
		refreshAccessToken.mockRejectedValue(new Error("boom"));
		await expect(
			getGoogleDriveAccessToken({
				userId: "u1",
				organizationId: undefined,
			}),
		).rejects.toBeInstanceOf(GoogleDriveTokenExpiredError);
	});

	it("falls back to settings.tokenExpiresAt when credentials lack expires_in", async () => {
		// No expires_in in credentials; expiry lives in settings (ISO string).
		state.decryptedPayload = creds({
			expires_in: undefined,
			token_obtained_at: undefined,
		});
		findFirst.mockResolvedValue({
			id: "i1",
			credentials: "encrypted",
			settings: {
				tokenExpiresAt: new Date(Date.now() - 1000).toISOString(),
			},
		});
		refreshAccessToken.mockResolvedValue({
			access_token: "fresh-token",
			expires_in: 3600,
		});
		update.mockResolvedValue({});
		const token = await getGoogleDriveAccessToken({
			userId: "u1",
			organizationId: undefined,
		});
		expect(token).toBe("fresh-token");
	});
});
