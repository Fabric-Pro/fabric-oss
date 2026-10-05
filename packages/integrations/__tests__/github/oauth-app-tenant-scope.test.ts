import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const { findFirst, transaction, refreshOAuthToken } = vi.hoisted(() => ({
	findFirst: vi.fn(),
	transaction: vi.fn(),
	refreshOAuthToken: vi.fn(),
}));

vi.mock("@repo/database", () => ({
	db: { workflowIntegration: { findFirst }, $transaction: transaction },
}));
vi.mock("@repo/database/prisma/queries/lib/refresh-lock", () => ({
	withRefreshLock: (
		_key: string,
		callback: (tx: unknown, budget: () => void) => unknown,
	) => transaction((tx: unknown) => callback(tx, () => {})),
}));
vi.mock("@repo/utils", () => ({
	decryptApiKey: (value: string) => value,
	encryptApiKey: (value: string) => value,
}));
vi.mock("@repo/utils/oauth-refresh", () => ({
	refreshOAuthToken,
	sanitizeCredential: (value: string) => value.trim(),
}));

import {
	getGitHubAccessToken,
	refreshProjectRepoGitHubTokenWithOutcome,
} from "../../src/github";

const expiredCredentials = JSON.stringify({
	access_token: "stale-access",
	refresh_token: "caller-refresh",
	expires_in: 1,
	token_obtained_at: "2026-01-01T00:00:00Z",
});

interface Row {
	id: string;
	userId: string;
	organizationId: string | null;
	provider: string;
	name: string;
	isActive: boolean;
	credentials: string;
}

let rows: Row[];

function app(
	userId: string,
	organizationId: string | null,
	clientId: string,
): Row {
	return {
		id: clientId,
		userId,
		organizationId,
		provider: "GITHUB",
		name: "GITHUB_OAUTH_APP",
		isActive: true,
		credentials: JSON.stringify({
			client_id: clientId,
			client_secret: `${clientId}-secret`,
		}),
	};
}

beforeEach(() => {
	vi.clearAllMocks();
	vi.stubEnv("FABRIC_GITHUB_CLIENT_ID", "");
	vi.stubEnv("FABRIC_GITHUB_CLIENT_SECRET", "");
	vi.spyOn(console, "error").mockImplementation(() => {});
	vi.spyOn(console, "warn").mockImplementation(() => {});
	rows = [
		app("user-b", "org-b", "foreign-org-client"),
		app("user-b", null, "foreign-personal-client"),
		{
			id: "caller-integration",
			userId: "user-a",
			organizationId: "org-a",
			provider: "GITHUB",
			name: "GitHub connection",
			isActive: true,
			credentials: expiredCredentials,
		},
	];
	// Apply the real predicates, including the app/connection distinction.
	findFirst.mockImplementation(
		async ({ where }: { where: Record<string, unknown> }) =>
			rows.find((row) =>
				Object.entries(where).every(([key, value]) => {
					if (key === "NOT") {
						return row.name !== (value as { name: string }).name;
					}
					return (
						value === undefined || row[key as keyof Row] === value
					);
				}),
			) ?? null,
	);
	transaction.mockImplementation(async (callback: (tx: unknown) => unknown) =>
		callback({
			$executeRaw: vi.fn().mockResolvedValue(1),
			workflowIntegration: {
				findUnique: vi
					.fn()
					.mockResolvedValue({ credentials: expiredCredentials }),
				update: vi.fn().mockResolvedValue({}),
			},
			projectRepositoryIntegration: {
				findUnique: vi.fn().mockResolvedValue({
					encryptedAccessToken: "stale-access",
					encryptedRefreshToken: "caller-refresh",
					tokenExpiresAt: new Date("2026-01-01T00:00:00Z"),
				}),
				updateMany: vi.fn().mockResolvedValue({ count: 1 }),
			},
		}),
	);
	refreshOAuthToken.mockResolvedValue({
		ok: true,
		accessToken: "rotated-access",
		refreshToken: "rotated-refresh",
		expiresIn: 28800,
	});
});

afterEach(() => {
	vi.unstubAllEnvs();
	vi.restoreAllMocks();
});

const projectInput = {
	integrationId: "caller-repository",
	encryptedRefreshToken: "caller-refresh",
	expectedUpdatedAt: new Date("2026-01-01T00:00:00Z"),
	userId: "user-a",
	organizationId: "org-a",
};

describe.each([
	{
		name: "workflow integration",
		refresh: () => getGitHubAccessToken("user-a", "org-a"),
		denied: "stale-access",
		allowed: "rotated-access",
	},
	{
		name: "project repository",
		refresh: () => refreshProjectRepoGitHubTokenWithOutcome(projectInput),
		denied: { token: null, platformFault: "MISSING_CLIENT_CREDENTIALS" },
		allowed: { token: "rotated-access" },
	},
])("GitHub $name OAuth app scope", ({ refresh, denied, allowed }) => {
	it("does not exchange a caller's refresh token using another tenant's app", async () => {
		expect(await refresh()).toEqual(denied);
		expect(refreshOAuthToken).not.toHaveBeenCalled();
		expect(transaction).not.toHaveBeenCalled();
	});

	it("does not borrow another tenant's app when the caller's app is unreadable", async () => {
		rows.push({
			...app("user-a", "org-a", "broken-client"),
			credentials: "invalid JSON",
		});
		expect(await refresh()).toEqual(denied);
		expect(refreshOAuthToken).not.toHaveBeenCalled();
	});

	it("uses the organization's app before the caller's personal app", async () => {
		rows.push(
			app("user-a", null, "personal-client"),
			app("org-admin", "org-a", "org-client"),
		);
		expect(await refresh()).toEqual(allowed);
		expect(refreshOAuthToken).toHaveBeenCalledWith(
			expect.objectContaining({
				clientId: "org-client",
				clientSecret: "org-client-secret",
				refreshToken: "caller-refresh",
			}),
		);
	});

	it("retains the caller-scoped personal fallback when the organization has no app", async () => {
		rows.push(app("user-a", null, "personal-client"));
		expect(await refresh()).toEqual(allowed);
		expect(refreshOAuthToken).toHaveBeenCalledWith(
			expect.objectContaining({
				clientId: "personal-client",
				clientSecret: "personal-client-secret",
			}),
		);
	});

	it("prefers the environment app over stored organization and personal apps", async () => {
		rows.push(
			app("user-a", "org-a", "org-client"),
			app("user-a", null, "personal-client"),
		);
		vi.stubEnv("FABRIC_GITHUB_CLIENT_ID", "env-client");
		vi.stubEnv("FABRIC_GITHUB_CLIENT_SECRET", "env-secret");
		expect(await refresh()).toEqual(allowed);
		expect(refreshOAuthToken).toHaveBeenCalledWith(
			expect.objectContaining({
				clientId: "env-client",
				clientSecret: "env-secret",
			}),
		);
	});
});

it("fails closed when project refresh has no user or organization identity", async () => {
	const {
		userId: _userId,
		organizationId: _organizationId,
		...input
	} = projectInput;
	expect(await refreshProjectRepoGitHubTokenWithOutcome(input)).toEqual({
		token: null,
		platformFault: "MISSING_CLIENT_CREDENTIALS",
	});
	expect(refreshOAuthToken).not.toHaveBeenCalled();
	expect(transaction).not.toHaveBeenCalled();
});
