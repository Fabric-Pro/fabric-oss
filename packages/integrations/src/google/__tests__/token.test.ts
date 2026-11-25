import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

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

import { db } from "@repo/database";
import {
	GoogleDriveNotConnectedError,
	GoogleDriveTokenExpiredError,
	getGoogleDriveAccessToken,
	hasGoogleDriveReadonlyScope,
	isGoogleDriveNotConnectedError,
} from "../token";

const findFirst = db.workflowIntegration.findFirst as ReturnType<typeof vi.fn>;
const update = db.workflowIntegration.update as ReturnType<typeof vi.fn>;
const fetchMock = vi.fn();

const DRIVE_READONLY = "https://www.googleapis.com/auth/drive.readonly";
const DRIVE_FILE = "https://www.googleapis.com/auth/drive.file";

function creds(overrides: Record<string, unknown> = {}): string {
	return JSON.stringify({
		access_token: "valid-token",
		refresh_token: "refresh-token",
		scope: `${DRIVE_READONLY} ${DRIVE_FILE}`,
		token_obtained_at: new Date().toISOString(),
		expires_in: 3600,
		...overrides,
	});
}

const expired = {
	token_obtained_at: new Date(Date.now() - 7_200_000).toISOString(),
	expires_in: 3600,
};

function row() {
	return { id: "i1", credentials: "encrypted", settings: {} };
}

function tokenAnswer(status: number, body: unknown): Response {
	return new Response(JSON.stringify(body), {
		status,
		headers: { "Content-Type": "application/json" },
	});
}

beforeEach(() => {
	findFirst.mockReset();
	update.mockReset();
	fetchMock.mockReset();
	vi.stubGlobal("fetch", fetchMock);
	vi.spyOn(console, "error").mockImplementation(() => {});
	process.env.GOOGLE_CLIENT_ID = "client-id";
	process.env.GOOGLE_CLIENT_SECRET = "client-secret";
});

afterEach(() => {
	vi.unstubAllGlobals();
	vi.restoreAllMocks();
});

describe("getGoogleDriveAccessToken", () => {
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

	it("returns the stored token without a refresh while it is valid for more than 60 s", async () => {
		state.decryptedPayload = creds({
			token_obtained_at: new Date(Date.now() - 3_500_000).toISOString(),
			expires_in: 3600,
		});
		findFirst.mockResolvedValue(row());
		const token = await getGoogleDriveAccessToken({
			userId: "u1",
			organizationId: undefined,
		});
		expect(token).toBe("valid-token");
		expect(fetchMock).not.toHaveBeenCalled();
		expect(update).not.toHaveBeenCalled();
	});

	it("queries with org filter scoped to the calling user (PR-2 regression)", async () => {
		// A Google connection is personal even in org context: the callback
		// stores one row per (userId, organizationId). The org query MUST keep
		// userId, or findFirst could return another member's connection and
		// expose their private Docs. See PR-2 in card #1397.
		state.decryptedPayload = creds();
		findFirst.mockResolvedValue(row());
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
		findFirst.mockResolvedValue(row());
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

	it("reads the given connection only, still as the calling user in their organization", async () => {
		state.decryptedPayload = creds();
		findFirst.mockResolvedValue(row());
		await getGoogleDriveAccessToken({
			userId: "u1",
			organizationId: "org1",
			connectionId: "conn-1",
		});
		expect(findFirst).toHaveBeenCalledWith({
			where: {
				id: "conn-1",
				userId: "u1",
				organizationId: "org1",
				provider: "GOOGLE_DRIVE",
				isActive: true,
				NOT: { name: "GOOGLE_DRIVE_OAUTH_APP" },
			},
		});
	});

	it("never takes the OAuth-app row as a connection", async () => {
		state.decryptedPayload = creds();
		findFirst.mockResolvedValue(row());
		await getGoogleDriveAccessToken({
			userId: "u1",
			organizationId: "org1",
		});
		expect(findFirst).toHaveBeenCalledWith(
			expect.objectContaining({
				where: expect.objectContaining({
					NOT: { name: "GOOGLE_DRIVE_OAUTH_APP" },
				}),
			}),
		);
	});

	it("refreshes a token about to expire once, and stores the new token and expiry encrypted", async () => {
		state.decryptedPayload = creds({
			token_obtained_at: new Date(Date.now() - 3_570_000).toISOString(),
			expires_in: 3600,
		});
		findFirst.mockResolvedValue(row());
		fetchMock.mockResolvedValue(
			tokenAnswer(200, {
				access_token: "fresh-token",
				token_type: "Bearer",
				expires_in: 3600,
			}),
		);
		update.mockResolvedValue({});

		const token = await getGoogleDriveAccessToken({
			userId: "u1",
			organizationId: "org1",
			connectionId: "i1",
		});

		expect(token).toBe("fresh-token");
		expect(fetchMock).toHaveBeenCalledTimes(1);
		const [url, init] = fetchMock.mock.calls[0] as [string, RequestInit];
		expect(url).toBe("https://oauth2.googleapis.com/token");
		expect(Object.fromEntries(init.body as URLSearchParams)).toEqual({
			client_id: "client-id",
			client_secret: "client-secret",
			refresh_token: "refresh-token",
			grant_type: "refresh_token",
		});

		expect(update).toHaveBeenCalledTimes(1);
		const { where, data } = update.mock.calls[0][0] as {
			where: { id: string };
			data: { credentials: string; settings: { tokenExpiresAt: string } };
		};
		expect(where).toEqual({ id: "i1" });
		expect(data.credentials.startsWith("enc:")).toBe(true);
		const stored = JSON.parse(data.credentials.slice("enc:".length));
		expect(stored).toMatchObject({
			access_token: "fresh-token",
			// Google's refresh answer omits the refresh token; it is kept.
			refresh_token: "refresh-token",
			expires_in: 3600,
		});
		const expiresAt = Date.parse(data.settings.tokenExpiresAt);
		expect(expiresAt - Date.now()).toBeGreaterThan(3_500_000);
	});

	it("refreshes with the organization's own Google OAuth app when the environment has none", async () => {
		delete process.env.GOOGLE_CLIENT_ID;
		delete process.env.GOOGLE_CLIENT_SECRET;
		state.decryptedPayload = creds(expired);
		const { decryptApiKey } = await import("@repo/utils");
		(decryptApiKey as ReturnType<typeof vi.fn>).mockImplementation(
			(value: string) =>
				value === "app-encrypted"
					? JSON.stringify({
							client_id: "org-client",
							client_secret: "org-secret",
						})
					: state.decryptedPayload,
		);
		findFirst
			.mockResolvedValueOnce(row())
			.mockResolvedValueOnce({ credentials: "app-encrypted" });
		fetchMock.mockResolvedValue(
			tokenAnswer(200, { access_token: "fresh-token", expires_in: 3600 }),
		);
		update.mockResolvedValue({});

		const token = await getGoogleDriveAccessToken({
			userId: "u1",
			organizationId: "org1",
			connectionId: "i1",
		});

		expect(token).toBe("fresh-token");
		expect(findFirst.mock.calls[1][0]).toEqual({
			where: {
				organizationId: "org1",
				provider: "GOOGLE_DRIVE",
				name: "GOOGLE_DRIVE_OAUTH_APP",
				isActive: true,
			},
			select: { credentials: true },
		});
		const [, init] = fetchMock.mock.calls[0] as [string, RequestInit];
		expect(Object.fromEntries(init.body as URLSearchParams)).toMatchObject({
			client_id: "org-client",
			client_secret: "org-secret",
		});
	});

	it("does not borrow another tenant's app: with no env and no own app row the token is expired", async () => {
		delete process.env.GOOGLE_CLIENT_ID;
		delete process.env.GOOGLE_CLIENT_SECRET;
		state.decryptedPayload = creds(expired);
		findFirst.mockResolvedValueOnce(row()).mockResolvedValue(null);

		await expect(
			getGoogleDriveAccessToken({
				userId: "u1",
				organizationId: undefined,
			}),
		).rejects.toBeInstanceOf(GoogleDriveTokenExpiredError);
		// Personal scope only: the user's own app row, never an unscoped one.
		expect(findFirst.mock.calls[1][0]).toEqual({
			where: {
				userId: "u1",
				organizationId: null,
				provider: "GOOGLE_DRIVE",
				name: "GOOGLE_DRIVE_OAUTH_APP",
				isActive: true,
			},
			select: { credentials: true },
		});
		expect(fetchMock).not.toHaveBeenCalled();
	});

	it("throws GoogleDriveTokenExpiredError when expired and no refresh token", async () => {
		state.decryptedPayload = creds({
			...expired,
			refresh_token: undefined,
		});
		findFirst.mockResolvedValue(row());
		await expect(
			getGoogleDriveAccessToken({
				userId: "u1",
				organizationId: undefined,
			}),
		).rejects.toBeInstanceOf(GoogleDriveTokenExpiredError);
	});

	it("throws GoogleDriveTokenExpiredError when Google rejects the refresh with invalid_grant", async () => {
		state.decryptedPayload = creds(expired);
		findFirst.mockResolvedValue(row());
		fetchMock.mockResolvedValue(
			tokenAnswer(400, {
				error: "invalid_grant",
				error_description: "Token has been expired or revoked.",
			}),
		);
		await expect(
			getGoogleDriveAccessToken({
				userId: "u1",
				organizationId: undefined,
			}),
		).rejects.toBeInstanceOf(GoogleDriveTokenExpiredError);
		expect(update).not.toHaveBeenCalled();
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
		fetchMock.mockResolvedValue(
			tokenAnswer(200, {
				access_token: "fresh-token",
				token_type: "Bearer",
				expires_in: 3600,
			}),
		);
		update.mockResolvedValue({});
		const token = await getGoogleDriveAccessToken({
			userId: "u1",
			organizationId: undefined,
		});
		expect(token).toBe("fresh-token");
	});
});

describe("hasGoogleDriveReadonlyScope", () => {
	const input = { userId: "u1", organizationId: "org1", connectionId: "i1" };

	it("is true for a grant listing drive.readonly", async () => {
		state.decryptedPayload = creds({ scope: `${DRIVE_READONLY} openid` });
		findFirst.mockResolvedValue(row());
		await expect(hasGoogleDriveReadonlyScope(input)).resolves.toBe(true);
	});

	it("is false for a grant with only drive.file", async () => {
		state.decryptedPayload = creds({ scope: `${DRIVE_FILE} openid` });
		findFirst.mockResolvedValue(row());
		await expect(hasGoogleDriveReadonlyScope(input)).resolves.toBe(false);
	});

	it("is false when the connection is gone", async () => {
		findFirst.mockResolvedValue(null);
		await expect(hasGoogleDriveReadonlyScope(input)).resolves.toBe(false);
	});
});

describe("isGoogleDriveNotConnectedError", () => {
	it("recognises both connection errors by message", () => {
		expect(
			isGoogleDriveNotConnectedError(
				new GoogleDriveNotConnectedError().message,
			),
		).toBe(true);
		expect(
			isGoogleDriveNotConnectedError(
				new GoogleDriveTokenExpiredError().message,
			),
		).toBe(true);
	});

	it("does not match an unrelated error", () => {
		expect(
			isGoogleDriveNotConnectedError("Google Drive answered 500"),
		).toBe(false);
	});
});
