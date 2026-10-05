import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
	find: vi.fn(),
	lockedFind: vi.fn(),
	update: vi.fn(),
	refresh: vi.fn(),
	fetch: vi.fn(),
}));
vi.mock("@repo/database", () => ({
	db: {
		workflowIntegration: { findFirst: mocks.find },
		$transaction: async (fn: (tx: unknown) => unknown) =>
			fn({
				$executeRaw: vi.fn().mockResolvedValue(1),
				workflowIntegration: {
					findFirst: mocks.lockedFind,
					updateMany: mocks.update,
				},
			}),
	},
}));
vi.mock("@repo/utils", () => ({
	decryptApiKey: (value: string) => value.replace(/^enc:/, ""),
	encryptApiKey: (value: string) => `enc:${value}`,
}));
vi.mock("@repo/utils/oauth-refresh", () => ({
	refreshOAuthToken: mocks.refresh,
	sanitizeCredential: (v: string) => v.trim(),
}));
vi.mock("@repo/database/prisma/queries/lib/refresh-lock", () => ({
	withRefreshLock: async (
		_key: string,
		fn: (tx: unknown, budget: (ms: number) => void) => unknown,
	) =>
		fn(
			{
				workflowIntegration: {
					findFirst: mocks.lockedFind,
					updateMany: mocks.update,
				},
			},
			() => {},
		),
}));

import {
	testGitHubAccessToken,
	testSavedGitHubConnection,
} from "../../src/github";

const input = {
	integrationId: "integration-example",
	userId: "user-example",
	organizationId: "org-example",
};
const expired = {
	access_token: "expired-token",
	refresh_token: "refresh-original",
	expires_in: 1,
	token_obtained_at: "2020-01-01T00:00:00Z",
};
const row = {
	id: input.integrationId,
	credentials: `enc:${JSON.stringify(expired)}`,
	settings: { githubLogin: "example-user" },
};
const expectedWhere = {
	id: input.integrationId,
	userId: input.userId,
	organizationId: input.organizationId,
	workflowId: null,
	provider: "GITHUB",
	isActive: true,
	NOT: { name: "GITHUB_OAUTH_APP" },
};

beforeEach(() => {
	vi.resetAllMocks();
	vi.stubGlobal("fetch", mocks.fetch);
	vi.stubEnv("FABRIC_GITHUB_CLIENT_ID", "example-client");
	vi.stubEnv("FABRIC_GITHUB_CLIENT_SECRET", "example-secret");
	mocks.find.mockResolvedValue(row);
	mocks.lockedFind.mockResolvedValue(row);
	mocks.update.mockImplementation(async ({ data }) => {
		mocks.find.mockResolvedValue({ ...row, credentials: data.credentials });
		return { count: 1 };
	});
	mocks.refresh.mockResolvedValue({
		ok: true,
		accessToken: "fresh-token",
		refreshToken: "refresh-rotated",
		expiresIn: 28800,
	});
	mocks.fetch.mockResolvedValue(
		new Response(JSON.stringify({ login: "example-user" }), {
			status: 200,
		}),
	);
});
afterEach(() => {
	vi.unstubAllGlobals();
	vi.unstubAllEnvs();
});

describe("saved GitHub connection checks", () => {
	it.each([
		{ kind: "PAT", status: 200, change: "replacement" },
		{ kind: "PAT", status: 401, change: "disconnection" },
		{ kind: "fresh OAuth", status: 200, change: "disconnection" },
		{ kind: "fresh OAuth", status: 401, change: "replacement" },
		{ kind: "refreshed OAuth", status: 200, change: "replacement" },
		{ kind: "refreshed OAuth", status: 401, change: "disconnection" },
		{ kind: "PAT", status: 200, change: "newer account" },
	])(
		"does not publish stale $kind HTTP $status evidence after $change during /user",
		async ({ kind, status, change }) => {
			const original =
				kind === "PAT"
					? { ...row, credentials: 'enc:{"apiKey":"original-pat"}' }
					: kind === "fresh OAuth"
						? {
								...row,
								credentials:
									'enc:{"access_token":"original-oauth"}',
							}
						: row;
			mocks.find.mockResolvedValue(original);
			mocks.lockedFind.mockResolvedValue(original);
			let finishProbe!: (response: Response) => void;
			mocks.fetch.mockImplementationOnce(
				() =>
					new Promise((resolve) => {
						finishProbe = resolve;
					}),
			);
			const check = testSavedGitHubConnection(input);
			await vi.waitFor(() =>
				expect(mocks.fetch).toHaveBeenCalledTimes(1),
			);
			const token =
				mocks.fetch.mock.calls[0][1].headers.Authorization.slice(
					"Bearer ".length,
				);
			mocks.find.mockResolvedValue(
				change === "disconnection"
					? null
					: {
							...original,
							id:
								change === "newer account"
									? "integration-newer"
									: original.id,
							credentials: `enc:${JSON.stringify({ access_token: change === "newer account" ? token : "replacement-token" })}`,
						},
			);
			finishProbe(
				new Response(
					status === 200
						? JSON.stringify({ login: "old-account" })
						: "",
					{ status },
				),
			);
			expect(await check).toMatchObject({
				success: false,
				status: "unknown",
			});
			expect(mocks.find).toHaveBeenLastCalledWith({
				where: {
					userId: input.userId,
					organizationId: input.organizationId,
					workflowId: null,
					provider: "GITHUB",
					isActive: true,
					NOT: { name: "GITHUB_OAUTH_APP" },
				},
				select: { id: true, credentials: true, settings: true },
				orderBy: { createdAt: "desc" },
			});
		},
	);

	it("keeps successful evidence when the same access token is re-encrypted on the same account row", async () => {
		const original = {
			...row,
			credentials: 'enc:{"access_token":"original-token"}',
		};
		mocks.find.mockResolvedValueOnce(original).mockResolvedValue({
			...original,
			credentials: 'enc:{"access_token":"original-token","scope":"repo"}',
		});
		expect(await testSavedGitHubConnection(input)).toMatchObject({
			success: true,
			status: "connected",
		});
	});

	it("fails closed when tenant context is missing", async () => {
		expect(
			await testSavedGitHubConnection({
				...input,
				organizationId: undefined as unknown as string,
			}),
		).toMatchObject({ success: false, status: "unknown" });
		expect(mocks.find).not.toHaveBeenCalled();
		expect(mocks.refresh).not.toHaveBeenCalled();
	});
	it("refreshes an expired token on the exact owned account row, persists rotation, then validates the fresh token", async () => {
		expect(await testSavedGitHubConnection(input)).toEqual({
			success: true,
			status: "connected",
			message: "Connected as example-user",
		});
		expect(mocks.find).toHaveBeenCalledWith({
			where: expectedWhere,
			select: { id: true, credentials: true, settings: true },
		});
		expect(mocks.lockedFind).toHaveBeenCalledWith({
			where: expectedWhere,
			select: { id: true, credentials: true, settings: true },
		});
		expect(mocks.refresh).toHaveBeenCalledWith(
			expect.objectContaining({ refreshToken: "refresh-original" }),
		);
		const write = mocks.update.mock.calls[0][0];
		expect(write.where).toEqual({
			...expectedWhere,
			credentials: row.credentials,
		});
		expect(JSON.parse(write.data.credentials.slice(4))).toMatchObject({
			access_token: "fresh-token",
			refresh_token: "refresh-rotated",
		});
		expect(mocks.fetch).toHaveBeenCalledWith(
			"https://api.github.com/user",
			expect.objectContaining({
				headers: expect.objectContaining({
					Authorization: "Bearer fresh-token",
				}),
			}),
		);
	});
	it.each(["bad_refresh_token", "invalid_grant"])(
		"requires reconnect only when OAuth rejects the grant (%s)",
		async (errorCode) => {
			mocks.refresh.mockResolvedValue({
				ok: false,
				errorCode,
				errorMessage: "Rejected",
			});
			expect(await testSavedGitHubConnection(input)).toMatchObject({
				success: false,
				status: "reconnect_required",
			});
			expect(mocks.update).not.toHaveBeenCalled();
			expect(mocks.fetch).not.toHaveBeenCalled();
		},
	);
	it.each([
		"http_503",
		"http_429",
		"http_404",
		"invalid_client",
		"invalid_request",
	])(
		"keeps authorization unknown for refresh failure %s",
		async (errorCode) => {
			mocks.refresh.mockResolvedValue({
				ok: false,
				errorCode,
				errorMessage: "Unavailable",
			});
			expect(await testSavedGitHubConnection(input)).toMatchObject({
				success: false,
				status: "unknown",
			});
			expect(mocks.update).not.toHaveBeenCalled();
		},
	);
	it("keeps a thrown refresh network failure unknown", async () => {
		mocks.refresh.mockRejectedValue(new Error("Network unavailable"));
		expect(await testSavedGitHubConnection(input)).toMatchObject({
			success: false,
			status: "unknown",
		});
	});
	it("does not require reconnect when a concurrent reconnect supersedes a rejected grant", async () => {
		mocks.refresh.mockImplementation(async () => {
			mocks.find.mockResolvedValue({
				...row,
				credentials: "enc:new-grant",
			});
			return {
				ok: false,
				errorCode: "bad_refresh_token",
				errorMessage: "Rejected old grant",
			};
		});
		expect(await testSavedGitHubConnection(input)).toMatchObject({
			success: false,
			status: "unknown",
		});
		expect(mocks.update).not.toHaveBeenCalled();
	});
	it("keeps a rejected grant unknown when a newer account supersedes the tested row", async () => {
		mocks.refresh.mockImplementation(async () => {
			mocks.find.mockImplementation(async ({ where }) =>
				where.id ? row : { ...row, id: "integration-newer" },
			);
			return {
				ok: false,
				errorCode: "bad_refresh_token",
				errorMessage: "Rejected",
			};
		});
		expect(await testSavedGitHubConnection(input)).toMatchObject({
			success: false,
			status: "unknown",
		});
	});
	it("keeps a failed post-rejection account reread unknown", async () => {
		mocks.refresh.mockImplementation(async () => {
			mocks.find.mockRejectedValue(new Error("Database unavailable"));
			return {
				ok: false,
				errorCode: "bad_refresh_token",
				errorMessage: "Rejected",
			};
		});
		expect(await testSavedGitHubConnection(input)).toMatchObject({
			success: false,
			status: "unknown",
		});
	});

	it("treats missing OAuth app configuration as unknown rather than revoked authorization", async () => {
		vi.stubEnv("FABRIC_GITHUB_CLIENT_ID", "");
		vi.stubEnv("FABRIC_GITHUB_CLIENT_SECRET", "");
		expect(await testSavedGitHubConnection(input)).toMatchObject({
			success: false,
			status: "unknown",
		});
		expect(mocks.refresh).not.toHaveBeenCalled();
	});
	it("refuses an inaccessible row before refresh or GitHub access", async () => {
		mocks.find.mockResolvedValue(null);
		expect(await testSavedGitHubConnection(input)).toMatchObject({
			success: false,
			status: "unknown",
		});
		expect(mocks.refresh).not.toHaveBeenCalled();
		expect(mocks.fetch).not.toHaveBeenCalled();
	});
	it("does not exchange or recreate a row disconnected while waiting for the lock", async () => {
		mocks.lockedFind.mockResolvedValue(null);
		expect(await testSavedGitHubConnection(input)).toMatchObject({
			success: false,
			status: "unknown",
		});
		expect(mocks.refresh).not.toHaveBeenCalled();
		expect(mocks.update).not.toHaveBeenCalled();
	});
	it("does not overwrite a concurrent reconnect after the token exchange", async () => {
		mocks.update.mockResolvedValue({ count: 0 });
		expect(await testSavedGitHubConnection(input)).toMatchObject({
			success: false,
			status: "unknown",
		});
		expect(mocks.fetch).not.toHaveBeenCalled();
	});
	it("reuses a concurrent winner's fresh token without spending its rotated refresh token", async () => {
		const winner = {
			...row,
			credentials: `enc:${JSON.stringify({ ...expired, access_token: "winner-token", expires_in: 28800, token_obtained_at: new Date().toISOString() })}`,
		};
		mocks.lockedFind.mockResolvedValue(winner);
		mocks.find.mockResolvedValueOnce(row).mockResolvedValue(winner);
		expect(await testSavedGitHubConnection(input)).toMatchObject({
			success: true,
			status: "connected",
		});
		expect(mocks.refresh).not.toHaveBeenCalled();
		expect(mocks.update).not.toHaveBeenCalled();
		expect(mocks.fetch).toHaveBeenCalledWith(
			expect.any(String),
			expect.objectContaining({
				headers: expect.objectContaining({
					Authorization: "Bearer winner-token",
				}),
			}),
		);
	});
	it("can renew a winner's token rejected by GitHub even though its recorded expiry is still fresh", async () => {
		const winner = {
			...row,
			credentials: `enc:${JSON.stringify({ ...expired, access_token: "winner-token", refresh_token: "winner-refresh", expires_in: 28800, token_obtained_at: new Date().toISOString() })}`,
		};
		mocks.lockedFind.mockResolvedValue(winner);
		mocks.fetch
			.mockResolvedValueOnce(new Response("", { status: 401 }))
			.mockResolvedValueOnce(
				new Response(JSON.stringify({ login: "example-user" })),
			);
		expect(await testSavedGitHubConnection(input)).toMatchObject({
			success: true,
			status: "connected",
		});
		expect(mocks.refresh).toHaveBeenCalledWith(
			expect.objectContaining({ refreshToken: "winner-refresh" }),
		);
	});
	it("refreshes and retries a token rejected before its recorded expiry", async () => {
		const freshRow = {
			...row,
			credentials: `enc:${JSON.stringify({ ...expired, expires_in: 28800, token_obtained_at: new Date().toISOString() })}`,
		};
		mocks.find.mockResolvedValue(freshRow);
		mocks.lockedFind.mockResolvedValue(freshRow);
		mocks.fetch
			.mockResolvedValueOnce(new Response("", { status: 401 }))
			.mockResolvedValueOnce(
				new Response(JSON.stringify({ login: "example-user" })),
			);
		expect(await testSavedGitHubConnection(input)).toMatchObject({
			success: true,
			status: "connected",
		});
		expect(mocks.refresh).toHaveBeenCalledTimes(1);
		expect(mocks.fetch).toHaveBeenCalledTimes(2);
	});
});

describe("GitHub token probe", () => {
	it("requires reconnect for a rejected PAT", async () => {
		mocks.fetch.mockResolvedValue(new Response("", { status: 401 }));
		expect(await testGitHubAccessToken("example-pat")).toMatchObject({
			success: false,
			status: "reconnect_required",
		});
	});
	it.each([403, 429, 500, 503])(
		"does not infer revoked authorization from HTTP %i",
		async (status) => {
			mocks.fetch.mockResolvedValue(new Response("", { status }));
			expect(await testGitHubAccessToken("example-token")).toMatchObject({
				success: false,
				status: "unknown",
			});
		},
	);
	it("keeps a network failure unknown", async () => {
		mocks.fetch.mockRejectedValue(new Error("Network unavailable"));
		expect(await testGitHubAccessToken("example-token")).toMatchObject({
			success: false,
			status: "unknown",
		});
	});
});
