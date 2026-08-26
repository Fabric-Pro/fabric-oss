import JSZip from "jszip";
import { beforeAll, describe, expect, it, vi } from "vitest";
import {
	fetchGithubActionsRuns,
	type GithubClient,
} from "../github-actions-fetcher";

const JUNIT_XML = `<testsuites>
  <testsuite name="cart">
    <testcase classname="test/cart.test.js" name="applies a percentage discount">
      <failure message="expected -100 to be 80">boom</failure>
    </testcase>
    <testcase classname="test/cart.test.js" name="adds an item"/>
  </testsuite>
</testsuites>`;

let zipBytes: Uint8Array;
let oversizedZipBytes: Uint8Array;
beforeAll(async () => {
	const zip = new JSZip();
	zip.file("junit.xml", JUNIT_XML);
	zip.file("readme.txt", "not xml — must be ignored");
	zipBytes = await zip.generateAsync({ type: "uint8array" });

	const oversizedZip = new JSZip();
	oversizedZip.file("junit.xml", "x".repeat(5 * 1024 * 1024 + 1));
	oversizedZipBytes = await oversizedZip.generateAsync({
		type: "uint8array",
		compression: "DEFLATE",
	});
});

/** A GitHub client backed by canned responses keyed on the request path. */
function makeClient(over: Partial<GithubClient> = {}): GithubClient {
	return {
		async get<T>(path: string): Promise<T> {
			if (/\/actions\/runs\?/.test(path)) {
				return {
					workflow_runs: [
						{
							id: 100,
							name: "CI",
							head_branch: "main",
							head_sha: "abc123",
							html_url:
								"https://github.com/acme/store/actions/runs/100",
							status: "completed",
							conclusion: "failure",
							run_started_at: "2026-07-24T10:00:00Z",
							updated_at: "2026-07-24T10:01:00Z",
						},
					],
				} as T;
			}
			if (/\/runs\/100\/artifacts$/.test(path)) {
				return {
					artifacts: [
						{
							id: 9,
							name: "junit-report",
							expired: false,
							size_in_bytes: 500,
						},
						{
							id: 10,
							name: "build-output",
							expired: false,
							size_in_bytes: 500,
						},
					],
				} as T;
			}
			throw new Error(`unexpected GET ${path}`);
		},
		getArtifactZip: vi.fn(async () => zipBytes),
		...over,
	};
}

describe("fetchGithubActionsRuns", () => {
	it("lists runs, downloads the report artifact, parses JUnit, and normalizes", async () => {
		const client = makeClient();
		const { runs, newCursor } = await fetchGithubActionsRuns(client, {
			owner: "acme",
			repo: "store",
		});

		expect(newCursor).toBe(100);
		expect(runs).toHaveLength(1);
		const run = runs[0];
		expect(run.provider).toBe("github-actions");
		expect(run.externalRunId).toBe("100");
		expect(run.branch).toBe("main");
		expect(run.results).toHaveLength(2);
		const failing = run.results.find(
			(r) => r.name === "applies a percentage discount",
		);
		expect(failing?.rawStatus).toBe("failed");
		expect(failing?.classname).toBe("test/cart.test.js");
	});

	it("only downloads artifacts matching the report heuristic (not build output)", async () => {
		const getArtifactZip = vi.fn(async (_path: string) => zipBytes);
		const client = makeClient({ getArtifactZip });
		await fetchGithubActionsRuns(client, { owner: "acme", repo: "store" });
		// "junit-report" matches; "build-output" does not — exactly one download.
		expect(getArtifactZip).toHaveBeenCalledTimes(1);
		expect(getArtifactZip.mock.calls[0][0]).toContain("/artifacts/9/zip");
	});

	it("respects the incremental cursor — a run at/below it is skipped", async () => {
		const { runs, newCursor } = await fetchGithubActionsRuns(makeClient(), {
			owner: "acme",
			repo: "store",
			sinceRunId: 100,
		});
		expect(runs).toHaveLength(0);
		expect(newCursor).toBe(100);
	});

	it("ingests a run-level record when no report artifact is present", async () => {
		const client = makeClient({
			async get<T>(path: string): Promise<T> {
				if (/\/actions\/runs\?/.test(path)) {
					return {
						workflow_runs: [
							{
								id: 100,
								head_sha: "abc",
								html_url: "u",
								status: "completed",
								conclusion: "success",
							},
						],
					} as T;
				}
				return { artifacts: [] } as T;
			},
		});
		const { runs } = await fetchGithubActionsRuns(client, {
			owner: "acme",
			repo: "store",
		});
		expect(runs).toHaveLength(1);
		expect(runs[0].results).toEqual([]);
	});

	it("survives an artifact download failure — the run still ingests run-level-only", async () => {
		const client = makeClient({
			getArtifactZip: vi.fn(async () => {
				throw new Error("410 gone");
			}),
		});
		const { runs } = await fetchGithubActionsRuns(client, {
			owner: "acme",
			repo: "store",
		});
		expect(runs).toHaveLength(1);
		expect(runs[0].results).toEqual([]);
	});

	it("rejects a compressed artifact whose XML expands beyond the entry cap", async () => {
		const client = makeClient({
			getArtifactZip: vi.fn(async () => oversizedZipBytes),
		});

		const { runs } = await fetchGithubActionsRuns(client, {
			owner: "acme",
			repo: "store",
		});

		expect(oversizedZipBytes.byteLength).toBeLessThan(50 * 1024);
		expect(runs[0].results).toEqual([]);
	});

	it("does not download artifacts whose declared size exceeds the cap", async () => {
		const getArtifactZip = vi.fn(async () => zipBytes);
		const client = makeClient({
			getArtifactZip,
			async get<T>(path: string): Promise<T> {
				if (/\/actions\/runs\?/.test(path)) {
					return {
						workflow_runs: [
							{
								id: 100,
								head_sha: "abc",
								status: "completed",
								conclusion: "success",
							},
						],
					} as T;
				}
				return {
					artifacts: [
						{
							id: 9,
							name: "junit-report",
							size_in_bytes: 50 * 1024 * 1024 + 1,
						},
					],
				} as T;
			},
		});

		await fetchGithubActionsRuns(client, { owner: "acme", repo: "store" });

		expect(getArtifactZip).not.toHaveBeenCalled();
	});

	it("holds the cursor below an in-progress run with a lower id", async () => {
		// Regression: the listing used to request `status=completed`, so run 100
		// (still going) was invisible and the cursor jumped to 101 — run 100's
		// results could then never be fetched. The queue must also be listed.
		const listPaths: string[] = [];
		const client = makeClient({
			async get<T>(path: string): Promise<T> {
				if (/\/actions\/runs\?/.test(path)) {
					listPaths.push(path);
					return {
						workflow_runs: [
							{
								id: 101,
								name: "unit",
								head_branch: "main",
								head_sha: "def456",
								status: "completed",
								conclusion: "success",
							},
							{
								id: 100,
								name: "e2e",
								head_branch: "main",
								head_sha: "abc123",
								status: "in_progress",
								conclusion: null,
							},
						],
					} as T;
				}
				return { artifacts: [] } as T;
			},
		});

		const { runs, newCursor } = await fetchGithubActionsRuns(client, {
			owner: "acme",
			repo: "store",
			sinceRunId: 99,
		});

		expect(listPaths[0]).not.toContain("status=completed");
		expect(runs.map((r) => r.externalRunId)).toEqual(["101"]);
		expect(newCursor).toBe(99);
	});
});
