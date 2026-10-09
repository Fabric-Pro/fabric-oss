/**
 * What `fabric instructions` prints when a run ends (Fizzy #2878), end to end
 * with the SDK mocked at `getClient`: failures are fixed sentences, nothing a
 * server or the operating system wrote reaches a person or an agent unless
 * `FABRIC_DEBUG=1` asks for it, a deployment's upgrade line is shown once
 * (on stdout under a hook, never acted on), and no text names an absolute path
 * the person did not type.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { recordUpgradeNotice } from "../src/lib/user-agent.js";
import { useEmptyMachine } from "./helpers/empty-machine.js";
import {
	makeTree,
	manifestEntry,
	resetInstructionsMocks,
	runCli,
	seedLock,
	seedRawLock,
	snapshotFor,
} from "./helpers/instructions-commands.js";

const { mocks } = vi.hoisted(() => ({
	mocks: {
		getPublished: vi.fn(),
		createDownloadUrl: vi.fn(),
		getApiKey: vi.fn<(origin?: string) => string | undefined>(),
		getConfigPath: vi.fn<() => string>(),
		getDefaultContext: vi.fn<() => unknown>(),
		withoutContext: vi.fn(),
		getClient: vi.fn(),
	},
}));

vi.mock("../src/lib/config.js", () => ({
	getApiKey: mocks.getApiKey,
	getOAuth: () => undefined,
	listProjectSignIns: () => [],
	getConfigPath: mocks.getConfigPath,
	getBaseUrl: () => undefined,
	getDefaultContext: mocks.getDefaultContext,
	getOutputFormat: () => "table",
}));

vi.mock("../src/lib/client.js", () => {
	const client = {
		instructions: {
			getPublished: mocks.getPublished,
			createDownloadUrl: mocks.createDownloadUrl,
		},
		withoutContext: () => {
			mocks.withoutContext();
			return client;
		},
	};
	return {
		getClient: (overrides: unknown) => {
			mocks.getClient(overrides);
			return client;
		},
	};
});

const UPGRADE_LINE =
	"This CLI is older than the deployment expects. Run: npx -y https://fabric.pro/cli/fabric-0.6.0.tgz instructions init";

function requestError(message: string, status: number, code?: string) {
	return Object.assign(new Error(message), { status, code });
}

beforeEach(() => {
	resetInstructionsMocks(mocks);
	useEmptyMachine();
	delete process.env.FABRIC_DEBUG;
});

afterEach(() => {
	delete process.env.FABRIC_DEBUG;
	vi.restoreAllMocks();
});

const UNPUBLISHED = { published: false, sourceOfTruth: "UPLOAD" } as const;

describe("a failed request, by hand", () => {
	it.each([
		[404, 4, "✗ Project not found, or you cannot see it.\n"],
		[
			403,
			5,
			"✗ You do not have access to this project's coding instructions. Ask a project maintainer for access.\n",
		],
		[429, 6, "✗ Too many requests. Wait a minute and try again.\n"],
		[
			500,
			1,
			"✗ https://fabric.pro had a problem answering. Try again in a moment.\n",
		],
	])(
		"says a fixed sentence for %i, with its documented exit code",
		async (status, code, stderr) => {
			const dest = await makeTree();
			mocks.getPublished.mockRejectedValue(
				requestError(
					"secret-tenant-name at /srv/app/handler.ts",
					status,
				),
			);

			const result = await runCli([
				"check",
				"--project",
				"project-1",
				"--dest",
				dest,
			]);

			expect(result.code).toBe(code);
			expect(result.stderr).toBe(stderr);
		},
	);

	it("shows the original only when FABRIC_DEBUG=1 asks, on its own line", async () => {
		process.env.FABRIC_DEBUG = "1";
		const dest = await makeTree();
		mocks.getPublished.mockRejectedValue(
			requestError("upstream said no", 500),
		);

		const result = await runCli([
			"check",
			"--project",
			"project-1",
			"--dest",
			dest,
		]);

		expect(result.stderr).toBe(
			"debug: upstream said no\n✗ https://fabric.pro had a problem answering. Try again in a moment.\n",
		);
	});

	it("takes the folder the person did not type out of a message this CLI wrote", async () => {
		const dest = await makeTree();
		vi.spyOn(process, "cwd").mockReturnValue(dest);
		await seedRawLock(dest, "{ not json");
		mocks.getPublished.mockResolvedValue({
			published: true,
			sourceOfTruth: "UPLOAD",
			snapshot: snapshotFor([]),
			manifest: [],
		});

		const result = await runCli(["check", "--project", "project-1"]);

		expect(result.code).toBe(1);
		expect(result.stderr).toMatch(
			/^✗ this folder[\\/]\.fabric[\\/]instructions\.lock is unreadable: it is not valid JSON\./,
		);
		expect(result.stderr).not.toContain(dest);
	});

	it("keeps the folder when --dest typed it", async () => {
		const dest = await makeTree();
		await seedRawLock(dest, "{ not json");
		mocks.getPublished.mockResolvedValue({
			published: true,
			sourceOfTruth: "UPLOAD",
			snapshot: snapshotFor([]),
			manifest: [],
		});

		const result = await runCli([
			"check",
			"--project",
			"project-1",
			"--dest",
			dest,
		]);

		expect(result.stderr).toContain(dest);
	});

	it("takes a digest out of a manifest's own mismatch message", async () => {
		const dest = await makeTree();
		const manifest = [manifestEntry("AGENTS.md", "hello\n")];
		mocks.getPublished.mockResolvedValue({
			published: true,
			sourceOfTruth: "UPLOAD",
			snapshot: { ...snapshotFor(manifest), digest: "d".repeat(64) },
			manifest,
		});

		const result = await runCli([
			"sync",
			"--project",
			"project-1",
			"--dest",
			dest,
		]);

		expect(result.code).toBe(1);
		expect(result.stderr).toContain(
			"does not match its own digest (<digest>)",
		);
		expect(result.stderr).not.toMatch(/\b[0-9a-f]{64}\b/);
	});
});

describe("a failed request, under a hook", () => {
	it("is a fixed sentence on stderr, and stdout stays empty", async () => {
		const dest = await makeTree();
		mocks.getPublished.mockRejectedValue(
			requestError("secret-tenant-name", 503),
		);

		const result = await runCli([
			"sync",
			"--project",
			"project-1",
			"--dest",
			dest,
			"--hook",
		]);

		expect(result).toEqual({
			code: 0,
			stdout: "",
			stderr: "fabric: coding instructions sync skipped: https://fabric.pro had a problem answering. Try again in a moment.\n",
		});
	});
});

describe("the deployment's upgrade line", () => {
	it("is printed once on stdout under a hook, after the run, and nothing is updated", async () => {
		const dest = await makeTree();
		mocks.getPublished.mockImplementation(async () => {
			recordUpgradeNotice(UPGRADE_LINE);
			recordUpgradeNotice("a later line is ignored");
			return UNPUBLISHED;
		});

		const result = await runCli([
			"check",
			"--project",
			"project-1",
			"--dest",
			dest,
			"--hook",
		]);

		expect(result).toEqual({
			code: 0,
			stdout: `This project has no published coding instructions yet.\n${UPGRADE_LINE}\n`,
			stderr: "",
		});
	});

	it("goes to stderr when a person runs the command, so stdout stays what they asked for", async () => {
		const dest = await makeTree();
		mocks.getPublished.mockImplementation(async () => {
			recordUpgradeNotice(UPGRADE_LINE);
			return UNPUBLISHED;
		});

		const result = await runCli([
			"check",
			"--project",
			"project-1",
			"--dest",
			dest,
			"--format",
			"json",
		]);

		expect(result.code).toBe(0);
		expect(result.stderr).toBe(`${UPGRADE_LINE}\n`);
		expect(() => JSON.parse(result.stdout)).not.toThrow();
	});

	it("is not printed when the deployment sent none", async () => {
		const dest = await makeTree();
		mocks.getPublished.mockResolvedValue(UNPUBLISHED);

		const result = await runCli([
			"check",
			"--project",
			"project-1",
			"--dest",
			dest,
			"--hook",
		]);

		expect(result.stdout).not.toContain("older than the deployment");
	});

	it("a 426 under a hook is that one line on stdout, exit 0, nothing on stderr", async () => {
		const dest = await makeTree();
		mocks.getPublished.mockImplementation(async () => {
			recordUpgradeNotice(UPGRADE_LINE);
			throw requestError("Upgrade Required", 426);
		});

		const result = await runCli([
			"check",
			"--project",
			"project-1",
			"--dest",
			dest,
			"--hook",
		]);

		expect(result).toEqual({
			code: 0,
			stdout: `${UPGRADE_LINE}\n`,
			stderr: "",
		});
	});

	it("a 426 by hand is exit 2 with the line, said once", async () => {
		const dest = await makeTree();
		mocks.getPublished.mockImplementation(async () => {
			recordUpgradeNotice(UPGRADE_LINE);
			throw requestError("Upgrade Required", 426);
		});

		const result = await runCli([
			"check",
			"--project",
			"project-1",
			"--dest",
			dest,
		]);

		expect(result.code).toBe(2);
		expect(result.stderr).toBe(`✗ ${UPGRADE_LINE}\n`);
	});

	it("a 426 that brought no line says the fixed one", async () => {
		const dest = await makeTree();
		mocks.getPublished.mockRejectedValue(
			requestError("Upgrade Required", 426),
		);

		const result = await runCli([
			"check",
			"--project",
			"project-1",
			"--dest",
			dest,
		]);

		expect(result.code).toBe(2);
		expect(result.stderr).toBe(
			"✗ This CLI is older than the deployment expects. Run: npm install -g @fabricorg/cli\n",
		);
	});
});

describe("no absolute path unless --dest was typed", () => {
	function published(files: ReturnType<typeof manifestEntry>[]) {
		return {
			published: true,
			sourceOfTruth: "UPLOAD",
			snapshot: snapshotFor(files),
			manifest: files,
		};
	}

	it("check, on a folder never synced, says this folder", async () => {
		const dest = await makeTree();
		vi.spyOn(process, "cwd").mockReturnValue(dest);
		mocks.getPublished.mockResolvedValue(published([]));

		const result = await runCli(["check", "--project", "project-1"]);

		expect(result.stdout).toContain(
			"Coding instructions have not been synced into this folder yet",
		);
		expect(result.stdout).not.toContain(dest);
	});

	it("check --verify says this folder when every file matches", async () => {
		const dest = await makeTree();
		vi.spyOn(process, "cwd").mockReturnValue(dest);
		await seedLock(dest, snapshotFor([]).digest, {});
		mocks.getPublished.mockResolvedValue({
			...published([]),
			unchanged: true,
			manifest: undefined,
		});

		const result = await runCli([
			"check",
			"--project",
			"project-1",
			"--verify",
		]);

		expect(result.stdout).toContain(
			"Every file in this folder matches the lock.",
		);
		expect(result.stdout).not.toContain(dest);
	});

	it("sync no longer prints where its lock is, or any digest", async () => {
		const dest = await makeTree();
		mocks.getPublished.mockResolvedValue({
			...published([manifestEntry("AGENTS.md", "hello\n")]),
			unchanged: false,
		});

		const result = await runCli([
			"sync",
			"--project",
			"project-1",
			"--dest",
			dest,
			"--dry-run",
		]);

		expect(result.code).toBe(0);
		expect(result.stdout).toContain(
			"Would apply coding instructions version 7",
		);
		expect(result.stdout).not.toContain("Lock:");
		expect(result.stdout).not.toMatch(/\b[0-9a-f]{64}\b/);
	});

	it("doctor names a folder in its header only when --dest was typed", async () => {
		const dest = await makeTree();
		mocks.getPublished.mockResolvedValue(UNPUBLISHED);

		vi.spyOn(process, "cwd").mockReturnValue(dest);
		const untyped = await runCli(["doctor", "--project", "project-1"]);
		const typed = await runCli([
			"doctor",
			"--project",
			"project-1",
			"--dest",
			dest,
		]);

		expect(untyped.stdout.split("\n")[0]).toBe(
			"Coding instructions doctor: project project-1",
		);
		expect(untyped.stdout).not.toContain(dest);
		expect(typed.stdout.split("\n")[0]).toBe(
			`Coding instructions doctor: project project-1 in ${dest}`,
		);
	});
});
