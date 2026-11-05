import { beforeEach, describe, expect, it, vi } from "vitest";

const m = vi.hoisted(() => ({
	listCases: vi.fn(),
	createCase: vi.fn(),
	updateCase: vi.fn(),
	archiveCase: vi.fn(),
	start: vi.fn(),
	get: vi.fn(),
	listRuns: vi.fn(),
	cancel: vi.fn(),
	compare: vi.fn(),
	read: vi.fn(),
	output: vi.fn(),
	error: vi.fn((message: string) => {
		throw new Error(message);
	}),
}));
vi.mock("node:fs/promises", () => ({ readFile: m.read }));
vi.mock("../src/lib/client.js", () => ({
	getClient: () => ({ agentTests: m }),
}));
vi.mock("../src/lib/context.js", () => ({
	resolveContext: (_project: unknown, org?: string) => ({
		type: "org",
		slug: org ?? "example-org",
	}),
}));
vi.mock("../src/lib/output.js", () => ({
	printOutput: m.output,
	printError: m.error,
}));

import { buildAgentTestsCommand } from "../src/commands/agents/tests.js";

const run = (args: string[]) =>
	buildAgentTestsCommand().exitOverride().parseAsync(args, { from: "user" });
beforeEach(() => {
	vi.clearAllMocks();
	for (const name of [
		"listCases",
		"createCase",
		"updateCase",
		"archiveCase",
		"start",
		"get",
		"listRuns",
		"cancel",
		"compare",
	] as const) {
		m[name].mockResolvedValue({ id: "example-result" });
	}
});
describe("saved agent test CLI", () => {
	it.each([["case", "create"], ["run"]])(
		"preserves exact JSON for %j",
		async (...args) => {
			const request = {
				instanceId: "example-agent",
				caseId: "example-case",
				caseRevision: 2,
				idempotencyKey: "7279e1aa-5913-44bf-a9ce-e57358f977dd",
			};
			m.read.mockResolvedValue(Buffer.from(JSON.stringify(request)));
			await run([...args, "example.json", "--org", "example-org"]);
			expect(
				args[0] === "case" ? m.createCase : m.start,
			).toHaveBeenCalledWith(request, { org: "example-org" });
		},
	);
	it("preserves revision and identity on update and archive", async () => {
		const request = {
			revision: 2,
			name: "Delivery",
			input: "Summarize",
			checks: { requiredPhrases: ["Ready"] },
		};
		m.read.mockResolvedValue(Buffer.from(JSON.stringify(request)));
		await run(["case", "update", "example-case", "example.json"]);
		expect(m.updateCase).toHaveBeenCalledWith("example-case", request, {
			org: "example-org",
		});
		await run(["case", "archive", "example-case", "--revision", "2"]);
		expect(m.archiveCase).toHaveBeenCalledWith("example-case", 2, {
			org: "example-org",
		});
	});
	it("routes history, case pagination and compare", async () => {
		await run([
			"case",
			"list",
			"example-agent",
			"--limit",
			"5",
			"--cursor",
			"example-next",
		]);
		expect(m.listCases).toHaveBeenCalledWith("example-agent", {
			org: "example-org",
			limit: 5,
			cursor: "example-next",
		});
		await run(["history", "example-case", "--limit", "5"]);
		expect(m.listRuns).toHaveBeenCalledWith("example-case", {
			org: "example-org",
			limit: 5,
			cursor: undefined,
		});
		await run(["compare", "example-base", "example-next"]);
		expect(m.compare).toHaveBeenCalledWith("example-base", "example-next", {
			org: "example-org",
		});
	});
	it.each(["get", "cancel"])(
		"routes %s to the exact run",
		async (command) => {
			await run([command, "example-run"]);
			expect(m[command as "get"]).toHaveBeenCalledWith("example-run", {
				org: "example-org",
			});
		},
	);
	it.each(["0", "51", "1.1", "-1"])(
		"rejects invalid limit %s",
		async (limit) => {
			await expect(
				run(["history", "example-case", "--limit", limit]),
			).rejects.toThrow("--limit");
			expect(m.listRuns).not.toHaveBeenCalled();
		},
	);
	it.each([undefined, "0", "-1", "1.1"])(
		"requires a positive archive revision %s",
		async (revision) => {
			await expect(
				run([
					"case",
					"archive",
					"example-case",
					...(revision ? ["--revision", revision] : []),
				]),
			).rejects.toThrow("--revision");
			expect(m.archiveCase).not.toHaveBeenCalled();
		},
	);
	it("rejects oversized request files before calling the API", async () => {
		m.read.mockResolvedValue(Buffer.alloc(132000));
		await expect(run(["run", "example.json"])).rejects.toThrow("128 KiB");
		expect(m.start).not.toHaveBeenCalled();
	});
});
