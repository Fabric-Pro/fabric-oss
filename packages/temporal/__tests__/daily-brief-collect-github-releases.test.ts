import { beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("@repo/database", () => ({
	getProjectReposForCodeSearch: vi.fn(),
	db: { project: { findUnique: vi.fn() } },
}));
vi.mock("@repo/utils", () => ({
	decryptApiKey: vi.fn((token: string) => token),
}));
vi.mock("@repo/logs", () => ({
	logger: { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() },
}));
vi.mock("@temporalio/activity", () => ({ heartbeat: vi.fn() }));
// The real `resolve-repo-auth` (NOT mocked — GitHub rows resolve via the real
// resolver + the @repo/utils decrypt mock) imports @repo/integrations/gitlab at
// module load; stub the named exports so that import resolves. @repo/connectors
// is intentionally NOT mocked (real parseAdoRepositoryUrl).
vi.mock("@repo/integrations/gitlab", () => ({
	getValidGitLabAccessToken: vi.fn(),
	refreshGitLabToken: vi.fn(),
	GitLabApiError: class GitLabApiError extends Error {},
	gitlabRequest: vi.fn(),
}));
// The provider modules are mocked (file-scoped, hoisted). Factory defaults keep
// the GitHub-only existing tests green even though their repo rows now flow
// through the real dispatch: a GITLAB row resolves to `gitlab` and would call
// fetchGitLabReleases — the default returns an empty, non-truncated result so
// the legacy "no GitHub repos" expectation ({items:[],failures:[]}) still holds.
// NOTE (Vitest 4.x): a vi.fn(impl) created in a vi.mock factory KEEPS its base
// implementation across vi.resetAllMocks() (only call history + *Once queues are
// cleared), so per-test mockResolvedValue overrides revert to these defaults
// between tests via the existing beforeEach reset.
vi.mock("../src/activities/daily-brief/providers/gitlab", () => ({
	fetchGitLabReleases: vi.fn(async () => ({
		releases: [],
		truncated: false,
	})),
	fetchGitLabLatestRelease: vi.fn(async () => null),
}));
vi.mock("../src/activities/daily-brief/providers/azure-devops", () => ({
	fetchAdoAnnotatedTagReleases: vi.fn(async () => ({
		releases: [],
		failClosed: false,
	})),
	ADO_RELEASE_SCAN_INCOMPLETE:
		"release scan incomplete (more than 50 annotated tags or budget exhausted) — releases omitted",
}));

import { db, getProjectReposForCodeSearch } from "@repo/database";
import {
	collectGitHubReleasesActivity,
	RELEASE_NOTES_OMITTED_NOTICE,
} from "../src/activities/daily-brief/collect-github-releases";
import {
	ADO_RELEASE_SCAN_INCOMPLETE,
	fetchAdoAnnotatedTagReleases,
} from "../src/activities/daily-brief/providers/azure-devops";
import {
	fetchGitLabLatestRelease,
	fetchGitLabReleases,
} from "../src/activities/daily-brief/providers/gitlab";

const fetchGitLabReleasesMock = vi.mocked(fetchGitLabReleases);
const fetchGitLabLatestReleaseMock = vi.mocked(fetchGitLabLatestRelease);
const fetchAdoAnnotatedTagReleasesMock = vi.mocked(
	fetchAdoAnnotatedTagReleases,
);

const WINDOW = {
	projectId: "p1",
	organizationId: null,
	userId: "u1",
	timeWindowStart: new Date("2026-06-01T00:00:00Z"),
	timeWindowEnd: new Date("2026-06-08T00:00:00Z"),
};

function repo(overrides: Record<string, unknown> = {}) {
	// Extended with the fields the REAL resolveRepoAuth reads (authMethod,
	// encryptedPat, azureOrganization, repositoryUrl, encryptedRefreshToken).
	// Defaults keep every existing GitHub-row assertion intact: GITHUB+OAUTH +
	// encryptedAccessToken resolves to {kind:"github", token: <decrypted>}.
	return {
		provider: "GITHUB",
		owner: "o",
		repo: "r",
		integrationId: "int-1",
		encryptedAccessToken: "tok",
		encryptedRefreshToken: null,
		authMethod: "OAUTH",
		encryptedPat: null,
		azureOrganization: null,
		repositoryUrl: "https://github.com/o/r",
		...overrides,
	};
}

function release(overrides: Record<string, unknown> = {}) {
	return {
		tag_name: "v1.0.0",
		name: "v1.0.0",
		draft: false,
		prerelease: false,
		published_at: "2026-06-05T10:00:00Z",
		created_at: "2026-06-05T10:00:00Z",
		html_url: "https://github.com/o/r/releases/tag/v1.0.0",
		author: { login: "octocat" },
		body: "notes",
		...overrides,
	};
}

function ghResponse(page: unknown[], opts: { next?: boolean } = {}) {
	return {
		ok: true,
		json: async () => page,
		headers: {
			get: (name: string) =>
				name.toLowerCase() === "link" && opts.next
					? '<https://api.github.com/repositories/1/releases?page=2>; rel="next"'
					: null,
		},
	};
}

// Builds a fetch mock from JSON pages. Intermediate pages always advertise a
// `Link: rel="next"`; the LAST page's next link is controlled by `lastHasNext`
// (default false = exhausted). So a single-page list looks exhausted, while a
// capped multi-page list whose last page still advertises `next` → truncation.
function mockFetchPages(
	pages: unknown[][],
	opts: { lastHasNext?: boolean } = {},
) {
	const fn = vi.fn();
	pages.forEach((page, i) => {
		const isLast = i === pages.length - 1;
		fn.mockResolvedValueOnce(
			ghResponse(page, {
				next: isLast ? Boolean(opts.lastHasNext) : true,
			}),
		);
	});
	// any further call → empty page, no next link
	fn.mockResolvedValue(ghResponse([]));
	vi.stubGlobal("fetch", fn);
	return fn;
}

// Routes fetch by URL: `/releases/latest` → latestByUrl[url-substring]; the paged
// `/releases?per_page` list → pages (single page, exhausted). Pass `latest` keyed
// by repo owner/repo, or a status (e.g. 404) object.
function mockFetch(opts: {
	listPages?: unknown[][];
	latest?: { ok?: boolean; status?: number; json?: unknown } | null;
}) {
	const fn = vi.fn((url: string) => {
		if (url.includes("/releases/latest")) {
			const l = opts.latest ?? { ok: false, status: 404 };
			return Promise.resolve({
				ok: l.ok ?? true,
				status: l.status ?? 200,
				json: async () => l.json ?? {},
				headers: { get: () => null },
			});
		}
		const pages = opts.listPages ?? [[]];
		const page = pages.shift() ?? [];
		return Promise.resolve(ghResponse(page));
	});
	vi.stubGlobal("fetch", fn);
	return fn;
}

beforeEach(() => {
	vi.resetAllMocks();
	vi.unstubAllGlobals();
	// Default: the project's tenant matches the WINDOW input (personal, userId u1).
	vi.mocked(db.project.findUnique).mockResolvedValue({
		organizationId: null,
		userId: "u1",
	} as never);
});

describe("collectGitHubReleasesActivity", () => {
	it("returns one DeploymentItem for a published in-window release", async () => {
		vi.mocked(getProjectReposForCodeSearch).mockResolvedValue([
			repo(),
		] as never);
		mockFetchPages([[release()]]);
		const out = await collectGitHubReleasesActivity(WINDOW);
		expect(out.items).toHaveLength(1);
		expect(out.items[0]).toMatchObject({
			repoFullName: "o/r",
			tagName: "v1.0.0",
			title: "v1.0.0",
			url: "https://github.com/o/r/releases/tag/v1.0.0",
			author: "octocat",
		});
		expect(out.items[0].occurredAt).toEqual(
			new Date("2026-06-05T10:00:00Z"),
		);
		expect(out.failures).toEqual([]);
	});

	it("excludes drafts and pre-releases", async () => {
		vi.mocked(getProjectReposForCodeSearch).mockResolvedValue([
			repo(),
		] as never);
		mockFetchPages([
			[
				release({ tag_name: "draft", draft: true }),
				release({ tag_name: "pre", prerelease: true }),
				release({ tag_name: "ok" }),
			],
		]);
		const out = await collectGitHubReleasesActivity(WINDOW);
		expect(out.items.map((i) => i.tagName)).toEqual(["ok"]);
	});

	it("excludes releases published outside the window", async () => {
		vi.mocked(getProjectReposForCodeSearch).mockResolvedValue([
			repo(),
		] as never);
		mockFetchPages([
			[
				release({
					tag_name: "before",
					published_at: "2026-05-01T00:00:00Z",
				}),
				release({
					tag_name: "after",
					published_at: "2026-07-01T00:00:00Z",
				}),
				release({
					tag_name: "in",
					published_at: "2026-06-05T00:00:00Z",
				}),
			],
		]);
		const out = await collectGitHubReleasesActivity(WINDOW);
		expect(out.items.map((i) => i.tagName)).toEqual(["in"]);
	});

	it("includes an old-created but newly-published release (no created_at short-circuit)", async () => {
		vi.mocked(getProjectReposForCodeSearch).mockResolvedValue([
			repo(),
		] as never);
		// API ordered by created_at desc: a recent draft-then-published release has
		// an OLD created_at and would sort LAST, but its published_at is in-window.
		mockFetchPages([
			[
				release({
					tag_name: "recent",
					created_at: "2026-06-06T00:00:00Z",
					published_at: "2026-06-06T00:00:00Z",
				}),
				release({
					tag_name: "old-created",
					created_at: "2026-01-01T00:00:00Z",
					published_at: "2026-06-05T00:00:00Z",
				}),
			],
		]);
		const out = await collectGitHubReleasesActivity(WINDOW);
		expect(out.items.map((i) => i.tagName).sort()).toEqual([
			"old-created",
			"recent",
		]);
	});

	it("paginates via Link headers and flags truncation when the page cap is hit", async () => {
		vi.mocked(getProjectReposForCodeSearch).mockResolvedValue([
			repo(),
		] as never);
		const fullPage = Array.from({ length: 100 }, (_, i) =>
			release({
				tag_name: `v${i}`,
				published_at: "2026-06-05T00:00:00Z",
			}),
		);
		// MAX_RELEASE_PAGES (5) pages; the 5th still advertises rel="next" →
		// cap hit while more remain → truncation.
		mockFetchPages([fullPage, fullPage, fullPage, fullPage, fullPage], {
			lastHasNext: true,
		});
		const out = await collectGitHubReleasesActivity(WINDOW);
		expect(out.items.length).toBe(50); // was 500 — now bounded by MAX_DEPLOYMENT_ITEMS
		expect(out.failures.some((f) => /truncat/i.test(f.reason))).toBe(true); // still true (both notes match)
	});

	it("does NOT flag truncation when the final page has no next link (exhausted)", async () => {
		vi.mocked(getProjectReposForCodeSearch).mockResolvedValue([
			repo(),
		] as never);
		// A full page of exactly 100 with no rel="next" is exhausted, not truncated
		// (the numeric-page heuristic would have false-positived here).
		const fullPage = Array.from({ length: 100 }, (_, i) =>
			release({
				tag_name: `v${i}`,
				published_at: "2026-06-05T00:00:00Z",
			}),
		);
		mockFetchPages([fullPage]);
		const out = await collectGitHubReleasesActivity(WINDOW);
		expect(out.items.length).toBe(50); // was 100
		expect(
			out.failures.some((f) => /truncated to 50/i.test(f.reason)),
		).toBe(true); // item-cap note
		expect(
			out.failures.some((f) =>
				/Release list truncated at/i.test(f.reason),
			),
		).toBe(false); // NO pagination false-positive
	});

	it("respects a soft time budget — returns partial items + skipped failures instead of timing out", async () => {
		vi.useFakeTimers();
		try {
			vi.mocked(getProjectReposForCodeSearch).mockResolvedValue([
				repo({ owner: "a", integrationId: "ia" }),
				repo({ owner: "b", integrationId: "ib" }),
			] as never);
			// Repo a fetches and pushes the clock past the soft budget; repo b is
			// then skipped before any fetch.
			const fetchMock = vi
				.fn()
				.mockImplementationOnce(async () => {
					vi.advanceTimersByTime(3 * 60 * 1000); // +3 min > SOFT_BUDGET_MS
					return ghResponse([release({ tag_name: "a-1" })]);
				})
				.mockResolvedValue(ghResponse([]));
			vi.stubGlobal("fetch", fetchMock);

			const out = await collectGitHubReleasesActivity(WINDOW);

			expect(out.items.map((i) => i.tagName)).toEqual(["a-1"]);
			expect(fetchMock).toHaveBeenCalledTimes(1); // repo b never fetched
			expect(
				out.failures.some(
					(f) => f.repoFullName === "b/r" && /budget/i.test(f.reason),
				),
			).toBe(true);
		} finally {
			vi.useRealTimers();
		}
	});

	it("isolates a per-repo failure and still returns items from the good repo", async () => {
		vi.mocked(getProjectReposForCodeSearch).mockResolvedValue([
			repo({ owner: "bad", integrationId: "int-bad" }),
			repo({ owner: "good", integrationId: "int-good" }),
		] as never);
		const fn = vi
			.fn()
			.mockResolvedValueOnce({
				ok: false,
				status: 401,
				json: async () => ({ message: "Bad credentials" }),
			})
			.mockResolvedValueOnce(
				ghResponse([release({ tag_name: "good-1" })]),
			)
			.mockResolvedValue(ghResponse([]));
		vi.stubGlobal("fetch", fn);
		const out = await collectGitHubReleasesActivity(WINDOW);
		expect(out.items.map((i) => i.tagName)).toEqual(["good-1"]);
		expect(out.failures).toHaveLength(1);
		expect(out.failures[0].repoFullName).toBe("bad/r");
	});

	it("records a failure when the token cannot be decrypted, without throwing", async () => {
		const { decryptApiKey } = await import("@repo/utils");
		vi.mocked(getProjectReposForCodeSearch).mockResolvedValue([
			repo(),
		] as never);
		vi.mocked(decryptApiKey).mockImplementation(() => {
			throw new Error("bad key");
		});
		mockFetchPages([[release()]]);
		const out = await collectGitHubReleasesActivity(WINDOW);
		expect(out.items).toEqual([]);
		expect(out.failures[0].reason).toMatch(/decrypt/i);
	});

	it("omits an empty body", async () => {
		vi.mocked(getProjectReposForCodeSearch).mockResolvedValue([
			repo(),
		] as never);
		mockFetchPages([[release({ body: "   " })]]);
		const out = await collectGitHubReleasesActivity(WINDOW);
		expect(out.items[0].body).toBeUndefined();
	});

	it("returns empty when there are no GitHub repos (but still counts the active integration)", async () => {
		vi.mocked(getProjectReposForCodeSearch).mockResolvedValue([
			repo({ provider: "GITLAB" }),
		] as never);
		const out = await collectGitHubReleasesActivity(WINDOW);
		// The project HAS one ACTIVE integration (GitLab) — it just produced no
		// in-window GitHub releases. activeRepoCount reflects active integrations
		// scanned, not GitHub items, so the newsletter classifies this as
		// NO_RELEASES, never NO_ACTIVE_REPOS.
		expect(out).toEqual({ items: [], failures: [], activeRepoCount: 1 });
	});

	it("skips on an org mismatch — no repo lookup, no fetch (tenant guard)", async () => {
		vi.mocked(db.project.findUnique).mockResolvedValue({
			organizationId: "org-b",
			userId: "u1",
		} as never);
		const fetchSpy = vi.fn();
		vi.stubGlobal("fetch", fetchSpy);
		const out = await collectGitHubReleasesActivity({
			...WINDOW,
			organizationId: "org-a",
		});
		expect(out).toEqual({ items: [], failures: [] });
		expect(getProjectReposForCodeSearch).not.toHaveBeenCalled();
		expect(fetchSpy).not.toHaveBeenCalled();
	});

	it("skips a personal project owned by a different user — org===null (tenant guard)", async () => {
		// Personal context: org is null for everyone, so the user must match.
		vi.mocked(db.project.findUnique).mockResolvedValue({
			organizationId: null,
			userId: "u2",
		} as never);
		const fetchSpy = vi.fn();
		vi.stubGlobal("fetch", fetchSpy);
		const out = await collectGitHubReleasesActivity(WINDOW); // org null, userId "u1"
		expect(out).toEqual({ items: [], failures: [] });
		expect(getProjectReposForCodeSearch).not.toHaveBeenCalled();
		expect(fetchSpy).not.toHaveBeenCalled();
	});

	it("sorts items newest-first across repos", async () => {
		vi.mocked(getProjectReposForCodeSearch).mockResolvedValue([
			repo(),
		] as never);
		mockFetchPages([
			[
				release({
					tag_name: "older",
					published_at: "2026-06-02T00:00:00Z",
				}),
				release({
					tag_name: "newer",
					published_at: "2026-06-06T00:00:00Z",
				}),
			],
		]);
		const out = await collectGitHubReleasesActivity(WINDOW);
		expect(out.items.map((i) => i.tagName)).toEqual(["newer", "older"]);
	});

	it("reports activeRepoCount = number of ACTIVE repos on the normal path", async () => {
		vi.mocked(getProjectReposForCodeSearch).mockResolvedValue([
			repo({ owner: "a", integrationId: "ia" }),
			repo({ owner: "b", integrationId: "ib" }),
		] as never);
		mockFetchPages([[release()]]);
		const out = await collectGitHubReleasesActivity(WINDOW);
		expect(out.activeRepoCount).toBe(2);
	});

	it("reports activeRepoCount = 0 when there are no active repos", async () => {
		vi.mocked(getProjectReposForCodeSearch).mockResolvedValue([] as never);
		const out = await collectGitHubReleasesActivity(WINDOW);
		expect(out).toEqual({ items: [], failures: [], activeRepoCount: 0 });
	});

	it("does NOT set activeRepoCount on tenant mismatch (trust-boundary guard, not 'no repos')", async () => {
		vi.mocked(db.project.findUnique).mockResolvedValue({
			organizationId: "org-b",
			userId: "someone-else",
		} as never);
		const out = await collectGitHubReleasesActivity({
			...WINDOW,
			organizationId: "org-a",
		});
		expect(out).toEqual({ items: [], failures: [] });
		expect(out.activeRepoCount).toBeUndefined();
	});
});

describe("full release notes (per-release ceiling)", () => {
	it("keeps a body longer than the old 500-char cap intact", async () => {
		const body = "a".repeat(2000);
		vi.mocked(getProjectReposForCodeSearch).mockResolvedValue([
			repo(),
		] as never);
		mockFetchPages([[release({ body })]]);
		const out = await collectGitHubReleasesActivity(WINDOW);
		expect(out.items[0].body).toBe(body); // no truncation at 500
	});

	it("truncates a body beyond 10 000 chars with an ellipsis", async () => {
		const body = "b".repeat(10_050);
		vi.mocked(getProjectReposForCodeSearch).mockResolvedValue([
			repo(),
		] as never);
		mockFetchPages([[release({ body })]]);
		const out = await collectGitHubReleasesActivity(WINDOW);
		expect(out.items[0].body).toHaveLength(10_001); // 10_000 + "…"
		expect(out.items[0].body?.endsWith("…")).toBe(true);
	});
});

describe("section size guards", () => {
	it("caps items at 50 and records a truncation note", async () => {
		const many = Array.from({ length: 60 }, (_, i) =>
			release({
				tag_name: `v${i}`,
				html_url: `https://github.com/o/r/releases/tag/v${i}`,
				// distinct, in-window published_at, newest first by index 0
				published_at: new Date(
					Date.UTC(2026, 5, 7, 0, 0, 60 - i),
				).toISOString(),
				created_at: new Date(
					Date.UTC(2026, 5, 7, 0, 0, 60 - i),
				).toISOString(),
				body: "n",
			}),
		);
		vi.mocked(getProjectReposForCodeSearch).mockResolvedValue([
			repo(),
		] as never);
		mockFetchPages([many]);
		const out = await collectGitHubReleasesActivity(WINDOW);
		expect(out.items).toHaveLength(50);
		expect(
			out.failures.some((f) => /truncated to 50/i.test(f.reason)),
		).toBe(true);
	});

	it("replaces overflow bodies with the omitted-notice and records a budget note", async () => {
		const big = "x".repeat(9_000);
		const releases = Array.from({ length: 20 }, (_, i) =>
			release({
				tag_name: `v${i}`,
				html_url: `https://github.com/o/r/releases/tag/v${i}`,
				published_at: new Date(
					Date.UTC(2026, 5, 7, 0, 0, 60 - i),
				).toISOString(),
				created_at: new Date(
					Date.UTC(2026, 5, 7, 0, 0, 60 - i),
				).toISOString(),
				body: big, // 20 * 9000 = 180k > 100k budget
			}),
		);
		vi.mocked(getProjectReposForCodeSearch).mockResolvedValue([
			repo(),
		] as never);
		mockFetchPages([releases]);
		const out = await collectGitHubReleasesActivity(WINDOW);
		// newest keep full bodies; later ones become the notice (never empty/absent)
		expect(out.items[0].body).toBe(big);
		const omitted = out.items.filter(
			(i) => i.body === RELEASE_NOTES_OMITTED_NOTICE,
		);
		expect(omitted.length).toBeGreaterThan(0);
		const realBodyChars = out.items
			.filter((i) => i.body && i.body !== RELEASE_NOTES_OMITTED_NOTICE)
			.reduce((n, i) => n + (i.body?.length ?? 0), 0);
		expect(realBodyChars).toBeLessThanOrEqual(100_000); // RELEASE_NOTES_TOTAL_BUDGET (collector-internal)
		expect(out.failures.some((f) => /bodies omitted/i.test(f.reason))).toBe(
			true,
		);
	});
});

describe("latestProdRelease anchor (/releases/latest)", () => {
	it("returns the canonical latest release, window-independent", async () => {
		vi.mocked(getProjectReposForCodeSearch).mockResolvedValue([
			repo(),
		] as never);
		mockFetch({
			listPages: [[]], // nothing in window
			latest: {
				ok: true,
				json: release({
					tag_name: "v9.9.9",
					html_url: "https://github.com/o/r/releases/tag/v9.9.9",
					published_at: "2026-01-01T00:00:00Z", // far outside WINDOW
					created_at: "2026-01-01T00:00:00Z",
				}),
			},
		});
		const out = await collectGitHubReleasesActivity(WINDOW);
		expect(out.items).toHaveLength(0);
		expect(out.latestRelease?.tagName).toBe("v9.9.9");
	});

	it("treats a 404 from /releases/latest as 'no latest' (not a failure)", async () => {
		vi.mocked(getProjectReposForCodeSearch).mockResolvedValue([
			repo(),
		] as never);
		mockFetch({ listPages: [[]], latest: { ok: false, status: 404 } });
		const out = await collectGitHubReleasesActivity(WINDOW);
		expect(out.latestRelease).toBeUndefined();
		expect(out.failures).toEqual([]);
	});

	it("records a non-404 /releases/latest error as a failure", async () => {
		vi.mocked(getProjectReposForCodeSearch).mockResolvedValue([
			repo(),
		] as never);
		mockFetch({
			listPages: [[]],
			latest: { ok: false, status: 500, json: { message: "boom" } },
		});
		const out = await collectGitHubReleasesActivity(WINDOW);
		expect(out.latestRelease).toBeUndefined();
		expect(out.failures.some((f) => /latest/i.test(f.reason))).toBe(true);
	});

	it("across repos picks the newest by published_at", async () => {
		vi.mocked(getProjectReposForCodeSearch).mockResolvedValue([
			repo({ owner: "o", repo: "old" }),
			repo({ owner: "o", repo: "new" }),
		] as never);
		const fn = vi.fn((url: string) => {
			if (url.includes("/releases/latest")) {
				const newer = url.includes("/o/new/");
				return Promise.resolve({
					ok: true,
					status: 200,
					headers: { get: () => null },
					json: async () =>
						release({
							tag_name: newer ? "vNEW" : "vOLD",
							html_url: `https://github.com/o/${newer ? "new" : "old"}/releases/tag/x`,
							published_at: newer
								? "2026-05-30T00:00:00Z"
								: "2026-02-01T00:00:00Z",
						}),
				});
			}
			return Promise.resolve(ghResponse([]));
		});
		vi.stubGlobal("fetch", fn);
		const out = await collectGitHubReleasesActivity(WINDOW);
		expect(out.latestRelease?.tagName).toBe("vNEW");
	});

	it("still sets latestRelease when the paged list fetch fails (resilience)", async () => {
		vi.mocked(getProjectReposForCodeSearch).mockResolvedValue([
			repo(),
		] as never);
		const fn = vi.fn((url: string) => {
			if (url.includes("/releases/latest")) {
				return Promise.resolve({
					ok: true,
					status: 200,
					headers: { get: () => null },
					json: async () =>
						release({
							tag_name: "vL",
							html_url: "https://github.com/o/r/releases/tag/vL",
						}),
				});
			}
			// paged list endpoint fails → recorded as a failure, must NOT suppress the anchor
			return Promise.resolve({
				ok: false,
				status: 500,
				headers: { get: () => null },
				json: async () => ({ message: "list boom" }),
			});
		});
		vi.stubGlobal("fetch", fn);
		const out = await collectGitHubReleasesActivity(WINDOW);
		expect(out.latestRelease?.tagName).toBe("vL");
		expect(
			out.failures.some((f) =>
				/list boom|GitHub API error/i.test(f.reason),
			),
		).toBe(true);
	});

	it("still collects the latest anchor when the list overran the SOFT budget but activity margin remains", async () => {
		vi.useFakeTimers();
		try {
			vi.mocked(getProjectReposForCodeSearch).mockResolvedValue([
				repo(),
			] as never);
			const fn = vi.fn((url: string) => {
				if (url.includes("/releases/latest")) {
					// Phase 2 has its OWN fresh budget AND activity margin remains, so a list that
					// merely overran SOFT_BUDGET must NOT skip the anchor (FR-4 resilience).
					return Promise.resolve({
						ok: true,
						status: 200,
						headers: { get: () => null },
						json: async () =>
							release({
								tag_name: "vL",
								html_url:
									"https://github.com/o/r/releases/tag/vL",
							}),
					});
				}
				vi.advanceTimersByTime(130 * 1000); // > SOFT_BUDGET_MS (120s) but < ACTIVITY_SOFT_DEADLINE_MS (165s)
				return Promise.resolve(
					ghResponse([release({ tag_name: "a-1" })]),
				);
			});
			vi.stubGlobal("fetch", fn);
			const out = await collectGitHubReleasesActivity(WINDOW);
			expect(out.items.map((i) => i.tagName)).toEqual(["a-1"]); // list items kept
			expect(out.latestRelease?.tagName).toBe("vL"); // anchor SURVIVES the slow list
		} finally {
			vi.useRealTimers();
		}
	});

	it("skips the latest lookup when the overall activity deadline is exhausted", async () => {
		vi.useFakeTimers();
		try {
			vi.mocked(getProjectReposForCodeSearch).mockResolvedValue([
				repo(),
			] as never);
			const fn = vi.fn((url: string) => {
				if (url.includes("/releases/latest")) {
					// Must NOT be reached: the list overran the activity deadline, so no time is left.
					return Promise.resolve({
						ok: true,
						status: 200,
						headers: { get: () => null },
						json: async () => release(),
					});
				}
				vi.advanceTimersByTime(170 * 1000); // > ACTIVITY_SOFT_DEADLINE_MS (165s) → no margin for the anchor
				return Promise.resolve(
					ghResponse([release({ tag_name: "a-1" })]),
				);
			});
			vi.stubGlobal("fetch", fn);
			const out = await collectGitHubReleasesActivity(WINDOW);
			expect(out.items.map((i) => i.tagName)).toEqual(["a-1"]);
			expect(out.latestRelease).toBeUndefined(); // hard bound respected
			expect(
				out.failures.some((f) =>
					/time budget exhausted/i.test(f.reason),
				),
			).toBe(true);
		} finally {
			vi.useRealTimers();
		}
	});

	it("collects repo B's latest even when its list was skipped by the soft budget (multi-repo)", async () => {
		vi.useFakeTimers();
		try {
			vi.mocked(getProjectReposForCodeSearch).mockResolvedValue([
				repo({ owner: "a" }),
				repo({ owner: "b" }),
			] as never);
			const fn = vi.fn((url: string) => {
				if (url.includes("/releases/latest")) {
					const isB = url.includes("/repos/b/");
					return Promise.resolve({
						ok: true,
						status: 200,
						headers: { get: () => null },
						json: async () =>
							release({
								tag_name: isB ? "vB" : "vA",
								html_url: `https://github.com/${isB ? "b" : "a"}/r/releases/tag/x`,
								published_at: isB
									? "2026-05-30T00:00:00Z"
									: "2026-02-01T00:00:00Z", // B newer
							}),
					});
				}
				// list call — only repo a reaches here (b's list is budget-skipped)
				vi.advanceTimersByTime(130 * 1000); // > SOFT_BUDGET_MS, < ACTIVITY_SOFT_DEADLINE_MS
				return Promise.resolve(
					ghResponse([
						release({
							tag_name: "a-1",
							published_at: "2026-06-05T00:00:00Z",
						}),
					]),
				);
			});
			vi.stubGlobal("fetch", fn);
			const out = await collectGitHubReleasesActivity(WINDOW);
			expect(out.items.map((i) => i.tagName)).toEqual(["a-1"]); // only a's list ran
			expect(
				out.failures.some(
					(f) => f.repoFullName === "b/r" && /budget/i.test(f.reason),
				),
			).toBe(true);
			expect(out.latestRelease?.tagName).toBe("vB"); // B's anchor collected despite its list being skipped
		} finally {
			vi.useRealTimers();
		}
	});

	it("counts setup time against the activity deadline (skips work when setup stalled)", async () => {
		vi.useFakeTimers();
		try {
			vi.mocked(getProjectReposForCodeSearch).mockImplementation(
				async () => {
					vi.advanceTimersByTime(170 * 1000); // setup stall > ACTIVITY_SOFT_DEADLINE_MS
					return [repo()] as never;
				},
			);
			const fn = vi.fn(() => Promise.resolve(ghResponse([release()])));
			vi.stubGlobal("fetch", fn);
			const out = await collectGitHubReleasesActivity(WINDOW);
			expect(out.items).toEqual([]); // Phase 1 list skipped (activity deadline, from true start)
			expect(out.latestRelease).toBeUndefined(); // Phase 2 skipped
			expect(fn).not.toHaveBeenCalled();
		} finally {
			vi.useRealTimers();
		}
	});
});

describe("multi-provider", () => {
	const reposMock = vi.mocked(getProjectReposForCodeSearch);

	// Window aligned to the fixtures below (in-window release = 2026-06-09T10:00Z).
	const baseInput = {
		projectId: "p1",
		organizationId: null as string | null,
		userId: "u1",
		timeWindowStart: new Date("2026-06-09T00:00:00Z"),
		timeWindowEnd: new Date("2026-06-10T00:00:00Z"),
	};

	function repoRow(provider: string, owner: string, repo: string) {
		return {
			integrationId: `int-${provider}-${repo}`,
			provider,
			owner,
			repo,
			branch: "main",
			repositoryUrl:
				provider === "AZURE_DEVOPS"
					? `https://dev.azure.com/${owner}/Proj/_git/${repo}`
					: `https://example.com/${owner}/${repo}`,
			encryptedAccessToken: "enc",
			encryptedRefreshToken: null,
			tokenExpiresAt: null,
			updatedAt: new Date(),
			encryptedPat: provider === "AZURE_DEVOPS" ? "enc-pat" : null,
			azureOrganization: provider === "AZURE_DEVOPS" ? owner : null,
			authMethod: provider === "AZURE_DEVOPS" ? "PAT" : "OAUTH",
		};
	}

	/** GitHub-shaped release object — the providers' normalized output AND GitHub's raw shape. */
	function rel(tag: string, publishedAt: string) {
		return {
			tag_name: tag,
			name: tag,
			draft: false,
			prerelease: false,
			published_at: publishedAt,
			html_url: `https://example.com/rel/${tag}`,
			author: { login: "alice" },
			body: `notes ${tag}`,
		};
	}
	const ghRelease = rel; // alias for readability in mixed-provider tests

	function jsonResponse(body: unknown) {
		return {
			ok: true,
			status: 200,
			json: async () => body,
			headers: { get: () => null },
		};
	}

	/** Routes the global fetch stub by URL: /releases/latest → latest (404 when null), /releases → one list page. */
	function stubGitHubFetch(args: {
		list: unknown[];
		latest: unknown | null;
	}) {
		const fn = vi.fn((url: string) => {
			if (url.includes("/releases/latest")) {
				return Promise.resolve(
					args.latest
						? jsonResponse(args.latest)
						: {
								ok: false,
								status: 404,
								json: async () => ({ message: "Not Found" }),
								headers: { get: () => null },
							},
				);
			}
			return Promise.resolve(jsonResponse(args.list));
		});
		vi.stubGlobal("fetch", fn);
		return fn;
	}

	it("GitLab repo: in-window releases become items; permalink latest feeds the anchor", async () => {
		reposMock.mockResolvedValue([
			repoRow("GITLAB", "grp", "proj"),
		] as never);
		fetchGitLabReleasesMock.mockResolvedValue({
			releases: [
				rel("v2", "2026-06-09T10:00:00Z"),
				rel("v1", "2026-01-01T00:00:00Z"),
			] as never,
			truncated: false,
		});
		fetchGitLabLatestReleaseMock.mockResolvedValue(
			rel("v9", "2026-06-09T23:00:00Z") as never,
		);
		const out = await collectGitHubReleasesActivity(baseInput);
		expect(out.items.map((i) => i.tagName)).toEqual(["v2"]); // out-of-window v1 filtered
		expect(out.latestRelease?.tagName).toBe("v9");
	});

	it("ADO repo: tag releases window-filtered; anchor comes from the SAME scan (no Phase-2 fetch)", async () => {
		reposMock.mockResolvedValue([
			repoRow("AZURE_DEVOPS", "org", "r"),
		] as never);
		fetchAdoAnnotatedTagReleasesMock.mockResolvedValue({
			releases: [
				rel("new", "2026-06-09T10:00:00Z"),
				rel("ancient", "2025-01-01T00:00:00Z"),
			] as never,
			failClosed: false,
		});
		const out = await collectGitHubReleasesActivity(baseInput);
		expect(out.items.map((i) => i.tagName)).toEqual(["new"]);
		expect(out.latestRelease?.tagName).toBe("new"); // releases[0] of the scan
		expect(fetchAdoAnnotatedTagReleasesMock).toHaveBeenCalledTimes(1); // reused, not refetched
	});

	it("ADO failClosed → zero items, zero anchor, ADO_RELEASE_SCAN_INCOMPLETE failure", async () => {
		reposMock.mockResolvedValue([
			repoRow("AZURE_DEVOPS", "org", "r"),
		] as never);
		fetchAdoAnnotatedTagReleasesMock.mockResolvedValue({
			releases: [],
			failClosed: true,
		});
		const out = await collectGitHubReleasesActivity(baseInput);
		expect(out.items).toEqual([]);
		expect(out.latestRelease).toBeUndefined();
		expect(out.failures).toContainEqual({
			repoFullName: "org/r",
			reason: ADO_RELEASE_SCAN_INCOMPLETE,
		});
	});

	it("unsupported combo → per-repo failure with the resolver's reason", async () => {
		reposMock.mockResolvedValue([
			// GITLAB+PAT used to be listed here, but PAT-connect made it a real,
			// supported combination — leaving it would assert a bug. Azure DevOps
			// has no OAuth path, so that pairing is genuinely unsupported.
			{ ...repoRow("AZURE_DEVOPS", "g", "p"), authMethod: "OAUTH" },
		] as never);
		const out = await collectGitHubReleasesActivity(baseInput);
		expect(out.failures).toContainEqual({
			repoFullName: "g/p",
			reason: "Unsupported provider/auth combination: AZURE_DEVOPS/OAUTH",
		});
	});

	it("mixed providers merge: items sorted across providers; anchor = max published_at", async () => {
		reposMock.mockResolvedValue([
			repoRow("GITHUB", "o", "gh"),
			repoRow("GITLAB", "grp", "gl"),
			repoRow("AZURE_DEVOPS", "org", "ado"),
		] as never);
		// GitHub list via fetch stub: one release published 2026-06-09T08:00Z, latest = same
		stubGitHubFetch({
			list: [ghRelease("gh-1", "2026-06-09T08:00:00Z")],
			latest: ghRelease("gh-1", "2026-06-09T08:00:00Z"),
		});
		fetchGitLabReleasesMock.mockResolvedValue({
			releases: [rel("gl-1", "2026-06-09T09:00:00Z")] as never,
			truncated: false,
		});
		fetchGitLabLatestReleaseMock.mockResolvedValue(
			rel("gl-1", "2026-06-09T09:00:00Z") as never,
		);
		fetchAdoAnnotatedTagReleasesMock.mockResolvedValue({
			releases: [rel("ado-1", "2026-06-09T10:00:00Z")] as never,
			failClosed: false,
		});
		const out = await collectGitHubReleasesActivity(baseInput);
		expect(out.items.map((i) => i.tagName)).toEqual([
			"ado-1",
			"gl-1",
			"gh-1",
		]); // newest-first across providers
		expect(out.latestRelease?.tagName).toBe("ado-1"); // max published_at wins
	});

	it("provider failure isolation: GitLab fetch throws → GitHub repo still collected", async () => {
		reposMock.mockResolvedValue([
			repoRow("GITLAB", "grp", "gl"),
			repoRow("GITHUB", "o", "gh"),
		] as never);
		fetchGitLabReleasesMock.mockRejectedValue(
			new Error("GitLab API error: HTTP 401: Unauthorized"),
		);
		fetchGitLabLatestReleaseMock.mockRejectedValue(
			new Error("GitLab API error: HTTP 401: Unauthorized"),
		);
		stubGitHubFetch({
			list: [ghRelease("gh-1", "2026-06-09T08:00:00Z")],
			latest: null,
		});
		const out = await collectGitHubReleasesActivity(baseInput);
		expect(out.items.map((i) => i.tagName)).toEqual(["gh-1"]);
		expect(
			out.failures.some(
				(f) =>
					f.repoFullName === "grp/gl" &&
					f.reason.includes("GitLab API error"),
			),
		).toBe(true);
	});

	it("returns one latest release per repo, newest-first (latestReleasesByRepo)", async () => {
		// Two repos, each with a latest release; GitLab (gl-new) newer than GitHub (gh-old).
		reposMock.mockResolvedValue([
			repoRow("GITHUB", "owner", "gh"),
			repoRow("GITLAB", "owner", "gl"),
		] as never);
		stubGitHubFetch({
			list: [],
			latest: ghRelease("gh-old", "2026-06-09T08:00:00Z"),
		});
		fetchGitLabLatestReleaseMock.mockResolvedValue(
			rel("gl-new", "2026-06-09T20:00:00Z") as never,
		);
		const out = await collectGitHubReleasesActivity(baseInput);
		expect(out.latestReleasesByRepo?.map((r) => r.tagName)).toEqual([
			"gl-new", // newest first
			"gh-old",
		]);
		// Back-compat: global-newest single field unchanged.
		expect(out.latestRelease?.tagName).toBe("gl-new");
	});

	it("omits repos with no production release from latestReleasesByRepo", async () => {
		// repo A (GitHub) has a latest release; repo B (GitLab) has none (null).
		reposMock.mockResolvedValue([
			repoRow("GITHUB", "owner", "repo-a"),
			repoRow("GITLAB", "owner", "repo-b"),
		] as never);
		stubGitHubFetch({
			list: [],
			latest: ghRelease("a-1", "2026-06-09T08:00:00Z"),
		});
		fetchGitLabLatestReleaseMock.mockResolvedValue(null);
		const out = await collectGitHubReleasesActivity(baseInput);
		expect(out.latestReleasesByRepo?.map((r) => r.repoFullName)).toEqual([
			"owner/repo-a",
		]);
	});

	it("dedupes latestReleasesByRepo by repoFullName (duplicate integrations)", async () => {
		// Two ACTIVE GitHub integrations pointing at the SAME owner/dup-repo.
		reposMock.mockResolvedValue([
			repoRow("GITHUB", "owner", "dup-repo"),
			repoRow("GITHUB", "owner", "dup-repo"),
		] as never);
		stubGitHubFetch({
			list: [],
			latest: ghRelease("dup-1", "2026-06-09T08:00:00Z"),
		});
		const out = await collectGitHubReleasesActivity(baseInput);
		const names =
			out.latestReleasesByRepo?.map((r) => r.repoFullName) ?? [];
		expect(new Set(names).size).toBe(names.length); // no duplicates
		expect(names).toEqual(["owner/dup-repo"]);
	});
});
