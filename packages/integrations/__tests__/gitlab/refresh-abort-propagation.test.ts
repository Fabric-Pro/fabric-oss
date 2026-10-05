/**
 * Integration test for the abort/timeout propagation path from a GitLab
 * token exchange up to the source resolver.
 *
 * A body-read abort inside `refreshGitLabToken`'s non-OK branch must reach
 * the connection service as the SAME `DOMException`, not as a generic status
 * Error and never as `GitLabReauthRequiredError` — otherwise a timeout would
 * condemn a working connection.
 *
 * Every layer under test is the REAL implementation: `refreshGitLabToken`,
 * the connection service's refresh, and `resolveGitLabSource`. Only `fetch`
 * and the database (an in-memory fake that applies `where` clauses) are
 * faked. Injecting the DOMException into a hand-rolled exchange stub would
 * prove the service classifies it, but not that it SURVIVES the real
 * exchange's body-read catch, which is the seam this file guards.
 */
import { afterEach, describe, expect, it, vi } from "vitest";
import {
	createGitLabFakeDb,
	encryptedCredential,
	readCredential,
} from "./helpers/gitlab-fake-db";

vi.mock("@repo/utils", async (importOriginal) => {
	const helpers = await import("./helpers/gitlab-fake-db");
	return {
		...(await importOriginal<object>()),
		decryptApiKey: helpers.fakeDecrypt,
		encryptApiKey: helpers.fakeEncrypt,
	};
});

import { resolveGitLabSource } from "../../src/gitlab/source";

afterEach(() => {
	vi.restoreAllMocks();
	vi.unstubAllEnvs();
});

/**
 * A `Response` whose body stream errors on read — a timeout firing AFTER
 * headers arrived (so `response.ok` is already decided) but before the body
 * finished.
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

describe("GitLab refresh abort propagation: refreshGitLabToken -> connection service -> resolveGitLabSource", () => {
	it("keeps the connection usable and uncondemned when a non-OK exchange's body read itself times out", async () => {
		vi.stubEnv("GITLAB_CLIENT_ID", "app-client");
		vi.stubEnv("GITLAB_CLIENT_SECRET", "app-secret");
		vi.spyOn(console, "warn").mockImplementation(() => {});
		const fetchSpy = vi
			.spyOn(globalThis, "fetch")
			.mockResolvedValueOnce(nonOkResponseWithAbortedBody(400));

		const fake = createGitLabFakeDb({
			workflowIntegration: [
				{
					id: "wi-1",
					userId: "u1",
					organizationId: "org-1",
					provider: "GITLAB",
					name: "GitLab: dev",
					workflowId: null,
					credentials: encryptedCredential({
						access_token: "stale-access",
						refresh_token: "old-refresh",
						expires_in: 7200,
						// Already expired: forces the refresh path.
						token_obtained_at: new Date(
							Date.now() - 3 * 3_600_000,
						).toISOString(),
						issuer: {
							kind: "app",
							clientId: "app-client",
							origin: "https://gitlab.com",
						},
						connectionGeneration: 1,
					}),
					settings: {},
					isActive: true,
					createdAt: new Date("2026-01-01T00:00:00Z"),
					updatedAt: new Date("2026-01-01T00:00:00Z"),
				},
			],
		});

		const src = await resolveGitLabSource({
			userId: "u1",
			organizationId: "org-1",
			deps: { db: fake.db as never, withLock: fake.withLock as never },
		});

		// The exchange really ran (the real `refreshGitLabToken`)…
		expect(fetchSpy).toHaveBeenCalledTimes(1);
		expect(String(fetchSpy.mock.calls[0][0])).toBe(
			"https://gitlab.com/oauth/token",
		);
		// …and its abort was a no-verdict outcome: the current token is still
		// handed out (lenient), and nothing condemned or rotated the grant.
		expect(src).toEqual({
			kind: "rest-adapter",
			credential: {
				token: "stale-access",
				apiBase: "https://gitlab.com/api/v4",
			},
		});
		const row = fake.tables.workflowIntegration[0];
		expect((row.settings as Record<string, unknown>).needsReauth).not.toBe(
			true,
		);
		expect(readCredential(row).refresh_token).toBe("old-refresh");
	});
});
