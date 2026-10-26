import { createHmac } from "node:crypto";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const env = {
	DECISION_REPLAY_DATABRICKS_HOST: "https://example.com",
	DECISION_REPLAY_DATABRICKS_WORKSPACE_ID: "example_workspace",
	DECISION_REPLAY_DASHBOARD_ID: "example_dashboard",
	DECISION_REPLAY_EMBED_CLIENT_ID: "example_client",
	DECISION_REPLAY_EMBED_CLIENT_SECRET: "example_secret",
};
const fetchMock = vi.fn();
const warn = vi.fn();
vi.mock("@repo/logs", () => ({
	logger: { warn: (...args: unknown[]) => warn(...args) },
}));
const token = () =>
	Response.json({ access_token: "example_all_apis", expires_in: 3600 });
const info = () =>
	Response.json({
		scope: "example_scope",
		authorization_details: [{ type: "example" }],
	});
const scoped = () =>
	Response.json({ access_token: "example_scoped", expires_in: 600 });
beforeEach(() => {
	vi.resetModules();
	for (const [key, value] of Object.entries(env)) {
		vi.stubEnv(key, value);
	}
	fetchMock.mockReset();
	warn.mockReset();
	vi.stubGlobal("fetch", fetchMock);
	fetchMock.mockImplementation(async () => {
		throw new Error("Unexpected HTTP request");
	});
});
afterEach(() => {
	vi.unstubAllEnvs();
	vi.unstubAllGlobals();
});
// Import a fresh process-local cache for each case.
async function freshMint() {
	return (await import("../embed-token")).getDecisionReplayEmbedToken;
}
describe("Decision Replay external embedding", () => {
	it.each(Object.keys(env))("is unconfigured without %s", async (key) => {
		vi.stubEnv(key, undefined);
		const run = await freshMint();
		expect(
			await run({ projectId: "example_project", userId: "example_user" }),
		).toEqual({ available: false, reason: "not_configured" });
		await run({ projectId: "example_project", userId: "example_user" });
		expect(warn).toHaveBeenCalledTimes(1);
		expect(fetchMock).not.toHaveBeenCalled();
	});
	it.each([
		"http://example.com",
		"https://example.com/path",
		"https://user:password@example.com",
		"https://example.com?x=1",
		"not a URL",
	])("rejects invalid host %s", async (host) => {
		vi.stubEnv("DECISION_REPLAY_DATABRICKS_HOST", host);
		expect(
			await (await freshMint())({
				projectId: "example_project",
				userId: "example_user",
			}),
		).toEqual({ available: false, reason: "not_configured" });
		expect(fetchMock).not.toHaveBeenCalled();
	});
	it("exchanges three exact requests and shares only the all-apis token across users", async () => {
		fetchMock
			.mockResolvedValueOnce(token())
			.mockResolvedValueOnce(info())
			.mockResolvedValueOnce(scoped())
			.mockResolvedValueOnce(info())
			.mockResolvedValueOnce(scoped());
		const run = await freshMint();
		const a = await run({
			projectId: "example_project",
			userId: "dev@example.com",
		});
		const b = await run({
			projectId: "example_project",
			userId: "example_other_user",
		});
		expect(a).toMatchObject({
			available: true,
			token: "example_scoped",
			instanceUrl: "https://example.com",
			workspaceId: "example_workspace",
			dashboardId: "example_dashboard",
		});
		expect(b.available).toBe(true);
		expect(fetchMock).toHaveBeenCalledTimes(5);
		const [url, init] = fetchMock.mock.calls[0];
		expect(url).toBe(
			"https://example.com/oidc/v1/token?o=example_workspace",
		);
		expect(init.method).toBe("POST");
		expect(init.headers.Authorization).toBe(
			`Basic ${Buffer.from("example_client:example_secret").toString("base64")}`,
		);
		expect(new URLSearchParams(init.body).toString()).toBe(
			"grant_type=client_credentials&scope=all-apis",
		);
		for (const index of [1, 3]) {
			const [url, init] = fetchMock.mock.calls[index];
			const parsed = new URL(url);
			expect(parsed.pathname).toBe(
				"/api/2.0/lakeview/dashboards/example_dashboard/published/tokeninfo",
			);
			expect(parsed.searchParams.get("external_value")).toBe(
				"example_project",
			);
			const viewer = parsed.searchParams.get("external_viewer_id");
			expect(viewer).toMatch(/^[a-f0-9]{32}$/);
			expect(viewer).not.toContain("example_user");
			expect(viewer).not.toContain("@");
			expect(init.headers.Authorization).toBe("Bearer example_all_apis");
			expect(init.method).toBe("GET");
		}
		expect(
			new URL(fetchMock.mock.calls[1][0]).searchParams.get(
				"external_viewer_id",
			),
		).toBe(
			createHmac("sha256", "example_secret")
				.update("dev@example.com")
				.digest("hex")
				.slice(0, 32),
		);
		expect(fetchMock.mock.calls[1][0]).not.toBe(fetchMock.mock.calls[3][0]);
		for (const index of [2, 4]) {
			const [url, init] = fetchMock.mock.calls[index];
			expect(url).toBe(fetchMock.mock.calls[0][0]);
			expect(Object.fromEntries(new URLSearchParams(init.body))).toEqual({
				grant_type: "client_credentials",
				scope: "example_scope",
				authorization_details: JSON.stringify([{ type: "example" }]),
			});
		}
		for (const [, init] of fetchMock.mock.calls) {
			expect(init.signal).toBeInstanceOf(AbortSignal);
		}
		expect(JSON.stringify([a, b, warn.mock.calls])).not.toContain(
			"example_secret",
		);
		expect(JSON.stringify(a)).not.toContain("example_all_apis");
		if (a.available) {
			expect(Date.parse(a.expiresAt)).toBeGreaterThan(Date.now());
		}
	});
	it("refreshes the shared token five minutes before expiry", async () => {
		vi.useFakeTimers();
		try {
			fetchMock
				.mockResolvedValueOnce(token())
				.mockResolvedValueOnce(info())
				.mockResolvedValueOnce(scoped())
				.mockResolvedValueOnce(token())
				.mockResolvedValueOnce(info())
				.mockResolvedValueOnce(scoped());
			const run = await freshMint();
			await run({ projectId: "example_project", userId: "example_user" });
			vi.advanceTimersByTime(3300_000);
			await run({
				projectId: "example_project",
				userId: "example_other",
			});
			expect(fetchMock).toHaveBeenCalledTimes(6);
		} finally {
			vi.useRealTimers();
		}
	});
	it.each([0, 1, 2])(
		"cancels the HTTP error body at stage %s",
		async (stage) => {
			[token, info, scoped].slice(0, stage).forEach((make) => {
				fetchMock.mockResolvedValueOnce(make());
			});
			const response = new Response("Example error", { status: 403 });
			if (!response.body) {
				throw new Error("Expected response body");
			}
			const cancel = vi.spyOn(response.body, "cancel");
			fetchMock.mockResolvedValueOnce(response);
			expect(
				await (await freshMint())({
					projectId: "example_project",
					userId: "example_user",
				}),
			).toEqual({ available: false, reason: "unavailable" });
			expect(cancel).toHaveBeenCalledTimes(1);
			expect(response.bodyUsed).toBe(true);
		},
	);

	it.each([0, 1, 2])(
		"fails closed on HTTP error at stage %s without logging response bodies",
		async (stage) => {
			[token, info, scoped].slice(0, stage).forEach((make) => {
				fetchMock.mockResolvedValueOnce(make());
			});
			fetchMock.mockResolvedValueOnce(
				new Response("example_secret example_all_apis", {
					status: 403,
				}),
			);
			expect(
				await (await freshMint())({
					projectId: "example_project",
					userId: "example_user",
				}),
			).toEqual({ available: false, reason: "unavailable" });
			expect(warn).toHaveBeenCalledWith(
				"Decision Replay embed unavailable",
				{ status: 403 },
			);
			expect(JSON.stringify(warn.mock.calls)).not.toContain(
				"example_secret",
			);
		},
	);
	it.each([0, 1, 2])(
		"fails closed on invalid JSON at stage %s",
		async (stage) => {
			[token, info, scoped].slice(0, stage).forEach((make) => {
				fetchMock.mockResolvedValueOnce(make());
			});
			fetchMock.mockResolvedValueOnce(new Response("example_secret"));
			expect(
				await (await freshMint())({
					projectId: "example_project",
					userId: "example_user",
				}),
			).toEqual({ available: false, reason: "unavailable" });
			expect(JSON.stringify(warn.mock.calls)).not.toContain(
				"example_secret",
			);
		},
	);
	it.each([
		{ access_token: "", expires_in: 3600 },
		{ access_token: "example", expires_in: 0 },
		{ access_token: "example", expires_in: "3600" },
		{ access_token: "example", expires_in: 86401 },
		{},
	])("rejects malformed token %j", async (body) => {
		fetchMock.mockResolvedValueOnce(Response.json(body));
		expect(
			await (await freshMint())({
				projectId: "example_project",
				userId: "example_user",
			}),
		).toEqual({ available: false, reason: "unavailable" });
	});
	it("bounds the external identity pair", async () => {
		expect(
			await (await freshMint())({
				projectId: "x".repeat(1000),
				userId: "example_user",
			}),
		).toEqual({ available: false, reason: "unavailable" });
		expect(fetchMock).not.toHaveBeenCalled();
	});
	it.each([
		{},
		{ authorization_details: null },
		{ authorization_details: "example_invalid" },
		{ authorization_details: [], scope: { unexpected: "example" } },
	])("rejects malformed tokeninfo %j", async (body) => {
		fetchMock
			.mockResolvedValueOnce(token())
			.mockResolvedValueOnce(Response.json(body));
		expect(
			await (await freshMint())({
				projectId: "example_project",
				userId: "example_user",
			}),
		).toEqual({ available: false, reason: "unavailable" });
		expect(fetchMock).toHaveBeenCalledTimes(2);
	});
	it.each([0, 1, 2])(
		"handles timeouts at stage %s without exception contents",
		async (stage) => {
			[token, info, scoped].slice(0, stage).forEach((make) => {
				fetchMock.mockResolvedValueOnce(make());
			});
			fetchMock.mockRejectedValueOnce(
				new Error("example_secret example_all_apis"),
			);
			const timeout = vi.spyOn(AbortSignal, "timeout");
			try {
				expect(
					await (await freshMint())({
						projectId: "example_project",
						userId: "example_user",
					}),
				).toEqual({ available: false, reason: "unavailable" });
				expect(timeout.mock.calls).toEqual(
					Array.from({ length: stage + 1 }, () => [10_000]),
				);
				expect(warn).toHaveBeenCalledWith(
					"Decision Replay embed unavailable",
					{ status: 0 },
				);
			} finally {
				timeout.mockRestore();
			}
		},
	);
	it("shares an in-flight service token and mints separate scoped tokens", async () => {
		let resolveService!: (response: Response) => void;
		fetchMock.mockReturnValueOnce(
			new Promise<Response>((resolve) => {
				resolveService = resolve;
			}),
		);
		fetchMock.mockImplementation(async (url: string) =>
			url.includes("tokeninfo") ? info() : scoped(),
		);
		const run = await freshMint();
		const a = run({ projectId: "example_project", userId: "example_user" });
		const b = run({
			projectId: "example_other_project",
			userId: "example_other_user",
		});
		expect(fetchMock).toHaveBeenCalledTimes(1);
		resolveService(token());
		expect(
			(await Promise.all([a, b])).every((result) => result.available),
		).toBe(true);
		expect(fetchMock).toHaveBeenCalledTimes(5);
		expect(
			new Set(
				fetchMock.mock.calls
					.filter(([url]) => String(url).includes("tokeninfo"))
					.map(([url]) =>
						new URL(url).searchParams.get("external_value"),
					),
			),
		).toEqual(new Set(["example_project", "example_other_project"]));
	});
	it("refreshes the shared token after embedding credential rotation", async () => {
		fetchMock
			.mockResolvedValueOnce(token())
			.mockResolvedValueOnce(info())
			.mockResolvedValueOnce(scoped())
			.mockResolvedValueOnce(token())
			.mockResolvedValueOnce(info())
			.mockResolvedValueOnce(scoped());
		const run = await freshMint();
		await run({ projectId: "example_project", userId: "example_user" });
		vi.stubEnv(
			"DECISION_REPLAY_EMBED_CLIENT_SECRET",
			"example_rotated_secret",
		);
		await run({ projectId: "example_project", userId: "example_user" });
		expect(fetchMock).toHaveBeenCalledTimes(6);
		expect(fetchMock.mock.calls[3][1].headers.Authorization).toBe(
			`Basic ${Buffer.from("example_client:example_rotated_secret").toString("base64")}`,
		);
		expect(JSON.stringify(warn.mock.calls)).not.toContain(
			"example_rotated_secret",
		);
	});
});
