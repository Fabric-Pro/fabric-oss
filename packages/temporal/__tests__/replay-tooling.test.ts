import { mkdir, mkdtemp, readdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { Client } from "@temporalio/client";
import { historyFromJSON } from "@temporalio/common/lib/proto-utils";
import { afterEach, describe, expect, it, vi } from "vitest";
import { fetchHistories } from "../scripts/fetch-replay-histories";
import { loadHistoriesForType } from "../scripts/replay-fixtures";
import { exampleHistory } from "./helpers/replay-history";

vi.mock("../src/client", () => ({
	getTemporalConfig: vi.fn(() => {
		throw new Error("No connections allowed");
	}),
}));
const dirs: string[] = [];
afterEach(async () => {
	vi.restoreAllMocks();
	await Promise.all(
		dirs.splice(0).map((dir) => rm(dir, { recursive: true, force: true })),
	);
});
async function root() {
	const dir = await mkdtemp(join(tmpdir(), "replay-example-"));
	dirs.push(dir);
	return dir;
}
async function fixture(
	dir: string,
	stage: "delayed" | "scheduled" | "started",
) {
	await mkdir(join(dir, "exampleWorkflow"), { recursive: true });
	await writeFile(
		join(dir, "exampleWorkflow", `${stage}.json`),
		JSON.stringify({
			workflowId: "wf-example-1",
			history: exampleHistory(stage),
		}),
	);
}
describe("replay fixture eligibility", () => {
	it("drops a delayed start quickly instead of sending it to replay", async () => {
		const dir = await root();
		await fixture(dir, "delayed");
		expect(await loadHistoriesForType(dir, "exampleWorkflow")).toHaveLength(
			0,
		);
	});
	it("reports dropped counts per type and retains only started tasks", async () => {
		const dir = await root();
		await fixture(dir, "delayed");
		await fixture(dir, "scheduled");
		await fixture(dir, "started");
		const log = vi.spyOn(console, "log");
		expect(
			await loadHistoriesForType(dir, "exampleWorkflow", true),
		).toHaveLength(1);
		expect(log).toHaveBeenCalledWith(
			expect.stringMatching(
				/exampleWorkflow.*2.*no started workflow task/,
			),
		);
	});
	it("fails required coverage when the fetch wrote only unstarted histories", async () => {
		const dir = await root();
		await fixture(dir, "delayed");
		await expect(
			loadHistoriesForType(dir, "exampleWorkflow", true),
		).rejects.toThrow(
			/fetch wrote histories with no workflow task.*should have excluded/,
		);
	});
	it("does not turn an unparseable fixture into a skip", async () => {
		const dir = await root();
		await fixture(dir, "delayed");
		await writeFile(join(dir, "exampleWorkflow", "delayed.json"), "{");
		await expect(
			loadHistoriesForType(dir, "exampleWorkflow"),
		).rejects.toThrow();
	});
	it("rejects a JSON fixture that the SDK cannot parse", async () => {
		const dir = await root();
		await fixture(dir, "delayed");
		await writeFile(
			join(dir, "exampleWorkflow", "delayed.json"),
			JSON.stringify({
				workflowId: "wf-example-1",
				history: {
					events: [
						{ eventType: "EVENT_TYPE_WORKFLOW_EXECUTION_STARTED" },
					],
				},
			}),
		);
		await expect(
			loadHistoriesForType(dir, "exampleWorkflow"),
		).rejects.toThrow(/Missing attributes/);
	});
	it("fetch saves a started task and counts only saved histories", async () => {
		const dir = await root();
		const client = {
			workflow: {
				async *list({ query }: { query: string }) {
					if (query.includes('ExecutionStatus = "Running"')) {
						for (const workflowId of [
							"delayed",
							"scheduled",
							"started",
						]) {
							yield {
								type: "exampleWorkflow",
								workflowId,
								runId: "example-run",
							};
						}
					}
				},
				getHandle: (stage: "delayed" | "scheduled" | "started") => ({
					fetchHistory: async () =>
						historyFromJSON(exampleHistory(stage)),
				}),
			},
		} as unknown as Client;
		const result = await fetchHistories(client, 1, 1, 3, dir);
		expect(result.total).toBe(1);
		expect(result.counts.get("exampleWorkflow")).toEqual({
			closed: 0,
			running: 1,
		});
		expect(await readdir(join(dir, "exampleWorkflow"))).toHaveLength(1);
		const histories = await loadHistoriesForType(
			dir,
			"exampleWorkflow",
			true,
		);
		expect(histories).toHaveLength(1);
		expect(histories[0].workflowId).toBe("started");
	});

	it("fetch skips and logs an unstarted execution without creating its directory", async () => {
		const dir = await root();
		const log = vi.spyOn(console, "log");
		const client = {
			workflow: {
				async *list({ query }: { query: string }) {
					if (query.includes('ExecutionStatus = "Running"')) {
						yield {
							type: "exampleWorkflow",
							workflowId: "wf-example-1",
							runId: "example-run",
						};
					}
				},
				getHandle: () => ({
					fetchHistory: async () =>
						historyFromJSON(exampleHistory("delayed")),
				}),
			},
		} as unknown as Client;
		const result = await fetchHistories(client, 1, 1, 3, dir);
		expect(result.total).toBe(0);
		expect(result.counts.size).toBe(0);
		expect(await readdir(dir)).toEqual([]);
		expect(log).toHaveBeenCalledWith(
			expect.stringMatching(
				/exampleWorkflow.*skipped.*no started workflow task/,
			),
		);
	});
});
