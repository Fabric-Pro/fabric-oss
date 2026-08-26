/**
 * Unit tests for `googleDocsPickerSessionProcedure` — mints the credentials a
 * browser needs to open the Google Picker for selecting Docs.
 *
 * Strategy mirrors `add-google-docs-context.test.ts`: mock the
 * `../../../../orpc/procedures` builder so `.use/.route/.input/.output/
 * .handler` collapse to `{ handler }`, declare the Drive error classes via
 * `vi.hoisted`, then call `.handler({ input, context })` directly.
 *
 * Covers the four states the dialog branches on:
 *   - not configured (env vars missing) → error, no token
 *   - not connected (no integration row) → error, no token
 *   - connected under legacy `drive.readonly` only → `requiresReconnect: true`
 *   - fully connected with `drive.file` → token + developerKey + appId
 */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const {
	mockHasProjectAccess,
	mockGetGoogleDriveAccessToken,
	mockDecryptApiKey,
	mockFindFirstIntegration,
	mockFindUniqueIntegration,
	GoogleDriveNotConnectedError,
	GoogleDriveTokenExpiredError,
} = vi.hoisted(() => {
	class GoogleDriveNotConnectedError extends Error {
		constructor() {
			super("Google account not connected");
			this.name = "GoogleDriveNotConnectedError";
		}
	}
	class GoogleDriveTokenExpiredError extends Error {
		constructor() {
			super("Google session expired");
			this.name = "GoogleDriveTokenExpiredError";
		}
	}
	return {
		mockHasProjectAccess: vi.fn(),
		mockGetGoogleDriveAccessToken: vi.fn(),
		mockDecryptApiKey: vi.fn(),
		mockFindFirstIntegration: vi.fn(),
		mockFindUniqueIntegration: vi.fn(),
		GoogleDriveNotConnectedError,
		GoogleDriveTokenExpiredError,
	};
});

vi.mock("@repo/database", async (importOriginal) => {
	const actual = await importOriginal<typeof import("@repo/database")>();
	return {
		...actual,
		hasProjectAccess: mockHasProjectAccess,
		db: {
			workflowIntegration: {
				findFirst: mockFindFirstIntegration,
				findUnique: mockFindUniqueIntegration,
			},
		},
	};
});

vi.mock("@repo/utils", () => ({
	decryptApiKey: mockDecryptApiKey,
}));

vi.mock("../../../../integrations/lib/google-drive-token", () => ({
	getGoogleDriveAccessToken: mockGetGoogleDriveAccessToken,
	GoogleDriveNotConnectedError,
	GoogleDriveTokenExpiredError,
}));

vi.mock("../../../../../orpc/procedures", () => {
	const builder: Record<string, unknown> = {};
	builder.use = () => builder;
	builder.route = () => builder;
	builder.input = () => builder;
	builder.output = () => builder;
	builder.handler = (fn: unknown) => ({ handler: fn });
	return {
		tenantProtectedProcedure: builder,
		resolveOrganizationId: (
			input: string | null | undefined,
			session: { activeOrganizationId?: string | null },
		) => {
			if (input) {
				return input;
			}
			if (input === null) {
				return undefined;
			}
			return session?.activeOrganizationId ?? undefined;
		},
		Permissions: new Proxy({}, { get: (_t, p) => String(p) }),
		requirePermission: () => (c: unknown) => c,
		requireProjectPermission: () => (c: unknown) => c,
	};
});

type Result = {
	isConnected: boolean;
	requiresReconnect: boolean;
	accessToken: string | null;
	developerKey: string | null;
	appId: string | null;
	expiresAt: number | null;
	error: string | null;
};

type Handler = (args: {
	input: { projectId: string; organizationId?: string | null };
	context: {
		user: { id: string };
		session: { activeOrganizationId?: string };
	};
}) => Promise<Result>;

async function loadHandler(): Promise<Handler> {
	const mod = await import("../google-docs-picker-session");
	return (
		mod.googleDocsPickerSessionProcedure as unknown as { handler: Handler }
	).handler;
}

const personalCtx = {
	user: { id: "user-1" },
	session: { activeOrganizationId: undefined },
};

const originalDeveloperKey = process.env.GOOGLE_PICKER_DEVELOPER_KEY;
const originalAppId = process.env.GOOGLE_PICKER_APP_ID;

beforeEach(() => {
	vi.clearAllMocks();
	mockHasProjectAccess.mockResolvedValue(true);
	process.env.GOOGLE_PICKER_DEVELOPER_KEY = "dev-key-xyz";
	process.env.GOOGLE_PICKER_APP_ID = "1234567890";
});

afterEach(() => {
	if (originalDeveloperKey === undefined) {
		delete process.env.GOOGLE_PICKER_DEVELOPER_KEY;
	} else {
		process.env.GOOGLE_PICKER_DEVELOPER_KEY = originalDeveloperKey;
	}
	if (originalAppId === undefined) {
		delete process.env.GOOGLE_PICKER_APP_ID;
	} else {
		process.env.GOOGLE_PICKER_APP_ID = originalAppId;
	}
});

describe("googleDocsPickerSession", () => {
	it("returns a misconfiguration error when Picker env vars are missing", async () => {
		delete process.env.GOOGLE_PICKER_DEVELOPER_KEY;
		const handler = await loadHandler();
		const result = await handler({
			input: { projectId: "p1" },
			context: personalCtx,
		});
		expect(result.isConnected).toBe(false);
		expect(result.accessToken).toBeNull();
		expect(result.error).toMatch(/picker is not configured/i);
		// We never even look at the user's row when env is missing
		expect(mockFindFirstIntegration).not.toHaveBeenCalled();
	});

	it("returns not-connected when there is no integration row", async () => {
		mockFindFirstIntegration.mockResolvedValue(null);
		const handler = await loadHandler();
		const result = await handler({
			input: { projectId: "p1" },
			context: personalCtx,
		});
		expect(result.isConnected).toBe(false);
		expect(result.requiresReconnect).toBe(false);
		expect(result.accessToken).toBeNull();
		expect(result.error).toMatch(/connect/i);
	});

	it("returns requiresReconnect when the granted scope is legacy drive.readonly", async () => {
		mockFindFirstIntegration.mockResolvedValue({
			id: "i1",
			credentials: "enc",
		});
		mockDecryptApiKey.mockReturnValue(
			JSON.stringify({
				access_token: "old",
				scope: "https://www.googleapis.com/auth/drive.readonly https://www.googleapis.com/auth/userinfo.email",
			}),
		);
		const handler = await loadHandler();
		const result = await handler({
			input: { projectId: "p1" },
			context: personalCtx,
		});
		expect(result.isConnected).toBe(true);
		expect(result.requiresReconnect).toBe(true);
		expect(result.accessToken).toBeNull();
		expect(result.developerKey).toBeNull();
		// We never bother minting a token under the wrong scope
		expect(mockGetGoogleDriveAccessToken).not.toHaveBeenCalled();
	});

	it("returns a full session when drive.file is granted", async () => {
		const tokenExpiresAt = "2026-12-31T00:00:00Z";
		mockFindFirstIntegration.mockResolvedValue({
			id: "i1",
			credentials: "enc",
		});
		mockDecryptApiKey.mockReturnValue(
			JSON.stringify({
				access_token: "current",
				scope: "https://www.googleapis.com/auth/drive.file https://www.googleapis.com/auth/userinfo.email",
			}),
		);
		mockGetGoogleDriveAccessToken.mockResolvedValue("fresh-token");
		mockFindUniqueIntegration.mockResolvedValue({
			settings: { tokenExpiresAt },
		});

		const handler = await loadHandler();
		const result = await handler({
			input: { projectId: "p1" },
			context: personalCtx,
		});
		expect(result.isConnected).toBe(true);
		expect(result.requiresReconnect).toBe(false);
		expect(result.accessToken).toBe("fresh-token");
		expect(result.developerKey).toBe("dev-key-xyz");
		expect(result.appId).toBe("1234567890");
		expect(result.expiresAt).toBe(Date.parse(tokenExpiresAt));
	});

	it("surfaces token expiry as requiresReconnect", async () => {
		mockFindFirstIntegration.mockResolvedValue({
			id: "i1",
			credentials: "enc",
		});
		mockDecryptApiKey.mockReturnValue(
			JSON.stringify({
				access_token: "current",
				scope: "https://www.googleapis.com/auth/drive.file",
			}),
		);
		mockGetGoogleDriveAccessToken.mockRejectedValue(
			new GoogleDriveTokenExpiredError(),
		);

		const handler = await loadHandler();
		const result = await handler({
			input: { projectId: "p1" },
			context: personalCtx,
		});
		expect(result.requiresReconnect).toBe(true);
		expect(result.accessToken).toBeNull();
		expect(result.error).toMatch(/session expired/i);
	});

	it("denies the request when the caller has no access to the project", async () => {
		mockHasProjectAccess.mockResolvedValue(false);
		const handler = await loadHandler();
		const result = await handler({
			input: { projectId: "p1" },
			context: personalCtx,
		});
		expect(result.isConnected).toBe(false);
		expect(result.error).toMatch(/don't have access/i);
		// Never touches the integration row under denial
		expect(mockFindFirstIntegration).not.toHaveBeenCalled();
	});
});
