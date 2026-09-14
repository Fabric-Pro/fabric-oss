/**
 * Integration test for the abort/timeout propagation path from a GitLab
 * token exchange down to the source resolver.
 *
 * A body-read abort inside `refreshGitLabToken`'s non-OK branch must reach
 * `resolveGitLabSource` as the SAME `DOMException`, not a generic Error that
 * `isNoVerdictTransientError` cannot recognise — otherwise it lands as a
 * strike against the 3-strike refresh circuit breaker for an outcome that is
 * not a verdict at all.
 *
 * Every layer under test here is the REAL implementation —
 * `refreshGitLabToken`, `refreshMcpConfigToken`, and `resolveGitLabSource`
 * are all imported directly, not mocked. Only `fetch` and the Prisma-backed
 * persistence helper (`updateMcpConfigTokens`) are faked. This is
 * deliberate: injecting the DOMException directly into `resolveGitLabSource`
 * via a hand-rolled `refresh()` stub (as `source.test.ts`'s suite does)
 * proves the RESOLVER classifies the error correctly but cannot prove the
 * error actually SURVIVES the two real layers underneath it. A try/catch
 * wrapped around a body read is an easy place for that survival to quietly
 * break: the same `AbortSignal` that bounds the whole exchange also governs
 * the body read, so a timeout firing after non-OK headers arrive throws from
 * THAT read — and a catch written only to handle "body wasn't JSON" will
 * swallow it into a generic error unless it explicitly checks for and
 * rethrows the abort. This file exists to catch a regression in that
 * specific seam.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("@repo/database", () => ({
	updateMcpConfigTokens: vi.fn(),
}));
vi.mock("@repo/utils", () => ({
	encryptApiKey: (v: string) => `enc_${v}`,
	decryptApiKey: (v: string) => v.replace(/^enc_/, ""),
	hashApiKey: (v: string) => `hash_${v}`,
}));

afterEach(() => {
	vi.restoreAllMocks();
});

/**
 * A `Response` whose body stream errors on read — models a timeout firing
 * AFTER headers have already arrived (so `response.ok` is already decided)
 * but before the body finished. That is exactly what the SAME
 * `AbortSignal.timeout` used for the whole exchange produces when it fires
 * mid-body rather than before `fetch` ever resolves.
 */
function nonOkResponseWithAbortedBody(status: number): Response {
	const stream = new ReadableStream({
		pull(controller) {
			controller.error(
				new DOMException("signal timed out", "TimeoutError"),
			);
		},
	});
	return new Response(stream, { status });
}

describe("GitLab refresh abort propagation: refreshGitLabToken -> refreshMcpConfigToken -> resolveGitLabSource", () => {
	beforeEach(() => {
		vi.resetModules();
	});

	it("does not record a markRefreshFailure strike when a non-OK exchange's body read itself times out", async () => {
		vi.spyOn(globalThis, "fetch").mockResolvedValueOnce(
			nonOkResponseWithAbortedBody(400),
		);

		const { refreshMcpConfigToken } = await import(
			"../../src/gitlab/refresh-mcp-config-token"
		);
		const { resolveGitLabSource } = await import("../../src/gitlab/source");

		const fakeDb = {
			mCPConfig: {
				// resolveGitLabSource's own pre-refresh lookup.
				findFirst: vi.fn().mockResolvedValue({
					id: "cfg-1",
					baseUrl: null,
					encryptedAccessToken: "enc_stale-access",
					encryptedRefreshToken: "enc_old-refresh",
					// Already expired: forces the refresh path.
					tokenExpiresAt: new Date("2026-05-15T11:00:00Z"),
					mcpServer: { defaultUrl: "https://gitlab.com/api/v4/mcp" },
				}),
				// refreshMcpConfigToken's own re-read inside the refresh call.
				findUnique: vi.fn().mockResolvedValue({
					id: "cfg-1",
					encryptedRefreshToken: "enc_old-refresh",
					oauthClientId: "client-id",
					encryptedOauthClientSecret: "enc_secret",
					baseUrl: null,
					needsReauth: false,
				}),
			},
			workflowIntegration: {
				findFirst: vi.fn().mockResolvedValue(null),
			},
		};

		const markRefreshFailure = vi.fn(async () => {});
		const getRestToken = vi.fn(async () => "rest-token");

		const src = await resolveGitLabSource({
			userId: "u1",
			organizationId: null,
			db: fakeDb as never,
			decrypt: (c: string) => c.replace(/^enc_/, ""),
			refresh: (configId: string) =>
				refreshMcpConfigToken({ configId, db: fakeDb as never }),
			getRestToken,
			markRefreshFailure,
			now: () => new Date("2026-05-15T12:00:00Z"),
		});

		// Degrades to REST — the resolver's normal recovery path.
		expect(src).toEqual({ kind: "rest-adapter", token: "rest-token" });
		// The whole point: the abort reached the resolver AS an abort, so it
		// was classified as a no-verdict transient outcome and never
		// consumed a strike against the 3-strike breaker.
		expect(markRefreshFailure).not.toHaveBeenCalled();
	});
});
