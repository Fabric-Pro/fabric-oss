import { describe, expect, it } from "vitest";
import { fetchGitlabCiRuns, type GitlabClient } from "../gitlab-ci-fetcher";

/** A GitLab client backed by canned pipeline + test-report responses. */
function makeClient(
	pipelines: unknown[],
	reports: Record<string, unknown> = {},
): GitlabClient {
	return {
		async get<T>(path: string): Promise<T> {
			if (/\/pipelines\?/.test(path)) {
				return pipelines as T;
			}
			const m = path.match(/\/pipelines\/(\d+)\/test_report$/);
			if (m) {
				const report = reports[m[1]];
				if (report === undefined) {
					throw new Error("404 no report");
				}
				return report as T;
			}
			throw new Error(`unexpected GET ${path}`);
		},
	};
}

const pipeline = (id: number, status = "failed") => ({
	id,
	ref: "main",
	sha: `sha${id}`,
	web_url: `https://gitlab.com/acme/store/-/pipelines/${id}`,
	status,
	created_at: "2026-07-24T10:00:00Z",
	updated_at: "2026-07-24T10:05:00Z",
	duration: 42,
});

describe("fetchGitlabCiRuns", () => {
	it("lists pipelines, pulls each native test report, and normalizes", async () => {
		const client = makeClient([pipeline(7)], {
			"7": {
				test_suites: [
					{
						name: "cart",
						test_cases: [
							{
								name: "applies a percentage discount",
								classname: "cart",
								status: "failed",
								execution_time: 0.01,
								system_output: "expected -100 to be 80",
							},
							{
								name: "adds an item",
								classname: "cart",
								status: "success",
							},
						],
					},
				],
			},
		});

		const { runs, newCursor } = await fetchGitlabCiRuns(client, {
			projectPath: "acme/store",
		});

		expect(newCursor).toBe(7);
		expect(runs).toHaveLength(1);
		const run = runs[0];
		expect(run.provider).toBe("gitlab-ci");
		expect(run.externalRunId).toBe("7");
		expect(run.branch).toBe("main");
		expect(run.results).toHaveLength(2);
		expect(
			run.results.find((r) => r.name === "applies a percentage discount")
				?.rawStatus,
		).toBe("failed");
	});

	it("skips pipelines that have not finished (running/pending)", async () => {
		const client = makeClient([pipeline(8, "running")]);
		const { runs, newCursor } = await fetchGitlabCiRuns(client, {
			projectPath: "acme/store",
		});
		expect(runs).toHaveLength(0);
		expect(newCursor).toBeNull();
	});

	it("respects the incremental cursor — a pipeline at/below it is skipped", async () => {
		const client = makeClient([pipeline(7)], { "7": { test_suites: [] } });
		const { runs, newCursor } = await fetchGitlabCiRuns(client, {
			projectPath: "acme/store",
			sincePipelineId: 7,
		});
		expect(runs).toHaveLength(0);
		expect(newCursor).toBe(7);
	});

	it("ingests a run-level record when the report is missing (fetch throws)", async () => {
		// No report registered for pipeline 9 → the test_report GET throws (404).
		const client = makeClient([pipeline(9)], {});
		const { runs } = await fetchGitlabCiRuns(client, {
			projectPath: "acme/store",
		});
		expect(runs).toHaveLength(1);
		expect(runs[0].results).toEqual([]);
	});

	it("holds the cursor below a pipeline that is still running", async () => {
		// Regression: this used to assert `newCursor === 12`, which skipped
		// pipeline 11 forever — the next fetch asks for `id > 12`, so 11's
		// results were never ingested once it finished. Ingest everything
		// finished, but only remember up to the last id we know is settled.
		const client = makeClient(
			[pipeline(12), pipeline(11, "running"), pipeline(10)],
			{ "12": { test_suites: [] }, "10": { test_suites: [] } },
		);
		const { runs, newCursor } = await fetchGitlabCiRuns(client, {
			projectPath: "acme/store",
		});
		// Runs returned oldest-first; the running one (11) has no results yet.
		expect(runs.map((r) => r.externalRunId)).toEqual(["10", "12"]);
		expect(newCursor).toBe(10);
	});

	it("pages back to the cursor instead of stopping at the newest page", async () => {
		// Regression: one newest-first page of `perPage` against a bigger backlog
		// returned only the newest N; advancing the cursor past them stranded
		// every older pipeline permanently. The fetcher must ask for page 2.
		const requested: string[] = [];
		const page1 = [pipeline(30), pipeline(29)];
		const page2 = [pipeline(28), pipeline(27)];
		const client: GitlabClient = {
			async get<T>(path: string): Promise<T> {
				if (/\/pipelines\?/.test(path)) {
					requested.push(path);
					const m = path.match(/[?&]page=(\d+)/);
					const page = m ? Number(m[1]) : 1;
					if (page === 1) return page1 as T;
					if (page === 2) return page2 as T;
					return [] as T;
				}
				if (/\/pipelines\/\d+\/test_report$/.test(path)) {
					return { test_suites: [] } as T;
				}
				if (/\/pipelines\/\d+$/.test(path)) {
					return {} as T;
				}
				throw new Error(`unexpected GET ${path}`);
			},
		};

		const { runs } = await fetchGitlabCiRuns(client, {
			projectPath: "acme/store",
			sincePipelineId: 27,
			maxRuns: 2,
		});

		// Page 2 was requested, and the older pipelines above the cursor came back.
		expect(requested.some((p) => /[?&]page=2/.test(p))).toBe(true);
		expect(runs.map((r) => r.externalRunId)).toEqual(["28", "29", "30"]);
	});

	it("advances to the highest finished pipeline when none are in flight", async () => {
		const client = makeClient([pipeline(12), pipeline(11), pipeline(10)], {
			"12": { test_suites: [] },
			"11": { test_suites: [] },
			"10": { test_suites: [] },
		});
		const { newCursor } = await fetchGitlabCiRuns(client, {
			projectPath: "acme/store",
		});
		expect(newCursor).toBe(12);
	});
});
