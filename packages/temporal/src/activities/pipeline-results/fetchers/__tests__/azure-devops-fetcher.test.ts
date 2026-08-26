import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { type AdoClient, fetchAzureDevOpsRuns } from "../azure-devops-fetcher";

// Real ADO payloads captured live from example-org (acme-store CI, test run id 2:
// 5 tests, 4 passed + 1 deliberately failing). Using the actual responses keeps
// the fetcher honest against the real API shape, not an assumed one.
const fx = (name: string) =>
	JSON.parse(
		readFileSync(new URL(`./fixtures/${name}`, import.meta.url), "utf8"),
	);

const client: AdoClient = {
	async get<T>(path: string): Promise<T> {
		if (/\/_apis\/test\/runs\?/.test(path)) {
			return fx("ado-runs-list.json");
		}
		if (/\/test\/Runs\/2\/results/.test(path)) {
			return fx("ado-run-results.json");
		}
		if (/\/test\/Runs\/2\?/.test(path)) {
			return fx("ado-run-detail.json");
		}
		throw new Error(`unexpected path: ${path}`);
	},
};

describe("fetchAzureDevOpsRuns (real example-org payloads)", () => {
	it("fetches list → detail → results and normalizes a real run", async () => {
		const { runs, newCursor } = await fetchAzureDevOpsRuns(client, {
			project: "Fabric",
		});

		expect(runs).toHaveLength(1);
		expect(newCursor).toBe(2);

		const r = runs[0];
		expect(r.provider).toBe("azure-devops");
		expect(r.externalRunId).toBe("2");
		expect(r.pipelineName).toBe("acme-store unit tests");
		expect(r.branch).toBe("refs/heads/qa-demo");
		expect(r.results).toHaveLength(5);

		// The raw provider tokens are preserved (status-mapper classifies later).
		expect(r.results.filter((t) => t.rawStatus === "Passed")).toHaveLength(
			4,
		);
		const failed = r.results.find((t) => t.rawStatus === "Failed");
		expect(failed?.name).toBe("cart > applies a percentage discount");
		expect(failed?.classname).toBe("test/cart.test.js");
		expect(failed?.failureMessage).toContain("expected -100 to be 80");
	});

	it("respects the incremental cursor — a run at/below the cursor is skipped", async () => {
		const { runs, newCursor } = await fetchAzureDevOpsRuns(client, {
			project: "Fabric",
			sinceRunId: 2,
		});
		expect(runs).toHaveLength(0);
		expect(newCursor).toBe(2);
	});

	it("holds the cursor below a run that has not completed", async () => {
		// Regression: run ids are allocated at start, so a long run can carry a
		// lower id than a newer one that finishes first. Advancing past it lost
		// its results permanently once it completed.
		const inFlight: AdoClient = {
			async get<T>(path: string): Promise<T> {
				if (/\/_apis\/test\/runs\?/.test(path)) {
					return {
						value: [
							{ id: 4, state: "Completed" },
							{ id: 3, state: "InProgress" },
						],
					} as T;
				}
				if (/\/test\/Runs\/4\/results/.test(path)) {
					return { value: [] } as T;
				}
				if (/\/test\/Runs\/4\?/.test(path)) {
					return { id: 4, name: "later run" } as T;
				}
				throw new Error(`unexpected path: ${path}`);
			},
		};

		const { runs, newCursor } = await fetchAzureDevOpsRuns(inFlight, {
			project: "Fabric",
			sinceRunId: 2,
		});
		expect(runs.map((r) => r.externalRunId)).toEqual(["4"]);
		expect(newCursor).toBe(2);
	});

	it("honours the QA branch override", async () => {
		// Regression: ADO ignored the per-repo branch entirely — the Settings
		// field rendered for ADO repos and the sync log claimed a branch filter
		// that was never applied, so runs from every branch were ingested.
		const branchClient: AdoClient = {
			async get<T>(path: string): Promise<T> {
				if (/\/_apis\/test\/runs\?/.test(path)) {
					return {
						value: [
							{ id: 11, state: "Completed" },
							{ id: 10, state: "Completed" },
						],
					} as T;
				}
				if (/\/test\/Runs\/\d+\/results/.test(path)) {
					return { value: [] } as T;
				}
				if (/\/test\/Runs\/11\?/.test(path)) {
					return {
						id: 11,
						name: "on main",
						buildConfiguration: { branchName: "refs/heads/main" },
					} as T;
				}
				if (/\/test\/Runs\/10\?/.test(path)) {
					return {
						id: 10,
						name: "on qa-demo",
						buildConfiguration: {
							branchName: "refs/heads/qa-demo",
						},
					} as T;
				}
				throw new Error(`unexpected path: ${path}`);
			},
		};

		const { runs, newCursor } = await fetchAzureDevOpsRuns(branchClient, {
			project: "Fabric",
			sinceRunId: 9,
			branch: "qa-demo",
		});

		// Only the qa-demo run is ingested, but the cursor still advances past
		// the main-branch run — otherwise it would be re-listed every sync.
		expect(runs.map((r) => r.externalRunId)).toEqual(["10"]);
		expect(newCursor).toBe(11);
	});

	it("treats a bare branch name and a full ref as the same branch", async () => {
		const client2: AdoClient = {
			async get<T>(path: string): Promise<T> {
				if (/\/_apis\/test\/runs\?/.test(path)) {
					return { value: [{ id: 12, state: "Completed" }] } as T;
				}
				if (/\/test\/Runs\/12\/results/.test(path)) {
					return { value: [] } as T;
				}
				if (/\/test\/Runs\/12\?/.test(path)) {
					return {
						id: 12,
						buildConfiguration: { branchName: "main" },
					} as T;
				}
				throw new Error(`unexpected path: ${path}`);
			},
		};
		const { runs } = await fetchAzureDevOpsRuns(client2, {
			project: "Fabric",
			sinceRunId: 11,
			branch: "refs/heads/main",
		});
		expect(runs).toHaveLength(1);
	});

	it("keeps completed test runs that do not report a build branch", async () => {
		const branchless: AdoClient = {
			async get<T>(path: string): Promise<T> {
				if (/\/_apis\/test\/runs\?/.test(path)) {
					return { value: [{ id: 13, state: "Completed" }] } as T;
				}
				if (/\/test\/Runs\/13\/results/.test(path)) {
					return { value: [] } as T;
				}
				if (/\/test\/Runs\/13\?/.test(path)) {
					return { id: 13, name: "manual test plan" } as T;
				}
				throw new Error(`unexpected path: ${path}`);
			},
		};

		const { runs, newCursor } = await fetchAzureDevOpsRuns(branchless, {
			project: "Fabric",
			sinceRunId: 12,
			branch: "main",
		});

		expect(runs.map((run) => run.externalRunId)).toEqual(["13"]);
		expect(newCursor).toBe(13);
	});

	it("holds the cursor below a run whose detail fetch failed", async () => {
		const partialFailure: AdoClient = {
			async get<T>(path: string): Promise<T> {
				if (/\/_apis\/test\/runs\?/.test(path)) {
					return {
						value: [
							{ id: 15, state: "Completed" },
							{ id: 14, state: "Completed" },
						],
					} as T;
				}
				if (/\/test\/Runs\/14\?/.test(path)) {
					throw new Error("temporary ADO failure");
				}
				if (/\/test\/Runs\/15\?/.test(path)) {
					return { id: 15, name: "later run" } as T;
				}
				if (/\/test\/Runs\/15\/results/.test(path)) {
					return { value: [] } as T;
				}
				throw new Error(`unexpected path: ${path}`);
			},
		};

		const { runs, newCursor } = await fetchAzureDevOpsRuns(partialFailure, {
			project: "Fabric",
			sinceRunId: 13,
		});

		expect(runs.map((run) => run.externalRunId)).toEqual(["15"]);
		expect(newCursor).toBe(13);
	});
});
