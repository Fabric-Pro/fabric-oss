import { Command } from "commander";
import { beforeEach, describe, expect, it, vi } from "vitest";

const m = vi.hoisted(() => ({
	run: vi.fn(),
	show: vi.fn(),
	list: vi.fn(),
	artifacts: vi.fn(),
	legacy: vi.fn(),
	configure: vi.fn(),
	distribute: vi.fn(),
	get: vi.fn(),
	read: vi.fn(),
	out: vi.fn(),
	error: vi.fn((message: string) => {
		throw new Error(message);
	}),
}));
vi.mock("node:fs/promises", () => ({
	readFile: vi.fn(),
	open: async () => ({
		stat: async () => ({ isFile: () => true, size: 100 }),
		read: async (buffer: Buffer) => {
			const content = Buffer.from(m.read());
			content.copy(buffer);
			return { bytesRead: content.length };
		},
		close: vi.fn(),
	}),
	writeFile: vi.fn(),
}));
vi.mock("../src/lib/client.js", () => ({
	getClient: () => ({
		reports: {
			executeInstance: m.run,
			getExecution: m.show,
			listInstanceExecutions: m.list,
			listExecutions: m.legacy,
			listArtifacts: m.artifacts,
			configureInstance: m.configure,
			distributeArtifact: m.distribute,
			getInstance: m.get,
		},
	}),
}));
vi.mock("../src/lib/context.js", () => ({
	resolveContext: () => ({ type: "org", slug: "example-org" }),
}));
vi.mock("../src/lib/output.js", () => ({
	printError: m.error,
	printOutput: m.out,
	printRecord: m.out,
}));

import { buildReportsCommand } from "../src/commands/reports/index.js";

const run = (args: string[]) =>
	buildReportsCommand().exitOverride().parseAsync(args, { from: "user" });
beforeEach(() => vi.clearAllMocks());
describe("report lifecycle CLI", () => {
	it("executes with an explicit reusable UUID and no implicit distribution", async () => {
		await run([
			"run",
			"example-report",
			"--request-id",
			"00000000-0000-4000-8000-000000000001",
		]);
		expect(m.run).toHaveBeenCalledWith(
			"example-report",
			{ idempotencyKey: "00000000-0000-4000-8000-000000000001" },
			{ org: "example-org" },
		);
		expect(m.distribute).not.toHaveBeenCalled();
	});
	it("passes reviewed configuration revision and exact artifact hash without creating a run", async () => {
		const update = {
			expectedVersion: 3,
			expectedUpdatedAt: "2026-11-06T00:00:00Z",
			scheduleUpdate: { mode: "off" },
		};
		m.read.mockReturnValue(JSON.stringify(update));
		await run(["configure", "example-report", "--file", "example.json"]);
		expect(m.configure).toHaveBeenCalledWith("example-report", update, {
			org: "example-org",
		});
		const delivery = {
			requestId: "00000000-0000-4000-8000-000000000001",
			expectedArtifactHash: "a".repeat(64),
			recipientUserIds: ["example-member"],
		};
		m.read.mockReturnValue(JSON.stringify(delivery));
		await run([
			"artifacts",
			"distribute",
			"example-artifact",
			"--file",
			"example.json",
		]);
		expect(m.distribute).toHaveBeenCalledWith(
			"example-artifact",
			delivery,
			{ org: "example-org" },
		);
		expect(m.run).not.toHaveBeenCalled();
	});
	it("loads one exact execution status", async () => {
		await run(["executions", "show", "example-run"]);
		expect(m.show).toHaveBeenCalledWith("example-run", {
			org: "example-org",
		});
	});
});

it("pages native executions with a deliberate report ID and passes cursor/filter unchanged", async () => {
	m.list.mockResolvedValue({
		executions: [],
		hasMore: false,
		nextCursor: null,
	});
	await run([
		"executions",
		"list",
		"--report",
		"example-report",
		"--cursor",
		"example-next",
		"--status",
		"FAILED",
		"--format",
		"json",
	]);
	expect(m.list).toHaveBeenCalledWith("example-report", {
		cursor: "example-next",
		status: "FAILED",
		org: "example-org",
		limit: 20,
	});
	m.artifacts.mockResolvedValue({
		artifacts: [],
		hasMore: false,
		nextCursor: null,
	});
	await run([
		"artifacts",
		"list",
		"example-run",
		"--cursor",
		"example-artifacts",
		"--type",
		"PDF",
	]);
	expect(m.artifacts).toHaveBeenCalledWith("example-run", {
		org: "example-org",
		cursor: "example-artifacts",
		limit: 20,
		artifactType: "PDF",
	});
});

it("preserves no-report legacy CLI offset listing separately from native cursor history", async () => {
	m.legacy.mockResolvedValue([]);
	await run(["executions", "list", "--offset", "40", "--format", "json"]);
	expect(m.legacy).toHaveBeenCalledWith({
		org: "example-org",
		limit: 20,
		offset: 40,
		status: undefined,
	});
	expect(m.list).not.toHaveBeenCalled();
});

it("honors the root CLI output option for native and legacy report history", async () => {
	const page = { executions: [], hasMore: false, nextCursor: null };
	m.list.mockResolvedValue(page);
	m.legacy.mockResolvedValue([]);
	for (const native of [true, false]) {
		const program = new Command()
			.option("--format <format>", "Output format", "table")
			.addCommand(buildReportsCommand())
			.exitOverride();
		await program.parseAsync(
			[
				"reports",
				"executions",
				"list",
				...(native ? ["--report", "example-report"] : []),
				"--format",
				"json",
			],
			{ from: "user" },
		);
		expect(m.out).toHaveBeenLastCalledWith(
			native ? page : [],
			expect.objectContaining({ format: "json" }),
		);
	}
});
