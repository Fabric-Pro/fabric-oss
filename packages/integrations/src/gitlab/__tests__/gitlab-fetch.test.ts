/**
 * `gitlabFetch` must surface a non-2xx GitLab answer as a `GitLabApiError`
 * carrying its HTTP status — including answers whose body is not JSON.
 *
 * GitLab's rate-limit (429) answer is plain text ("Retry later"). Parsing it
 * as JSON before looking at the status threw a SyntaxError that hid the 429
 * from every caller, so the REST read pool could never tell it was being
 * throttled (Fizzy #2304). The consumer side — the pool stopping on a 429 —
 * is pinned in
 * `packages/temporal/src/activities/pm-integration/__tests__/fetch-pm-items-by-ids-rest.test.ts`.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

// gitlab/index.ts statically imports these; stub them so importing the module
// under test stays light (no database client).
vi.mock("@repo/database", () => ({ db: {} }));
vi.mock("@repo/database/prisma/queries/lib/refresh-lock", () => ({
	withRefreshLock: vi.fn(),
}));
vi.mock("@repo/utils", () => ({
	decryptApiKey: (v: string) => v,
	encryptApiKey: (v: string) => v,
}));

import { GitLabApiError, gitlabFetch } from "../index";

describe("gitlabFetch", () => {
	const originalFetch = global.fetch;
	const fetchMock = vi.fn();
	beforeEach(() => {
		global.fetch = fetchMock as unknown as typeof fetch;
	});
	afterEach(() => {
		global.fetch = originalFetch;
		fetchMock.mockReset();
	});

	it("returns the parsed body of a 2xx answer", async () => {
		fetchMock.mockResolvedValueOnce(
			new Response(JSON.stringify({ iid: 7, title: "Checkout" }), {
				status: 200,
				headers: { "Content-Type": "application/json" },
			}),
		);

		await expect(
			gitlabFetch("tok", "/projects/1/issues/7"),
		).resolves.toEqual({ iid: 7, title: "Checkout" });
	});

	it("positive control: a JSON error body keeps its status and GitLab's own message", async () => {
		fetchMock.mockResolvedValueOnce(
			new Response(JSON.stringify({ message: "404 Not found" }), {
				status: 404,
				headers: { "Content-Type": "application/json" },
			}),
		);

		const error = await gitlabFetch("tok", "/projects/1/issues/9").catch(
			(e: unknown) => e,
		);

		expect(error).toBeInstanceOf(GitLabApiError);
		expect(error).toMatchObject({
			name: "GitLabApiError",
			status: 404,
			message: "404 Not found",
		});
	});

	it("a plain-text rate-limit answer is a GitLabApiError with status 429, not a JSON parse error", async () => {
		fetchMock.mockResolvedValueOnce(
			new Response("Retry later\n", {
				status: 429,
				headers: { "Content-Type": "text/plain" },
			}),
		);

		const error = await gitlabFetch("tok", "/projects/1/issues/9").catch(
			(e: unknown) => e,
		);

		expect(error).toBeInstanceOf(GitLabApiError);
		expect(error).toMatchObject({
			name: "GitLabApiError",
			status: 429,
			message: "GitLab API error: 429",
		});
	});
});
