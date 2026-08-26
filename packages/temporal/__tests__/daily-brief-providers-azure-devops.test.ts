import { beforeEach, describe, expect, it, vi } from "vitest";
import {
	fetchAdoAnnotatedTagReleases,
	fetchAdoPullRequests,
} from "../src/activities/daily-brief/providers/azure-devops";

const fetchMock = vi.fn();
vi.stubGlobal("fetch", fetchMock);

beforeEach(() => {
	fetchMock.mockReset();
});

// ---------------------------------------------------------------------------
// Factories
// ---------------------------------------------------------------------------
const auth = { basicAuth: "Basic xyz", organization: "org", project: "Proj" };
const repositoryUrl = "https://dev.azure.com/org/Proj/_git/r";
const windowStart = new Date("2026-06-09T00:00:00Z");
const windowEnd = new Date("2026-06-10T00:00:00Z");

function jsonResponse(body: unknown, headers: Record<string, string> = {}) {
	return new Response(JSON.stringify(body), {
		status: 200,
		headers: { "Content-Type": "application/json", ...headers },
	});
}

function ref(name: string, objectId: string, peeledObjectId?: string) {
	return { name, objectId, ...(peeledObjectId ? { peeledObjectId } : {}) };
}

function refsResponse(refs: unknown[], continuationToken?: string) {
	return jsonResponse(
		{ value: refs, count: refs.length },
		continuationToken
			? { "x-ms-continuationtoken": continuationToken }
			: {},
	);
}

function annotatedTagResponse(name: string, date: string, message: string) {
	return jsonResponse({ name, message, taggedBy: { name: "alice", date } });
}

function adoPr(overrides: Record<string, unknown>) {
	return {
		pullRequestId: 1,
		title: "PR",
		description: "body",
		status: "active",
		isDraft: false,
		creationDate: "2026-06-09T01:00:00Z",
		closedDate: null,
		createdBy: { displayName: "alice" },
		reviewers: [],
		sourceRefName: "refs/heads/feat",
		targetRefName: "refs/heads/main",
		...overrides,
	};
}

function prsResponse(prs: unknown[]) {
	return jsonResponse({ value: prs, count: prs.length });
}

// ---------------------------------------------------------------------------
// fetchAdoAnnotatedTagReleases
// ---------------------------------------------------------------------------
describe("fetchAdoAnnotatedTagReleases", () => {
	it("annotated tags become releases sorted by taggedDate desc; lightweight tags ignored", async () => {
		fetchMock
			.mockResolvedValueOnce(
				refsResponse([
					ref("refs/tags/a-old", "obj1", "peel1"), // annotated
					ref("refs/tags/b-light", "commitsha"), // lightweight (no peeledObjectId)
					ref("refs/tags/c-new", "obj2", "peel2"), // annotated
				]),
			)
			.mockResolvedValueOnce(
				annotatedTagResponse(
					"a-old",
					"2026-06-01T00:00:00Z",
					"old notes",
				),
			)
			.mockResolvedValueOnce(
				annotatedTagResponse(
					"c-new",
					"2026-06-09T00:00:00Z",
					"new notes",
				),
			);

		const out = await fetchAdoAnnotatedTagReleases({
			auth,
			repo: "r",
			repositoryUrl: "https://dev.azure.com/org/Proj/_git/r",
			remainingMs: () => 60_000,
		});

		expect(out.failClosed).toBe(false);
		expect(out.releases.map((r) => r.tag_name)).toEqual(["c-new", "a-old"]); // date-sorted, not name-sorted
		expect(out.releases[0]).toMatchObject({
			body: "new notes",
			html_url: "https://dev.azure.com/org/Proj/_git/r?version=GTc-new",
		});
		// detail call hits annotatedtags with the TAG OBJECT id, not the peeled commit
		expect(fetchMock.mock.calls[1][0]).toContain("/annotatedtags/obj1");
	});

	it("fails closed when a continuation token remains past the refs cap", async () => {
		// One page of 1000 refs WITH a continuation token still pending → fail closed.
		const bigPage = Array.from({ length: 1000 }, (_, i) =>
			ref(`refs/tags/t${i}`, `o${i}`, `p${i}`),
		);
		fetchMock.mockResolvedValueOnce(refsResponse(bigPage, "next-token"));

		const out = await fetchAdoAnnotatedTagReleases({
			auth,
			repo: "r",
			repositoryUrl,
			remainingMs: () => 60_000,
		});

		expect(out).toEqual({ releases: [], failClosed: true });
		expect(fetchMock).toHaveBeenCalledTimes(1); // no detail calls
	});

	it("fails closed when annotated candidates exceed the detail cap", async () => {
		const refs51 = Array.from({ length: 51 }, (_, i) =>
			ref(`refs/tags/t${i}`, `o${i}`, `p${i}`),
		);
		fetchMock.mockResolvedValueOnce(refsResponse(refs51));

		const out = await fetchAdoAnnotatedTagReleases({
			auth,
			repo: "r",
			repositoryUrl,
			remainingMs: () => 60_000,
		});

		expect(out).toEqual({ releases: [], failClosed: true });
		expect(fetchMock).toHaveBeenCalledTimes(1); // zero detail calls
	});

	it("fails closed when budget exhausts mid-detail-scan (partial results discarded)", async () => {
		fetchMock
			.mockResolvedValueOnce(
				refsResponse([
					ref("refs/tags/a", "o1", "p1"),
					ref("refs/tags/b", "o2", "p2"),
				]),
			)
			.mockResolvedValueOnce(
				annotatedTagResponse("a", "2026-06-01T00:00:00Z", "m"),
			);

		const budgets = [60_000, 60_000, 100]; // refs call, detail 1, then exhausted before detail 2
		const remainingMs = vi.fn(() => budgets.shift() ?? 100);

		const out = await fetchAdoAnnotatedTagReleases({
			auth,
			repo: "r",
			repositoryUrl,
			remainingMs,
		});

		expect(out).toEqual({ releases: [], failClosed: true });
	});
});

// ---------------------------------------------------------------------------
// fetchAdoPullRequests
// ---------------------------------------------------------------------------
describe("fetchAdoPullRequests", () => {
	it("bucketed PR fetch sends documented searchCriteria and paginates with $skip", async () => {
		fetchMock.mockImplementation(() => prsResponse([])); // all four buckets empty

		await fetchAdoPullRequests({
			auth,
			repo: "r",
			repositoryUrl,
			windowStart,
			windowEnd,
			remainingMs: () => 60_000,
		});

		const urls = fetchMock.mock.calls.map((c) => String(c[0]));
		expect(urls[0]).toContain("searchCriteria.status=completed");
		expect(urls[0]).toContain("searchCriteria.queryTimeRangeType=closed");
		expect(urls[0]).toContain("searchCriteria.minTime=");
		expect(urls[1]).toContain("searchCriteria.status=abandoned");
		expect(urls[2]).toContain("searchCriteria.queryTimeRangeType=created");
		expect(urls[3]).toContain("searchCriteria.status=active");
		expect(urls[3]).not.toContain("minTime"); // active bucket is unwindowed
	});

	it("window epsilon: minTime is 60s before windowStart, maxTime 60s after windowEnd", async () => {
		fetchMock.mockImplementation(() => prsResponse([]));

		await fetchAdoPullRequests({
			auth,
			repo: "r",
			repositoryUrl,
			windowStart,
			windowEnd,
			remainingMs: () => 60_000,
		});

		const params = new URL(String(fetchMock.mock.calls[0][0])).searchParams;
		expect(params.get("searchCriteria.minTime")).toBe(
			"2026-06-08T23:59:00.000Z",
		);
		expect(params.get("searchCriteria.maxTime")).toBe(
			"2026-06-10T00:01:00.000Z",
		);
	});

	it("union de-dupes by pullRequestId across buckets", async () => {
		const merged = adoPr({
			pullRequestId: 7,
			status: "completed",
			closedDate: "2026-06-09T12:00:00Z",
		});
		fetchMock
			.mockResolvedValueOnce(prsResponse([merged])) // completed bucket
			.mockResolvedValueOnce(prsResponse([])) // abandoned bucket
			.mockResolvedValueOnce(prsResponse([merged])) // created bucket — same PR again
			.mockResolvedValueOnce(prsResponse([])); // active bucket

		const out = await fetchAdoPullRequests({
			auth,
			repo: "r",
			repositoryUrl,
			windowStart,
			windowEnd,
			remainingMs: () => 60_000,
		});

		expect(out.prs).toHaveLength(1);
		expect(out.prs[0]).toMatchObject({
			number: 7,
			merged_at: "2026-06-09T12:00:00Z",
		});
	});

	it("mapping: completed → merged_at; abandoned → closed_at only; active reviewers vote 0 → requested_reviewers; refs/heads/ stripped", async () => {
		fetchMock
			.mockResolvedValueOnce(
				prsResponse([
					adoPr({
						pullRequestId: 1,
						status: "completed",
						closedDate: "2026-06-09T12:00:00Z",
					}),
				]),
			)
			.mockResolvedValueOnce(
				prsResponse([
					adoPr({
						pullRequestId: 2,
						status: "abandoned",
						closedDate: "2026-06-09T13:00:00Z",
					}),
				]),
			)
			.mockResolvedValueOnce(prsResponse([]))
			.mockResolvedValueOnce(
				prsResponse([
					adoPr({
						pullRequestId: 3,
						status: "active",
						reviewers: [
							{ displayName: "rev1", vote: 0 },
							{ displayName: "approved", vote: 10 },
						],
					}),
				]),
			);

		const out = await fetchAdoPullRequests({
			auth,
			repo: "r",
			repositoryUrl,
			windowStart,
			windowEnd,
			remainingMs: () => 60_000,
		});

		const byNum = new Map(out.prs.map((p) => [p.number, p]));
		expect(byNum.get(1)).toMatchObject({
			merged_at: "2026-06-09T12:00:00Z",
			closed_at: "2026-06-09T12:00:00Z",
			state: "closed",
		});
		expect(byNum.get(2)).toMatchObject({
			merged_at: null,
			closed_at: "2026-06-09T13:00:00Z",
			state: "closed",
		});
		expect(byNum.get(3)).toMatchObject({
			state: "open",
			requested_reviewers: [{ login: "rev1" }],
			base: { ref: "main" },
			html_url: `${repositoryUrl}/pullrequest/3`,
		});
	});

	it.each([
		["already percent-encoded repo name", "My%20Repo"],
		["raw repo name with a space", "My Repo"],
	])(
		"encodes the repo segment exactly once (%s)",
		async (_label, repoArg) => {
			fetchMock
				.mockResolvedValueOnce(refsResponse([])) // refs scan: no tags
				.mockImplementation(() => prsResponse([])); // all PR buckets empty

			await fetchAdoAnnotatedTagReleases({
				auth,
				repo: repoArg,
				repositoryUrl,
				remainingMs: () => 60_000,
			});
			await fetchAdoPullRequests({
				auth,
				repo: repoArg,
				repositoryUrl,
				windowStart,
				windowEnd,
				remainingMs: () => 60_000,
			});

			const allUrls = fetchMock.mock.calls.map((c) => String(c[0]));
			const refsUrl = allUrls.find((u) => u.includes("/refs"));
			const prsUrl = allUrls.find((u) => u.includes("/pullrequests"));
			expect(refsUrl).toBeDefined();
			expect(prsUrl).toBeDefined();
			for (const u of [refsUrl as string, prsUrl as string]) {
				// once-encoded: "My Repo" → "My%20Repo"; never double-encoded.
				expect(u).toContain("/My%20Repo/");
				expect(u).not.toContain("My%2520Repo");
			}
		},
	);

	it("bucket cap forces truncated=true", async () => {
		// Completed bucket returns a FULL first page (100) → $skip=100 hits the cap.
		const fullPage = Array.from({ length: 100 }, (_, i) =>
			adoPr({
				pullRequestId: i + 1,
				status: "completed",
				closedDate: "2026-06-09T12:00:00Z",
			}),
		);
		fetchMock
			.mockResolvedValueOnce(prsResponse(fullPage))
			.mockImplementation(() => prsResponse([]));

		const out = await fetchAdoPullRequests({
			auth,
			repo: "r",
			repositoryUrl,
			windowStart,
			windowEnd,
			remainingMs: () => 60_000,
		});

		expect(out.truncated).toBe(true);
	});
});
