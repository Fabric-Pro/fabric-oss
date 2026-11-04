import { mkdtemp, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { Command, CommanderError } from "commander";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { buildContextCommand } from "../src/commands/context/index.js";

const mocks = vi.hoisted(() => ({
	inspect: vi.fn(),
	evaluate: vi.fn(),
	getClient: vi.fn(),
	withoutContext: vi.fn(),
	capabilities: vi.fn(),
	createRun: vi.fn(),
	listRuns: vi.fn(),
	getRun: vi.fn(),
	cancelRun: vi.fn(),
	compareRuns: vi.fn(),
}));

vi.mock("../src/lib/client.js", () => ({ getClient: mocks.getClient }));
vi.mock("../src/lib/config.js", () => ({
	getApiKey: () => "synthetic-key",
	getBaseUrl: () => undefined,
	getConfigPath: () => "/tmp/example-fabric-context-config.json",
	getDefaultContext: () => undefined,
	getOutputFormat: () => "table",
}));

const input = {
	version: 1,
	sources: [{ sourceId: "source-1", expectedRevision: "a".repeat(64) }],
	cases: [
		{
			id: "case-1",
			recordedAnswer: "Example answer",
			retrievedSourceIds: ["source-1"],
			citedSourceIds: ["source-1"],
			expectations: {
				expectedSourceIds: ["source-1"],
				requiredPhrases: ["Example"],
				forbiddenPhrases: [],
			},
		},
	],
};

class ExitSignal extends Error {
	constructor(readonly code: number) {
		super(`exit ${code}`);
	}
}

const roots: string[] = [];

async function file(
	contents: string | Buffer = JSON.stringify(input),
): Promise<string> {
	const root = await mkdtemp(path.join(tmpdir(), "fabric-quality-test-"));
	roots.push(root);
	const target = path.join(root, "evaluation.json");
	await writeFile(target, contents);
	return target;
}

async function runCli(args: string[]) {
	let stdout = "";
	let stderr = "";
	const out = vi
		.spyOn(process.stdout, "write")
		.mockImplementation((chunk: unknown) => {
			stdout += String(chunk);
			return true;
		});
	const err = vi
		.spyOn(process.stderr, "write")
		.mockImplementation((chunk: unknown) => {
			stderr += String(chunk);
			return true;
		});
	const exit = vi.spyOn(process, "exit").mockImplementation((code) => {
		throw new ExitSignal(Number(code ?? 0));
	});
	let code = 0;
	try {
		const program = new Command("fabric")
			.exitOverride()
			.option("--base-url <url>", "Fabric deployment")
			.option("--format <format>", "Output format", "table");
		program.addCommand(buildContextCommand());
		await program.parseAsync(args, { from: "user" });
	} catch (error) {
		if (error instanceof ExitSignal) {
			code = error.code;
		} else if (error instanceof CommanderError) {
			code = error.exitCode;
		} else {
			throw error;
		}
	} finally {
		out.mockRestore();
		err.mockRestore();
		exit.mockRestore();
	}
	return { code, stdout, stderr };
}

beforeEach(() => {
	vi.clearAllMocks();
	const client = {
		contextQuality: {
			inspect: mocks.inspect,
			evaluate: mocks.evaluate,
			runs: {
				capabilities: mocks.capabilities,
				create: mocks.createRun,
				list: mocks.listRuns,
				get: mocks.getRun,
				cancel: mocks.cancelRun,
				compare: mocks.compareRuns,
			},
		},
	};
	mocks.withoutContext.mockReturnValue(client);
	mocks.getClient.mockReturnValue({ withoutContext: mocks.withoutContext });
	mocks.inspect.mockResolvedValue({
		sourceId: "source-1",
		revision: "a".repeat(64),
		content: "Example context",
	});
	mocks.evaluate.mockResolvedValue({
		mode: "recorded-output",
		status: "passed",
		counts: { cases: 1, passed: 1, failed: 0 },
	});
	mocks.capabilities.mockResolvedValue({
		configured: true,
		canCreate: true,
		canCancel: true,
		canConfigure: false,
		bindingId: "example-binding",
		reason: null,
	});
	mocks.createRun.mockResolvedValue({
		run: { id: "example-run", status: "QUEUED" },
	});
	mocks.listRuns.mockResolvedValue({ runs: [], nextCursor: null });
	mocks.getRun.mockResolvedValue({
		run: {
			id: "example-run",
			status: "SUCCEEDED",
			report: { status: "failed" },
		},
	});
	mocks.cancelRun.mockResolvedValue({
		run: { id: "example-run", status: "CANCEL_REQUESTED" },
	});
	mocks.compareRuns.mockResolvedValue({
		compatible: false,
		passedDelta: null,
		differences: { dataset: true, configuration: false, scorer: false },
	});
});

describe("fabric context runs", () => {
	const key = "ad760b08-b7dc-4c43-8328-67fd17ba33c9";
	const scope = ["--project", "example-project", "--org", "example-org"];

	it("creates from the bounded file with an explicit binding and reusable key", async () => {
		const target = await file();
		const args = [
			"context",
			"runs",
			"create",
			target,
			...scope,
			"--binding",
			"example-binding",
			"--idempotency-key",
			key,
			"--name",
			"Example evaluation",
		];
		const first = await runCli(args);
		const second = await runCli(args);
		expect(first.code).toBe(0);
		expect(second.code).toBe(0);
		expect(JSON.parse(first.stdout)).toEqual({
			run: { id: "example-run", status: "QUEUED" },
		});
		expect(mocks.createRun).toHaveBeenCalledTimes(2);
		for (const call of mocks.createRun.mock.calls) {
			expect(call).toEqual([
				{
					bindingId: "example-binding",
					idempotencyKey: key,
					name: "Example evaluation",
					evaluation: input,
				},
				{ projectId: "example-project", org: "example-org" },
			]);
		}
		expect(mocks.getClient).toHaveBeenCalledWith({
			project: "example-project",
			baseUrl: undefined,
			retry: { maxRetries: 0 },
		});
		expect(mocks.withoutContext).toHaveBeenCalledTimes(2);
	});

	it("requires the caller's key before creating a client or uploading evidence", async () => {
		const result = await runCli([
			"context",
			"runs",
			"create",
			await file(),
			...scope,
			"--binding",
			"example-binding",
		]);
		expect(result.code).not.toBe(0);
		expect(mocks.getClient).not.toHaveBeenCalled();
		expect(mocks.createRun).not.toHaveBeenCalled();
	});

	it.each([" ", ""])(
		"rejects a blank idempotency key %j",
		async (idempotencyKey) => {
			const result = await runCli([
				"context",
				"runs",
				"create",
				await file(),
				...scope,
				"--binding",
				"example-binding",
				"--idempotency-key",
				idempotencyKey,
			]);
			expect(result.code).toBe(7);
			expect(mocks.getClient).not.toHaveBeenCalled();
		},
	);

	it("uses the same bounded regular-file loader before client creation", async () => {
		const oversized = await file("界".repeat(50_000));
		const invalid = await file('{"synthetic-private-answer":');
		const target = await file();
		const link = path.join(path.dirname(target), "linked-evaluation.json");
		await symlink(target, link);
		for (const candidate of [
			oversized,
			invalid,
			link,
			path.dirname(target),
		]) {
			const result = await runCli([
				"context",
				"runs",
				"create",
				candidate,
				...scope,
				"--binding",
				"example-binding",
				"--idempotency-key",
				key,
			]);
			expect(result.code).toBe(7);
			expect(result.stdout).toBe("");
			expect(result.stderr).not.toContain("synthetic-private-answer");
		}
		expect(mocks.getClient).not.toHaveBeenCalled();
		expect(mocks.createRun).not.toHaveBeenCalled();
	});

	it("returns saved capabilities and forwards pagination in project scope", async () => {
		const capabilities = await runCli([
			"context",
			"runs",
			"capabilities",
			...scope,
		]);
		expect(capabilities.code).toBe(0);
		expect(JSON.parse(capabilities.stdout)).toMatchObject({
			canCreate: true,
		});
		expect(mocks.capabilities).toHaveBeenCalledWith({
			projectId: "example-project",
			org: "example-org",
		});
		const page = await runCli([
			"context",
			"runs",
			"list",
			...scope,
			"--limit",
			"15",
			"--cursor",
			"example-cursor",
		]);
		expect(page.code).toBe(0);
		expect(JSON.parse(page.stdout)).toEqual({ runs: [], nextCursor: null });
		expect(mocks.listRuns).toHaveBeenCalledWith({
			projectId: "example-project",
			org: "example-org",
			limit: 15,
			cursor: "example-cursor",
		});
	});

	it.each(["0", "51", "1.5", "not-a-number"])(
		"handles invalid page size %s inside the safe command boundary",
		async (limit) => {
			const result = await runCli([
				"context",
				"runs",
				"list",
				...scope,
				"--limit",
				limit,
			]);
			expect(result.code).toBe(7);
			expect(result.stderr).toContain("between 1 and 50");
			expect(mocks.getClient).not.toHaveBeenCalled();
		},
	);

	it("keeps execution completion distinct from failed report checks", async () => {
		const result = await runCli([
			"context",
			"runs",
			"get",
			"example-run",
			...scope,
		]);
		expect(result.code).toBe(0);
		expect(JSON.parse(result.stdout)).toMatchObject({
			run: { status: "SUCCEEDED", report: { status: "failed" } },
		});
		expect(mocks.getRun).toHaveBeenCalledWith("example-run", {
			projectId: "example-project",
			org: "example-org",
		});
	});

	it("prints cancellation intent without turning it into confirmation", async () => {
		const result = await runCli([
			"context",
			"runs",
			"cancel",
			"example-run",
			...scope,
		]);
		expect(result.code).toBe(0);
		expect(JSON.parse(result.stdout).run.status).toBe("CANCEL_REQUESTED");
		expect(result.stdout).not.toContain("CANCELLED");
		expect(mocks.cancelRun).toHaveBeenCalledTimes(1);
	});

	it("keeps an incompatible comparison's numeric delta null", async () => {
		const result = await runCli([
			"context",
			"runs",
			"compare",
			"example-baseline",
			"example-candidate",
			...scope,
		]);
		expect(result.code).toBe(0);
		expect(JSON.parse(result.stdout)).toMatchObject({
			compatible: false,
			passedDelta: null,
		});
		expect(mocks.compareRuns).toHaveBeenCalledWith(
			"example-baseline",
			"example-candidate",
			{
				projectId: "example-project",
				org: "example-org",
			},
		);
	});

	it.each([
		[401, 3],
		[403, 5],
		[404, 4],
		[409, 7],
		[412, 7],
		[429, 6],
		[503, 1],
	])(
		"redacts saved-operation HTTP %s errors and exits %s",
		async (status, code) => {
			mocks.createRun.mockRejectedValueOnce(
				Object.assign(new Error("synthetic-private-provider-body"), {
					status,
				}),
			);
			const result = await runCli([
				"context",
				"runs",
				"create",
				await file(),
				...scope,
				"--binding",
				"example-binding",
				"--idempotency-key",
				key,
			]);
			expect(result.code).toBe(code);
			expect(result.stdout).toBe("");
			expect(result.stderr).not.toContain(
				"synthetic-private-provider-body",
			);
			expect(mocks.createRun).toHaveBeenCalledTimes(1);
			if (status === 503) {
				expect(result.stderr).toContain(
					"same input and idempotency key",
				);
			}
		},
	);
});

afterEach(async () => {
	await Promise.all(
		roots
			.splice(0)
			.map((root) => rm(root, { recursive: true, force: true })),
	);
});

describe("fabric context inspect", () => {
	it("prints a JSON snapshot and uses project authentication without ambient organization defaults", async () => {
		const result = await runCli([
			"--base-url",
			"https://example.com",
			"context",
			"inspect",
			"source-1",
			"--project",
			"project-1",
			"--org",
			"example-org",
		]);
		expect(result.code).toBe(0);
		expect(JSON.parse(result.stdout)).toMatchObject({
			sourceId: "source-1",
			content: "Example context",
		});
		expect(result.stderr).toBe("");
		expect(mocks.getClient).toHaveBeenCalledWith({
			project: "project-1",
			baseUrl: "https://example.com",
			retry: { maxRetries: 0 },
		});
		expect(mocks.withoutContext).toHaveBeenCalledTimes(1);
		expect(mocks.inspect).toHaveBeenCalledWith("source-1", {
			projectId: "project-1",
			org: "example-org",
		});
	});

	it("requires a project before making any request", async () => {
		const result = await runCli(["context", "inspect", "source-1"]);
		expect(result.code).not.toBe(0);
		expect(mocks.getClient).not.toHaveBeenCalled();
	});

	it.each([
		[401, 3],
		[403, 5],
		[404, 4],
		[429, 6],
		[503, 1],
	])(
		"maps HTTP %s to exit %s without leaking the remote error body",
		async (status, expectedCode) => {
			mocks.inspect.mockRejectedValueOnce(
				Object.assign(new Error("private source content"), { status }),
			);
			const result = await runCli([
				"context",
				"inspect",
				"source-1",
				"--project",
				"project-1",
			]);
			expect(result.code).toBe(expectedCode);
			expect(result.stdout).toBe("");
			expect(result.stderr).not.toContain("private source content");
		},
	);
});

describe("fabric context evaluate", () => {
	it("reads a required bounded file, forwards recorded evidence, and prints a passed report", async () => {
		const target = await file();
		const result = await runCli([
			"context",
			"evaluate",
			target,
			"--project",
			"project-1",
		]);
		expect(result.code).toBe(0);
		expect(JSON.parse(result.stdout)).toMatchObject({
			mode: "recorded-output",
			status: "passed",
		});
		expect(result.stderr).toBe("");
		expect(mocks.evaluate).toHaveBeenCalledWith(input, {
			projectId: "project-1",
			org: undefined,
		});
	});

	it("returns a failed report as JSON and exits nonzero", async () => {
		mocks.evaluate.mockResolvedValueOnce({
			mode: "recorded-output",
			status: "failed",
			counts: { cases: 1, passed: 0, failed: 1 },
		});
		const result = await runCli([
			"context",
			"evaluate",
			await file(),
			"--project",
			"project-1",
		]);
		expect(result.code).toBe(1);
		expect(JSON.parse(result.stdout)).toMatchObject({ status: "failed" });
		expect(result.stderr).toBe("");
	});

	it("rejects an oversized Unicode file before authentication or upload", async () => {
		const result = await runCli([
			"context",
			"evaluate",
			await file("界".repeat(50_000)),
			"--project",
			"project-1",
		]);
		expect(result.code).toBe(7);
		expect(mocks.getClient).not.toHaveBeenCalled();
		expect(result.stderr).toContain("128 KiB");
	});

	it("rejects a symlink instead of following it", async () => {
		const target = await file();
		const link = path.join(path.dirname(target), "linked.json");
		await symlink(target, link);
		const result = await runCli([
			"context",
			"evaluate",
			link,
			"--project",
			"project-1",
		]);
		expect(result.code).toBe(7);
		expect(mocks.getClient).not.toHaveBeenCalled();
	});

	it("rejects directories and missing files", async () => {
		const target = await file();
		for (const candidate of [path.dirname(target), `${target}.missing`]) {
			const result = await runCli([
				"context",
				"evaluate",
				candidate,
				"--project",
				"project-1",
			]);
			expect(result.code).toBe(7);
		}
		expect(mocks.getClient).not.toHaveBeenCalled();
	});

	it("does not print source text from invalid JSON parser errors", async () => {
		const result = await runCli([
			"context",
			"evaluate",
			await file('{"private-secret":"example-secret"'),
			"--project",
			"project-1",
		]);
		expect(result.code).toBe(7);
		expect(result.stdout).toBe("");
		expect(result.stderr).not.toContain("private-secret");
		expect(result.stderr).not.toContain("example-secret");
		expect(mocks.evaluate).not.toHaveBeenCalled();
	});

	it("rejects invalid UTF-8 rather than replacing bytes", async () => {
		const result = await runCli([
			"context",
			"evaluate",
			await file(Buffer.from([0xff, 0xfe])),
			"--project",
			"project-1",
		]);
		expect(result.code).toBe(7);
		expect(mocks.evaluate).not.toHaveBeenCalled();
	});

	it("requires the versioned recorded-output shape", async () => {
		const result = await runCli([
			"context",
			"evaluate",
			await file('{"version":2,"sources":[],"cases":[]}'),
			"--project",
			"project-1",
		]);
		expect(result.code).toBe(7);
		expect(mocks.evaluate).not.toHaveBeenCalled();
	});

	it("reports stale source revisions without printing remote content", async () => {
		mocks.evaluate.mockRejectedValueOnce(
			Object.assign(new Error("private answer content"), { status: 409 }),
		);
		const result = await runCli([
			"context",
			"evaluate",
			await file(),
			"--project",
			"project-1",
		]);
		expect(result.code).toBe(7);
		expect(result.stderr).toContain("revision changed");
		expect(result.stderr).not.toContain("private answer content");
	});
});
