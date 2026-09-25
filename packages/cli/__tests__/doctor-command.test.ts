/**
 * `fabric instructions doctor` end to end (Fizzy #2653), with the SDK client
 * mocked at the `getClient` boundary and everything local real: temp
 * checkouts, a temp PATH, real hook files, a real `.mcp.json`, and a real
 * local HTTP server for `--probe-network`.
 *
 * The promises pinned here, beyond "each check says the right thing":
 *
 *  - a missing or wrong key produces a REPORT, never a stack trace;
 *  - no environment variable's value ever reaches stdout, text or JSON;
 *  - nothing named by published or repository content is executed — tools
 *    and `.mcp.json` commands are found by PATH lookup alone;
 *  - diagnostics are content-free: no server message, no URL, no parser
 *    excerpt;
 *  - the JSON is exactly the shared `InstructionChecksReport`, in
 *    `CHECK_IDS` order, and the exit code is 1 exactly when a check fails.
 */
import { createHash } from "node:crypto";
import {
	chmod,
	mkdir,
	mkdtemp,
	readFile,
	realpath,
	rename,
	stat,
	symlink,
	unlink,
	writeFile,
} from "node:fs/promises";
import { createServer, type IncomingHttpHeaders, type Server } from "node:http";
import type { AddressInfo } from "node:net";
import { tmpdir } from "node:os";
import path from "node:path";
import {
	FabricError,
	FabricForbiddenError,
	FabricNotFoundError,
	type PublishedInstructionRepository,
	type PublishedInstructionSource,
} from "@fabricorg/sdk";
import { Command } from "commander";
import { zipSync } from "fflate";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { buildInstructionsCommand } from "../src/commands/instructions/index.js";
import {
	CHECK_IDS,
	CHECK_TITLES,
	type InstructionCheck,
	type InstructionChecksReport,
} from "../src/lib/instructions/checks.js";
import { lockPath, writeLock } from "../src/lib/instructions/lock.js";
import { computeSnapshotDigest } from "../src/lib/instructions/manifest.js";
import { nextLock } from "../src/lib/instructions/plan.js";

const { mocks } = vi.hoisted(() => ({
	mocks: {
		whoami: vi.fn(),
		getPublished: vi.fn(),
		createDownloadUrl: vi.fn(),
		getApiKey: vi.fn<() => string | undefined>(),
		getDefaultContext: vi.fn<() => unknown>(),
		getClient: vi.fn(),
		withoutContext: vi.fn(),
	},
}));

vi.mock("../src/lib/config.js", () => ({
	getApiKey: mocks.getApiKey,
	getConfigPath: () => path.join(tmpdir(), "fabricai", "config.json"),
	getBaseUrl: () => undefined,
	getDefaultContext: mocks.getDefaultContext,
	getOutputFormat: () => "table",
}));

vi.mock("../src/lib/client.js", () => {
	const client = {
		auth: { whoami: mocks.whoami },
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

class ExitSignal extends Error {
	constructor(readonly code: number) {
		super(`exit ${code}`);
	}
}

interface RunResult {
	code: number;
	stdout: string;
	stderr: string;
}

function programWithInstructions(): Command {
	const program = new Command("fabric")
		.exitOverride()
		.option("--format <format>", "Output format", "table");
	program.addCommand(buildInstructionsCommand());
	return program;
}

async function runCli(argv: string[]): Promise<RunResult> {
	let stdout = "";
	let stderr = "";
	const outSpy = vi
		.spyOn(process.stdout, "write")
		.mockImplementation((chunk: unknown) => {
			stdout += String(chunk);
			return true;
		});
	const errSpy = vi
		.spyOn(process.stderr, "write")
		.mockImplementation((chunk: unknown) => {
			stderr += String(chunk);
			return true;
		});
	const exitSpy = vi.spyOn(process, "exit").mockImplementation(((
		code?: number,
	) => {
		throw new ExitSignal(code ?? 0);
	}) as never);

	let code = 0;
	try {
		await programWithInstructions().parseAsync(["instructions", ...argv], {
			from: "user",
		});
	} catch (error) {
		if (error instanceof ExitSignal) {
			code = error.code;
		} else {
			throw error;
		}
	} finally {
		outSpy.mockRestore();
		errSpy.mockRestore();
		exitSpy.mockRestore();
	}
	return { code, stdout, stderr };
}

/**
 * The command's last line promises "a proposed fix for each" failed check.
 * Every report this suite produces is held to it, whatever the test is about.
 */
function expectEveryFailHasFix(report: InstructionChecksReport): void {
	for (const check of report.checks) {
		if (check.status === "fail") {
			expect(
				check.fix?.description,
				`the failing ${check.id} check has no fix`,
			).toMatch(/\S/);
		}
	}
}

/** `doctor --format json`, parsed. */
async function doctorJson(
	dest: string,
	extra: string[] = [],
): Promise<RunResult & { report: InstructionChecksReport }> {
	const result = await runCli([
		"doctor",
		"--project",
		"project-1",
		"--dest",
		dest,
		"--format",
		"json",
		...extra,
	]);
	const report: InstructionChecksReport = JSON.parse(result.stdout);
	expectEveryFailHasFix(report);
	return { ...result, report };
}

function checkOf(
	report: InstructionChecksReport,
	id: InstructionCheck["id"],
): InstructionCheck {
	const found = report.checks.find((check) => check.id === id);
	if (!found) {
		throw new Error(`no ${id} check in the report`);
	}
	return found;
}

// ---------------------------------------------------------------------------
// Fixtures
// ---------------------------------------------------------------------------

function sha256(bytes: string | Uint8Array): string {
	return createHash("sha256")
		.update(typeof bytes === "string" ? Buffer.from(bytes) : bytes)
		.digest("hex");
}

function manifestEntry(filePath: string, contents: string) {
	return {
		path: filePath,
		sha256: sha256(contents),
		size: Buffer.byteLength(contents),
		mode: 0o100644,
		kind: "OTHER" as const,
	};
}

type Entry = ReturnType<typeof manifestEntry>;

function publishedFor(
	manifest: Entry[],
	options: {
		version?: number;
		repository?: boolean;
		id?: string;
		/** Per-snapshot provenance (Fizzy #2709) — distinct from `sourceOfTruth` above. */
		source?: PublishedInstructionSource;
		/**
		 * The project's CURRENT repository-sync configuration (Fizzy #2709),
		 * a top-level sibling of `snapshot` — distinct from both `source`
		 * (per-snapshot provenance) and the `repository` boolean above (which
		 * only drives `sourceOfTruth`). Defaults to `null`, matching what the
		 * real API always sends when the project has no current sync row.
		 */
		repositoryConfig?: PublishedInstructionRepository | null;
	} = {},
) {
	return {
		published: true,
		sourceOfTruth: options.repository ? "REPOSITORY" : "UPLOAD",
		snapshot: {
			id: options.id ?? "snap-7",
			version: options.version ?? 7,
			digest: computeSnapshotDigest(manifest),
			fileCount: manifest.length,
			publishedAt: null,
			...(options.source ? { source: options.source } : {}),
		},
		manifest,
		repository: options.repositoryConfig ?? null,
	};
}

async function makeTree(): Promise<string> {
	return realpath(await mkdtemp(path.join(tmpdir(), "fabric-doctor-")));
}

/** Files at mode 0644 whatever the umask, so a lock's recorded mode matches. */
async function writeTreeFiles(
	root: string,
	files: Record<string, string>,
): Promise<void> {
	for (const [relative, contents] of Object.entries(files)) {
		const target = path.join(root, relative);
		await mkdir(path.dirname(target), { recursive: true });
		await writeFile(target, contents, "utf8");
		await chmod(target, 0o644);
	}
}

/**
 * A synced checkout of `files`: the files on disk, a lock that matches, and
 * the published answer that agrees with both.
 */
async function syncedTree(
	files: Record<string, string>,
	options: { version?: number } = {},
) {
	const dest = await makeTree();
	await writeTreeFiles(dest, files);
	const manifest = Object.entries(files).map(([p, c]) => manifestEntry(p, c));
	const published = publishedFor(manifest, options);
	await writeLock(
		dest,
		nextLock({
			projectId: "project-1",
			snapshot: published.snapshot,
			manifest,
		}),
	);
	mocks.getPublished.mockResolvedValue(published);
	return { dest, manifest, published };
}

async function writeHookFile(
	root: string,
	relative: string,
	commands: string[],
): Promise<void> {
	const target = path.join(root, relative);
	await mkdir(path.dirname(target), { recursive: true });
	await writeFile(
		target,
		JSON.stringify({
			hooks: {
				SessionStart: [
					{
						hooks: commands.map((command) => ({
							type: "command",
							command,
							timeout: 15,
						})),
					},
				],
			},
		}),
		"utf8",
	);
}

const CLAUDE_HOOK = ".claude/settings.local.json";
const CODEX_HOOK = ".codex/hooks.json";
const CANONICAL_CHECK = "fabric instructions check --project project-1 --hook";
const COULD_NOT_RUN_FIX =
	"rerun doctor; if this check keeps failing, report the failure class shown above";
const LOCK_REFUSED =
	"the lock could not be read safely (a symlink, or not a regular file)";
const READ_REFUSED =
	"file could not be read safely (a symlink, or not a regular file)";

/**
 * A PATH directory holding exactly `names`, each an executable that would
 * leave a marker file behind if anything ever ran it.
 */
async function binDirWith(names: string[]): Promise<string> {
	const dir = await makeTree();
	for (const name of names) {
		const target = path.join(dir, name);
		await writeFile(
			target,
			`#!/bin/sh\ntouch "${path.join(dir, `${name}.ran`)}"\n`,
			"utf8",
		);
		await chmod(target, 0o755);
	}
	return dir;
}

async function exists(target: string): Promise<boolean> {
	return stat(target).then(
		() => true,
		() => false,
	);
}

/** Serve one zip from the stubbed global fetch the bundle download uses. */
function stubBundle(files: Record<string, string>): ReturnType<typeof vi.fn> {
	const archive = zipSync(
		Object.fromEntries(
			Object.entries(files).map(([key, value]) => [
				key,
				new Uint8Array(Buffer.from(value)),
			]),
		),
	);
	const fetchMock = vi.fn(
		async () => new Response(archive.slice().buffer, { status: 200 }),
	);
	vi.stubGlobal("fetch", fetchMock);
	return fetchMock;
}

const ORG_KEY = {
	user: { id: "user-1", name: "Example Dev", email: "dev@example.com" },
	keyType: "organization",
	keyPrefix: "org_abc12345",
	scopes: ["instructions:read", "instructions:write"],
	orgs: [],
};

/** Names this suite sets in `process.env`, removed after every test. */
const ENV_NAMES = [
	"DOCTOR_TEST_PRESENT",
	"DOCTOR_TEST_ALSO_PRESENT",
	"DOCTOR_TEST_MISSING_REQUIRED",
	"DOCTOR_TEST_MISSING_OPTIONAL",
	"FABRIC_ORG",
];
const SENTINEL = "sentinel-value-3f9c1b7e-never-printed";
let originalPath: string | undefined;
let binDir: string;

beforeEach(async () => {
	mocks.whoami.mockReset();
	mocks.whoami.mockResolvedValue(ORG_KEY);
	mocks.getPublished.mockReset();
	mocks.createDownloadUrl.mockReset();
	mocks.getApiKey.mockReset();
	mocks.getApiKey.mockReturnValue("org_test");
	mocks.getDefaultContext.mockReset();
	mocks.getDefaultContext.mockReturnValue(undefined);
	mocks.getClient.mockReset();
	mocks.withoutContext.mockReset();
	delete process.env.FABRIC_FORMAT;
	originalPath = process.env.PATH;
	// A PATH of exactly one temp directory, so the developer's real PATH can
	// neither satisfy nor fail a check.
	binDir = await binDirWith(["fabric"]);
	process.env.PATH = binDir;
});

afterEach(() => {
	vi.unstubAllGlobals();
	if (originalPath === undefined) {
		delete process.env.PATH;
	} else {
		process.env.PATH = originalPath;
	}
	for (const name of ENV_NAMES) {
		delete process.env[name];
	}
});

// ---------------------------------------------------------------------------
// auth
// ---------------------------------------------------------------------------
describe("auth", () => {
	it("reports a missing key instead of exiting 3, and skips what needs one", async () => {
		const dest = await makeTree();
		mocks.getApiKey.mockReturnValue(undefined);

		const { code, report, stderr } = await doctorJson(dest);

		expect(code).toBe(1);
		const auth = checkOf(report, "auth");
		expect(auth.status).toBe("fail");
		expect(auth.evidence).toBe("server");
		expect(auth.fix?.command).toBe("fabric auth login --key <api-key>");
		for (const id of [
			"access",
			"published",
			"lock",
			"drift",
			"hook",
			"environment",
			"tools",
		] as const) {
			expect(checkOf(report, id).status).toBe("skip");
		}
		expect(mocks.getClient).not.toHaveBeenCalled();
		expect(mocks.whoami).not.toHaveBeenCalled();
		expect(stderr).toContain("1 check failed");
	});

	it("points a personal key without instructions scope at an organization key", async () => {
		const dest = await makeTree();
		mocks.whoami.mockResolvedValue({
			...ORG_KEY,
			keyType: "personal",
			keyPrefix: "fab_abc12345",
			scopes: ["projects:read"],
		});

		const { code, report } = await doctorJson(dest);

		expect(code).toBe(1);
		const auth = checkOf(report, "auth");
		expect(auth.status).toBe("fail");
		expect(auth.detail).toBe(
			"personal key fab_abc12345 has no instructions:read scope",
		);
		expect(auth.fix?.description).toContain("ORGANIZATION API key");
		expect(auth.fix?.description).toContain("instructions:read");
		expect(checkOf(report, "access").status).toBe("skip");
		expect(mocks.getPublished).not.toHaveBeenCalled();
	});

	it("accepts a legacy wildcard key and names the scope that satisfied it", async () => {
		const dest = await makeTree();
		mocks.whoami.mockResolvedValue({
			...ORG_KEY,
			keyType: "personal",
			keyPrefix: "fab_legacy01",
			scopes: ["*"],
		});
		mocks.getPublished.mockResolvedValue({
			published: false,
			sourceOfTruth: "UPLOAD",
		});

		const { report } = await doctorJson(dest);

		expect(checkOf(report, "auth")).toMatchObject({
			status: "pass",
			detail: "personal key fab_legacy01 with *",
		});
	});

	it("tells an organization key missing the scope to add it", async () => {
		const dest = await makeTree();
		mocks.whoami.mockResolvedValue({
			...ORG_KEY,
			scopes: ["projects:read"],
		});

		const { report } = await doctorJson(dest);

		const auth = checkOf(report, "auth");
		expect(auth.status).toBe("fail");
		expect(auth.detail).toBe(
			"organization key org_abc12345 is missing the instructions:read scope",
		);
		expect(auth.fix?.description).toContain("add instructions:read");
	});

	it("reports a refused key without repeating the server's words", async () => {
		const dest = await makeTree();
		mocks.whoami.mockRejectedValue(
			new FabricError("Invalid API key org_leaky-secret", 401),
		);

		const { stdout, report } = await doctorJson(dest);

		expect(checkOf(report, "auth").detail).toBe(
			"the API key was refused (HTTP 401)",
		);
		expect(stdout).not.toContain("leaky-secret");
	});

	it("turns an exception inside a check into that check's verdict", async () => {
		const dest = await makeTree();
		// `null` makes the check itself throw a TypeError reading a field.
		mocks.whoami.mockResolvedValue(null);

		const { code, report } = await doctorJson(dest);

		expect(code).toBe(1);
		expect(checkOf(report, "auth")).toMatchObject({
			status: "fail",
			detail: "check could not run (TypeError)",
			fix: { description: COULD_NOT_RUN_FIX },
		});
		expect(checkOf(report, "auth").fix?.command).toBeUndefined();
		expect(report.checks).toHaveLength(CHECK_IDS.length);
	});
});

// ---------------------------------------------------------------------------
// access
// ---------------------------------------------------------------------------
describe("access", () => {
	it("tells a missing project permission (403) from a missing project (404)", async () => {
		const dest = await makeTree();
		mocks.getPublished.mockRejectedValueOnce(
			new FabricForbiddenError(
				"No coding-instructions read permission for this project",
			),
		);

		const forbidden = await doctorJson(dest);
		const access403 = checkOf(forbidden.report, "access");
		expect(access403.status).toBe("fail");
		expect(access403.detail).toBe(
			"the server refused this project's coding instructions to this key (HTTP 403)",
		);
		expect(access403.fix?.description).toContain(
			"ask a project maintainer to grant you access to project project-1",
		);
		// Content-free: the server's own sentence is not repeated.
		expect(forbidden.stdout).not.toContain("No coding-instructions read");
		expect(checkOf(forbidden.report, "published").status).toBe("skip");

		mocks.getPublished.mockRejectedValueOnce(
			new FabricNotFoundError("Project"),
		);
		const missing = await doctorJson(dest);
		const access404 = checkOf(missing.report, "access");
		expect(access404.detail).toBe(
			"project not found for this key (HTTP 404)",
		);
		expect(access404.fix?.description).toContain(
			"check the project id and --org",
		);
	});

	it("reports a missing scope on the route as a scope problem", async () => {
		const dest = await makeTree();
		mocks.getPublished.mockRejectedValue(
			new FabricForbiddenError(
				"Missing required scope: instructions:read",
				"MISSING_SCOPE",
			),
		);

		const { report } = await doctorJson(dest);

		expect(checkOf(report, "access").detail).toBe(
			"the API key is missing the instructions:read scope (HTTP 403)",
		);
	});

	it("reports a network failure as a class, never its message", async () => {
		const dest = await makeTree();
		mocks.getPublished.mockRejectedValue(
			new FabricError(
				"fetch failed: connect ECONNREFUSED 10.9.8.7:443",
				0,
				"NETWORK_ERROR",
			),
		);

		const { stdout, report } = await doctorJson(dest);

		expect(checkOf(report, "access").detail).toBe(
			"could not read the published instructions (could not reach the server)",
		);
		expect(stdout).not.toContain("10.9.8.7");
	});

	it("uses the context-free client and passes only an explicit --org", async () => {
		const dest = await makeTree();
		process.env.FABRIC_ORG = "ambient-org";
		mocks.getPublished.mockResolvedValue({
			published: false,
			sourceOfTruth: "UPLOAD",
		});

		await doctorJson(dest, ["--org", "example-org"]);

		expect(mocks.withoutContext).toHaveBeenCalled();
		expect(mocks.getPublished).toHaveBeenCalledWith("project-1", {
			org: "example-org",
		});
	});
});

// ---------------------------------------------------------------------------
// published + lock + drift
// ---------------------------------------------------------------------------
describe("published, lock and drift", () => {
	it("warns on an unpublished project and skips what compares against it", async () => {
		const dest = await makeTree();
		mocks.getPublished.mockResolvedValue({
			published: false,
			sourceOfTruth: "UPLOAD",
		});

		const { report } = await doctorJson(dest);

		expect(checkOf(report, "published")).toMatchObject({
			status: "warn",
			detail: "nothing is published for this project yet",
		});
		expect(checkOf(report, "lock")).toMatchObject({
			status: "skip",
			detail: "nothing published to compare against",
		});
		expect(checkOf(report, "drift").status).toBe("skip");
		// The hook is still worth checking: `init` installs one before the
		// first version exists.
		expect(checkOf(report, "hook").status).toBe("fail");
	});

	// Fizzy #2709: the `published` check reports the snapshot's provenance —
	// distinct from `sourceOfTruth`, which `publishedFor`'s `repository`
	// option controls and which this test leaves at its UPLOAD default.
	it("carries a REPOSITORY source on the published check, with its own detail", async () => {
		const dest = await makeTree();
		const manifest = [manifestEntry("AGENTS.md", "# a\n")];
		mocks.getPublished.mockResolvedValue(
			publishedFor(manifest, {
				source: {
					kind: "REPOSITORY",
					ref: "main",
					commitSha: `abc123def456${"0".repeat(28)}`,
					current: true,
				},
			}),
		);

		const { report } = await doctorJson(dest);

		const published = checkOf(report, "published");
		expect(published.source).toEqual({
			kind: "REPOSITORY",
			ref: "main",
			commitSha: `abc123def456${"0".repeat(28)}`,
			current: true,
		});
		expect(published.detail).toContain("from abc123def456… on main");
	});

	it("carries an UPLOAD source with no extra detail text", async () => {
		const dest = await makeTree();
		const manifest = [manifestEntry("AGENTS.md", "# a\n")];
		mocks.getPublished.mockResolvedValue(
			publishedFor(manifest, { source: { kind: "UPLOAD" } }),
		);

		const { report } = await doctorJson(dest);

		const published = checkOf(report, "published");
		expect(published.source).toEqual({ kind: "UPLOAD" });
		expect(published.detail).not.toContain("from");
	});

	it("carries the project's current repository-sync configuration on the published check", async () => {
		const dest = await makeTree();
		const manifest = [manifestEntry("AGENTS.md", "# a\n")];
		const repositoryConfig: PublishedInstructionRepository = {
			provider: "GITHUB",
			host: "github.com",
			path: "example-org/example-repo",
			ref: "main",
			rootPath: "",
			generation: 3,
		};
		mocks.getPublished.mockResolvedValue(
			publishedFor(manifest, {
				repository: true,
				source: {
					kind: "REPOSITORY",
					ref: "main",
					commitSha: `abc123def456${"0".repeat(28)}`,
					current: true,
				},
				repositoryConfig,
			}),
		);

		const { report } = await doctorJson(dest);

		expect(checkOf(report, "published").repository).toEqual(
			repositoryConfig,
		);
	});

	it("carries repository: null on the published check when the project has no current sync row", async () => {
		const dest = await makeTree();
		const manifest = [manifestEntry("AGENTS.md", "# a\n")];
		mocks.getPublished.mockResolvedValue(publishedFor(manifest));

		const { report } = await doctorJson(dest);

		expect(checkOf(report, "published").repository).toBeNull();
	});

	it("fails a missing lock with the sync that fixes it, carrying --org and --dest", async () => {
		const dest = await makeTree();
		mocks.getPublished.mockResolvedValue(
			publishedFor([manifestEntry("AGENTS.md", "# a\n")]),
		);

		const { report } = await doctorJson(dest, ["--org", "example-org"]);

		const lock = checkOf(report, "lock");
		expect(lock.status).toBe("fail");
		expect(lock.detail).toBe(`no lock: ${dest} has not been synced`);
		expect(lock.fix?.command).toBe(
			`fabric instructions sync --project project-1 --org example-org --dest ${dest}`,
		);
		expect(checkOf(report, "drift").status).toBe("skip");
	});

	it("shell-quotes a destination that needs it", async () => {
		const parent = await makeTree();
		const dest = path.join(parent, "it's here");
		await mkdir(dest);
		mocks.getPublished.mockResolvedValue(
			publishedFor([manifestEntry("AGENTS.md", "# a\n")]),
		);

		const { report } = await doctorJson(dest);

		expect(checkOf(report, "lock").fix?.command).toBe(
			`fabric instructions sync --project project-1 --dest '${parent}/it'\\''s here'`,
		);
	});

	it("fails a stale lock with both versions", async () => {
		const { dest } = await syncedTree(
			{ "AGENTS.md": "# a\n" },
			{ version: 6 },
		);
		const moved = [manifestEntry("AGENTS.md", "# b\n")];
		mocks.getPublished.mockResolvedValue(
			publishedFor(moved, { version: 7 }),
		);

		const { report } = await doctorJson(dest);

		expect(checkOf(report, "lock")).toMatchObject({
			status: "fail",
			detail: "lock is at version 6, published is 7",
		});
		// A stale lock is still a ledger: drift is measured against it.
		expect(checkOf(report, "drift").status).toBe("pass");
	});

	it("does not propose sync for a lock that belongs to another project", async () => {
		const dest = await makeTree();
		const manifest = [manifestEntry("AGENTS.md", "# a\n")];
		const published = publishedFor(manifest);
		await writeLock(
			dest,
			nextLock({
				projectId: "other-project",
				snapshot: published.snapshot,
				manifest,
			}),
		);
		mocks.getPublished.mockResolvedValue(published);

		const { report } = await doctorJson(dest);

		const lock = checkOf(report, "lock");
		expect(lock.status).toBe("fail");
		expect(lock.detail).toBe(
			"the lock was written for project other-project",
		);
		expect(lock.fix?.command).toBeUndefined();
		expect(lock.fix?.description).toContain("--dest");
		expect(checkOf(report, "drift").status).toBe("skip");
	});

	it("fails a lock at the published digest whose ledger is incomplete", async () => {
		const { dest, published } = await syncedTree({
			"AGENTS.md": "# a\n",
			"rules/one.md": "one\n",
		});
		// Same digest, but the ledger lost a path.
		await writeLock(dest, {
			...nextLock({
				projectId: "project-1",
				snapshot: published.snapshot,
				manifest: published.manifest,
			}),
			files: {
				"AGENTS.md": { sha256: sha256("# a\n"), mode: 0o100644 },
			},
		});

		const { report } = await doctorJson(dest);

		const lock = checkOf(report, "lock");
		expect(lock.status).toBe("fail");
		expect(lock.detail).toBe(
			"lock ledger does not match the published manifest",
		);
		expect(lock.items).toEqual([
			{
				name: "rules/one.md",
				status: "fail",
				detail: "published, not in the lock",
			},
		]);
	});

	it("fails an unreadable lock without quoting it", async () => {
		const dest = await makeTree();
		await mkdir(path.join(dest, ".fabric"));
		await writeFile(
			path.join(dest, ".fabric", "instructions.lock"),
			`{"version": 1, "leak": "${SENTINEL}"`,
			"utf8",
		);
		mocks.getPublished.mockResolvedValue(
			publishedFor([manifestEntry("AGENTS.md", "# a\n")]),
		);

		const { stdout, report } = await doctorJson(dest);

		expect(checkOf(report, "lock")).toMatchObject({
			status: "fail",
			detail: "the lock is unreadable",
		});
		expect(checkOf(report, "drift").status).toBe("skip");
		expect(stdout).not.toContain(SENTINEL);
	});

	/**
	 * The lock read is the guarded one. Each lock below is VALID and CURRENT
	 * for this project, so a reader that followed the link would report the
	 * lock as passing — from a file outside the checkout.
	 */
	describe("a lock doctor must not follow", () => {
		async function expectRefused(dest: string, outside: string) {
			const { stdout, report } = await doctorJson(dest);

			const lock = checkOf(report, "lock");
			expect(lock).toMatchObject({
				status: "fail",
				detail: LOCK_REFUSED,
			});
			expect(lock.fix?.command).toBe(
				`fabric instructions sync --project project-1 --dest ${dest}`,
			);
			// Never "remove it": that path names the file outside.
			expect(lock.fix?.description).toContain(
				"for a symlink, the link itself, not what it points to",
			);
			expect(lock.fix?.description).not.toContain("is damaged");
			expect(checkOf(report, "drift")).toMatchObject({
				status: "skip",
				detail: "not evaluated: no usable lock for this project",
			});
			// Content-free: where the link points is never printed.
			expect(stdout).not.toContain(outside);
		}

		it("refuses a symlinked .fabric directory", async () => {
			const { dest } = await syncedTree({ "AGENTS.md": "# a\n" });
			const outside = await makeTree();
			await rename(
				path.join(dest, ".fabric"),
				path.join(outside, ".fabric"),
			);
			await symlink(
				path.join(outside, ".fabric"),
				path.join(dest, ".fabric"),
				"dir",
			);

			await expectRefused(dest, outside);
		});

		it("refuses a symlinked lock file", async () => {
			const { dest } = await syncedTree({ "AGENTS.md": "# a\n" });
			const outside = await makeTree();
			const target = path.join(outside, "instructions.lock");
			await rename(lockPath(dest), target);
			await symlink(target, lockPath(dest));

			await expectRefused(dest, outside);
		});

		it("refuses a lock over 16 MiB before parsing it", async () => {
			const { dest } = await syncedTree({ "AGENTS.md": "# a\n" });
			// Still valid JSON: trailing whitespace parses, so only the bound
			// can refuse this lock.
			const valid = await readFile(lockPath(dest), "utf8");
			await writeFile(
				lockPath(dest),
				`${valid}${" ".repeat(16 * 1024 * 1024)}`,
				"utf8",
			);

			const { report } = await doctorJson(dest);

			expect(checkOf(report, "lock")).toMatchObject({
				status: "fail",
				detail: "the lock is larger than 16777216 bytes",
			});
			expect(checkOf(report, "drift").status).toBe("skip");
		});
	});

	it("fails mixed drift with sync, marking the edit as a warning and naming --repair and push", async () => {
		const { dest } = await syncedTree({
			"AGENTS.md": "# a\n",
			"rules/one.md": "one\n",
			"rules/two.md": "two\n",
		});
		await writeFile(path.join(dest, "AGENTS.md"), "# edited\n", "utf8");
		await unlink(path.join(dest, "rules/two.md"));

		const { report } = await doctorJson(dest);

		expect(checkOf(report, "lock").status).toBe("pass");
		const drift = checkOf(report, "drift");
		expect(drift.status).toBe("fail");
		expect(drift.detail).toBe(
			"2 of 3 files the last sync wrote no longer match the lock",
		);
		// Spec §6.4: sync keeps the edit, so only the missing file fails.
		expect(drift.items).toEqual([
			{ name: "AGENTS.md", status: "warn", detail: "edited" },
			{ name: "rules/two.md", status: "fail", detail: "missing" },
		]);
		expect(drift.fix?.command).toBe(
			`fabric instructions sync --project project-1 --dest ${dest}`,
		);
		expect(drift.fix?.description).toContain(
			`fabric instructions sync --project project-1 --dest ${dest} --repair`,
		);
		expect(drift.fix?.description).toContain(
			`fabric instructions push --project project-1 --dest ${dest}`,
		);
	});

	it("warns on edits alone, naming the ones sync kept, and proposes sync --repair", async () => {
		const { dest, manifest, published } = await syncedTree({
			"AGENTS.md": "# a\n",
			"rules/one.md": "one\n",
		});
		await writeFile(path.join(dest, "AGENTS.md"), "# my note\n", "utf8");
		await writeFile(
			path.join(dest, "rules/one.md"),
			"one, edited\n",
			"utf8",
		);
		// The lock a keeping sync leaves: it saw and kept AGENTS.md; the other
		// edit is newer than the last sync.
		await writeLock(
			dest,
			nextLock({
				projectId: "project-1",
				snapshot: published.snapshot,
				manifest,
				kept: ["AGENTS.md"],
			}),
		);

		const { report } = await doctorJson(dest);

		expect(checkOf(report, "lock").status).toBe("pass");
		const drift = checkOf(report, "drift");
		expect(drift.status).toBe("warn");
		expect(drift.detail).toBe(
			"2 of 2 files the last sync wrote carry local edits, which sync keeps",
		);
		expect(drift.items).toEqual([
			{
				name: "AGENTS.md",
				status: "warn",
				detail: "edited (kept by sync)",
			},
			{ name: "rules/one.md", status: "warn", detail: "edited" },
		]);
		expect(drift.fix?.command).toBe(
			`fabric instructions sync --project project-1 --dest ${dest} --repair`,
		);
		expect(drift.fix?.description).toContain(
			`fabric instructions push --project project-1 --dest ${dest}`,
		);
	});
});

// ---------------------------------------------------------------------------
// hook
// ---------------------------------------------------------------------------
describe("hook", () => {
	it("passes a canonical Claude Code hook and says what it does not verify", async () => {
		const { dest } = await syncedTree({ "AGENTS.md": "# a\n" });
		await writeHookFile(dest, CLAUDE_HOOK, [CANONICAL_CHECK]);

		const { report } = await doctorJson(dest);

		const hook = checkOf(report, "hook");
		expect(hook.status).toBe("pass");
		expect(hook.detail).toContain(
			"execution, trust and the coding tool's PATH are not verified",
		);
		expect(hook.items).toEqual([
			{
				name: "claude-code (.claude/settings.local.json)",
				status: "pass",
				detail: "canonical hook; reports changes at session start",
			},
			{
				name: "codex (.codex/hooks.json)",
				status: "skip",
				detail: "not configured",
			},
			{
				name: "fabric on PATH",
				status: "pass",
				detail: "found (not executed)",
			},
		]);
		// Found, not run.
		expect(await exists(path.join(binDir, "fabric.ran"))).toBe(false);
	});

	it("passes a canonical applying Codex hook for the --org doctor was given", async () => {
		const { dest } = await syncedTree({ "AGENTS.md": "# a\n" });
		await writeHookFile(dest, CODEX_HOOK, [
			"fabric instructions sync --project project-1 --org example-org --hook",
		]);

		const { report } = await doctorJson(dest, ["--org", "example-org"]);

		const hook = checkOf(report, "hook");
		expect(hook.status).toBe("pass");
		expect(hook.items?.[1]).toEqual({
			name: "codex (.codex/hooks.json)",
			status: "pass",
			detail: "canonical hook; applies changes at session start",
		});
	});

	it("warns on a hook for the project that is not the canonical command", async () => {
		const { dest } = await syncedTree({ "AGENTS.md": "# a\n" });
		// Canonical for no --org, but doctor runs with one.
		await writeHookFile(dest, CLAUDE_HOOK, [CANONICAL_CHECK]);

		const { report } = await doctorJson(dest, ["--org", "example-org"]);

		const hook = checkOf(report, "hook");
		expect(hook.status).toBe("warn");
		expect(hook.items?.[0]).toEqual({
			name: "claude-code (.claude/settings.local.json)",
			status: "warn",
			detail: "differs from the canonical command (different context or older syntax)",
		});
		expect(hook.fix?.command).toBe(
			`fabric instructions init --project project-1 --tool claude-code --org example-org --dest ${dest}`,
		);
	});

	it("fails with no hook and proposes the real init invocation", async () => {
		const { dest } = await syncedTree({ "AGENTS.md": "# a\n" });
		// A hook for a DIFFERENT project is not this project's hook.
		await writeHookFile(dest, CLAUDE_HOOK, [
			"fabric instructions check --project project-2 --hook",
		]);

		const { report } = await doctorJson(dest);

		const hook = checkOf(report, "hook");
		expect(hook.status).toBe("fail");
		expect(hook.detail).toBe("no hook configured for this project");
		expect(hook.fix?.command).toBe(
			`fabric instructions init --project project-1 --tool claude-code --dest ${dest}`,
		);
		expect(hook.fix?.description).toContain("--tool codex");
	});

	/**
	 * Only `SessionStart` entries running `check` or `sync` are this check's
	 * business. A Fabric hook for the same project under another event, or
	 * running another subcommand, is somebody else's and is never reported as
	 * a stale SessionStart hook.
	 */
	it("ignores Fabric hooks for the project under other events or subcommands", async () => {
		const { dest } = await syncedTree({ "AGENTS.md": "# a\n" });
		const other = "fabric instructions lesson-prompt --project project-1";
		await mkdir(path.join(dest, ".claude"));
		await writeFile(
			path.join(dest, CLAUDE_HOOK),
			JSON.stringify({
				hooks: {
					SessionStart: [
						{
							hooks: [
								{ type: "command", command: CANONICAL_CHECK },
							],
						},
					],
					Stop: [{ hooks: [{ type: "command", command: other }] }],
				},
			}),
			"utf8",
		);
		await mkdir(path.join(dest, ".codex"));
		await writeFile(
			path.join(dest, CODEX_HOOK),
			JSON.stringify({
				hooks: {
					SessionStart: [
						{ hooks: [{ type: "command", command: other }] },
					],
					Stop: [{ hooks: [{ type: "command", command: other }] }],
				},
			}),
			"utf8",
		);

		const { report } = await doctorJson(dest);

		const hook = checkOf(report, "hook");
		expect(hook.status).toBe("pass");
		expect(hook.items?.slice(0, 2)).toEqual([
			{
				name: "claude-code (.claude/settings.local.json)",
				status: "pass",
				detail: "canonical hook; reports changes at session start",
			},
			{
				name: "codex (.codex/hooks.json)",
				status: "skip",
				detail: "not configured",
			},
		]);
	});

	it("downgrades a canonical hook to a warning when fabric is not on PATH", async () => {
		const { dest } = await syncedTree({ "AGENTS.md": "# a\n" });
		await writeHookFile(dest, CLAUDE_HOOK, [CANONICAL_CHECK]);
		process.env.PATH = await binDirWith([]);

		const { report } = await doctorJson(dest);

		const hook = checkOf(report, "hook");
		expect(hook.status).toBe("warn");
		expect(hook.fix?.command).toBe("npm install -g @fabricorg/cli");
		expect(hook.items?.at(-1)).toEqual({
			name: "fabric on PATH",
			status: "warn",
			detail: "not found; install it with npm install -g @fabricorg/cli",
		});
	});

	it("warns, content-free, on a settings file it cannot parse", async () => {
		const { dest } = await syncedTree({ "AGENTS.md": "# a\n" });
		await mkdir(path.join(dest, ".claude"));
		await writeFile(
			path.join(dest, CLAUDE_HOOK),
			`{"hooks": ${SENTINEL}`,
			"utf8",
		);

		const { stdout, report } = await doctorJson(dest);

		expect(checkOf(report, "hook").items?.[0]).toEqual({
			name: "claude-code (.claude/settings.local.json)",
			status: "warn",
			detail: "settings file could not be read or parsed",
		});
		expect(stdout).not.toContain(SENTINEL);
	});
});

// ---------------------------------------------------------------------------
// repository-backed
// ---------------------------------------------------------------------------
describe("a repository-backed project", () => {
	it("skips lock, drift and hook, and reads the declaration from the checkout", async () => {
		const dest = await makeTree();
		const declaration = JSON.stringify({
			version: 1,
			variables: [{ name: "DOCTOR_TEST_PRESENT" }],
		});
		await writeTreeFiles(dest, { "fabric.environment.json": declaration });
		process.env.DOCTOR_TEST_PRESENT = SENTINEL;
		mocks.getPublished.mockResolvedValue(
			publishedFor([manifestEntry("fabric.environment.json", "{}\n")], {
				repository: true,
			}),
		);

		const { stdout, report } = await doctorJson(dest);

		for (const id of ["lock", "drift", "hook"] as const) {
			expect(checkOf(report, id)).toMatchObject({
				status: "skip",
				detail: "repository-backed project: files and hooks are managed by git",
			});
		}
		expect(checkOf(report, "environment")).toMatchObject({
			status: "pass",
			detail: "from the local checkout: 1 of 1 declared variable present",
		});
		expect(mocks.createDownloadUrl).not.toHaveBeenCalled();
		expect(stdout).not.toContain("instructions init");
		expect(stdout).not.toContain(SENTINEL);
	});
});

// ---------------------------------------------------------------------------
// environment
// ---------------------------------------------------------------------------
describe("environment", () => {
	const DECLARATION = JSON.stringify({
		version: 1,
		variables: [
			{ name: "DOCTOR_TEST_PRESENT", description: "present one" },
			{ name: "DOCTOR_TEST_MISSING_REQUIRED" },
			{ name: "DOCTOR_TEST_MISSING_OPTIONAL", required: false },
		],
		tools: [{ name: "fabric", version: ">=0.3" }],
	});

	it("reads the declaration locally when the lock is current and the bytes match", async () => {
		const { dest } = await syncedTree({
			"AGENTS.md": "# a\n",
			"fabric.environment.json": DECLARATION,
		});
		process.env.DOCTOR_TEST_PRESENT = SENTINEL;

		const text = await runCli([
			"doctor",
			"--project",
			"project-1",
			"--dest",
			dest,
		]);
		const { stdout, report } = await doctorJson(dest);

		expect(mocks.createDownloadUrl).not.toHaveBeenCalled();
		const environment = checkOf(report, "environment");
		expect(environment.status).toBe("fail");
		expect(environment.evidence).toBe("machine");
		expect(environment.detail).toBe(
			"1 of 3 declared variables present; 1 required missing; 1 optional missing",
		);
		expect(environment.items).toEqual([
			{ name: "DOCTOR_TEST_PRESENT", status: "pass", detail: "present" },
			{
				name: "DOCTOR_TEST_MISSING_REQUIRED",
				status: "fail",
				detail: "missing (required)",
			},
			{
				name: "DOCTOR_TEST_MISSING_OPTIONAL",
				status: "warn",
				detail: "missing (optional)",
			},
		]);
		expect(environment.fix?.command).toBeUndefined();
		expect(environment.fix?.description).toBe(
			"set DOCTOR_TEST_MISSING_REQUIRED in your shell environment; optional and unset: DOCTOR_TEST_MISSING_OPTIONAL (values are never read by this tool)",
		);
		// A value is never read, printed or serialised — text or JSON.
		expect(stdout).not.toContain(SENTINEL);
		expect(text.stdout).not.toContain(SENTINEL);
		expect(text.stderr).not.toContain(SENTINEL);
	});

	it("warns, not fails, when only optional variables are missing", async () => {
		const { dest } = await syncedTree({
			"fabric.environment.json": JSON.stringify({
				version: 1,
				variables: [
					{ name: "DOCTOR_TEST_PRESENT" },
					{ name: "DOCTOR_TEST_MISSING_OPTIONAL", required: false },
				],
			}),
		});
		process.env.DOCTOR_TEST_PRESENT = SENTINEL;

		const { stdout, report } = await doctorJson(dest);

		expect(checkOf(report, "environment").status).toBe("warn");
		expect(stdout).not.toContain(SENTINEL);
	});

	it("downloads the published declaration when the lock is not current", async () => {
		const files = {
			"AGENTS.md": "# a\n",
			"fabric.environment.json": DECLARATION,
		};
		const dest = await makeTree();
		const manifest = Object.entries(files).map(([p, c]) =>
			manifestEntry(p, c),
		);
		const published = publishedFor(manifest);
		mocks.getPublished.mockResolvedValue(published);
		mocks.createDownloadUrl.mockResolvedValue({
			snapshotId: published.snapshot.id,
			digest: published.snapshot.digest,
			url: "https://example.com/bundle.zip",
			expiresInSeconds: 300,
		});
		const fetchMock = stubBundle(files);

		const { report } = await doctorJson(dest);

		expect(mocks.createDownloadUrl).toHaveBeenCalledWith("project-1", {
			org: undefined,
		});
		expect(fetchMock).toHaveBeenCalledTimes(1);
		expect(checkOf(report, "environment").detail).toBe(
			"0 of 3 declared variables present; 2 required missing; 1 optional missing",
		);
		expect(checkOf(report, "tools").status).toBe("pass");
	});

	it("retries once when publication moves under it, then says so", async () => {
		const files = { "fabric.environment.json": DECLARATION };
		const dest = await makeTree();
		const published = publishedFor(
			Object.entries(files).map(([p, c]) => manifestEntry(p, c)),
		);
		mocks.getPublished.mockResolvedValue(published);
		mocks.createDownloadUrl.mockResolvedValue({
			snapshotId: "snap-8",
			digest: "f".repeat(64),
			url: "https://example.com/bundle.zip",
			expiresInSeconds: 300,
		});
		const fetchMock = stubBundle(files);

		const { report } = await doctorJson(dest);

		expect(checkOf(report, "environment")).toMatchObject({
			status: "warn",
			detail: "publication changed while checking; rerun",
		});
		expect(mocks.createDownloadUrl).toHaveBeenCalledTimes(2);
		expect(mocks.getPublished).toHaveBeenCalledTimes(2);
		expect(fetchMock).not.toHaveBeenCalled();
		expect(checkOf(report, "tools")).toMatchObject({
			status: "skip",
			detail: "declaration unreadable",
		});
	});

	it("fails a downloaded declaration whose bytes do not hash to the manifest", async () => {
		const dest = await makeTree();
		// Same size, different bytes: only the hash can tell.
		const tampered = DECLARATION.replace("present one", "present two");
		const manifest = [
			manifestEntry("fabric.environment.json", DECLARATION),
		];
		const published = publishedFor(manifest);
		mocks.getPublished.mockResolvedValue(published);
		mocks.createDownloadUrl.mockResolvedValue({
			snapshotId: published.snapshot.id,
			digest: published.snapshot.digest,
			url: "https://example.com/bundle.zip",
			expiresInSeconds: 300,
		});
		stubBundle({ "fabric.environment.json": tampered });

		const { report } = await doctorJson(dest);

		expect(checkOf(report, "environment")).toMatchObject({
			status: "fail",
			detail: "published declaration failed integrity check",
		});
	});

	it("refuses an oversize manifest entry before downloading anything", async () => {
		const dest = await makeTree();
		const entry = {
			...manifestEntry("fabric.environment.json", "{}"),
			size: 70_000,
		};
		mocks.getPublished.mockResolvedValue(publishedFor([entry]));

		const { report } = await doctorJson(dest);

		expect(checkOf(report, "environment")).toMatchObject({
			status: "fail",
			detail: "published declaration is larger than 65536 bytes",
		});
		expect(mocks.createDownloadUrl).not.toHaveBeenCalled();
	});

	it("fails a malformed declaration with a positional reason, and skips tools", async () => {
		const { dest } = await syncedTree({
			"fabric.environment.json": JSON.stringify({
				version: 1,
				variables: [{ name: `BAD NAME ${SENTINEL}` }],
			}),
		});

		const { stdout, report } = await doctorJson(dest);

		const environment = checkOf(report, "environment");
		expect(environment.status).toBe("fail");
		expect(environment.detail).toMatch(
			/^published declaration: variables\[0\]\.name must be an environment variable name/,
		);
		expect(checkOf(report, "tools")).toMatchObject({
			status: "skip",
			detail: "declaration unreadable",
		});
		expect(stdout).not.toContain(SENTINEL);
	});

	it("evaluates an unpublished local declaration and says it is unpublished", async () => {
		const { dest } = await syncedTree({ "AGENTS.md": "# a\n" });
		await writeTreeFiles(dest, {
			"fabric.environment.json": JSON.stringify({
				version: 1,
				variables: [{ name: "DOCTOR_TEST_PRESENT" }],
			}),
		});
		process.env.DOCTOR_TEST_PRESENT = SENTINEL;

		const { report } = await doctorJson(dest);

		expect(checkOf(report, "environment")).toMatchObject({
			status: "warn",
			detail: "1 of 1 declared variable present; declaration exists locally but is not published",
		});
	});

	/**
	 * `fabric.environment.json` is read through the guarded reader. The file
	 * the link points to is a valid declaration whose variable IS set, so a
	 * reader that followed it would evaluate it and not fail.
	 */
	it.each([
		{
			label: "an unpublished local declaration",
			repository: false,
			prefix: "local, unpublished declaration: ",
		},
		{
			label: "a repository checkout's declaration",
			repository: true,
			prefix: "from the local checkout: ",
		},
	])("refuses a symlinked $label", async ({ repository, prefix }) => {
		const { dest, manifest } = await syncedTree({ "AGENTS.md": "# a\n" });
		mocks.getPublished.mockResolvedValue(
			publishedFor(manifest, { repository }),
		);
		const outside = await makeTree();
		await writeTreeFiles(outside, {
			"fabric.environment.json": JSON.stringify({
				version: 1,
				variables: [{ name: "DOCTOR_TEST_PRESENT" }],
			}),
		});
		await symlink(
			path.join(outside, "fabric.environment.json"),
			path.join(dest, "fabric.environment.json"),
		);
		process.env.DOCTOR_TEST_PRESENT = SENTINEL;

		const { stdout, report } = await doctorJson(dest);

		const environment = checkOf(report, "environment");
		expect(environment).toMatchObject({
			status: "fail",
			detail: `${prefix}${READ_REFUSED}`,
		});
		expect(environment.items).toBeUndefined();
		expect(checkOf(report, "tools")).toMatchObject({
			status: "skip",
			detail: "declaration unreadable",
		});
		expect(stdout).not.toContain(outside);
		expect(stdout).not.toContain(SENTINEL);
	});

	it("fails with the generic fix when resolving the declaration throws", async () => {
		const dest = await makeTree();
		// A manifest entry that is not an object: the lock check never
		// reaches it (there is no lock), the declaration lookup throws on it.
		const published = publishedFor([manifestEntry("AGENTS.md", "# a\n")]);
		mocks.getPublished.mockResolvedValue({
			...published,
			manifest: [null],
		});

		const { code, report } = await doctorJson(dest);

		expect(code).toBe(1);
		expect(checkOf(report, "environment")).toEqual({
			id: "environment",
			title: CHECK_TITLES.environment,
			status: "fail",
			evidence: "machine",
			detail: "check could not run (TypeError)",
			fix: { description: COULD_NOT_RUN_FIX },
		});
		expect(checkOf(report, "tools")).toMatchObject({
			status: "skip",
			detail: "declaration unreadable",
		});
		expect(checkOf(report, "mcp-servers").status).toBe("skip");
	});

	it("skips when nothing declares an environment", async () => {
		const { dest } = await syncedTree({ "AGENTS.md": "# a\n" });

		const { report } = await doctorJson(dest);

		expect(checkOf(report, "environment")).toMatchObject({
			status: "skip",
			detail: "no environment declaration (add fabric.environment.json to the instruction set)",
		});
		expect(checkOf(report, "tools").status).toBe("skip");
	});
});

// ---------------------------------------------------------------------------
// tools
// ---------------------------------------------------------------------------
describe("tools", () => {
	it("finds declared tools by PATH lookup alone and never runs them", async () => {
		const bin = await binDirWith(["fabric", "doctor-tool-present"]);
		// A regular file with no execute bit is not a tool a shell would run.
		await writeFile(path.join(bin, "doctor-tool-noexec"), "x", "utf8");
		await chmod(path.join(bin, "doctor-tool-noexec"), 0o644);
		process.env.PATH = `relative/dir${path.delimiter}${bin}`;
		const { dest } = await syncedTree({
			"fabric.environment.json": JSON.stringify({
				version: 1,
				tools: [
					{ name: "doctor-tool-present", version: ">=11" },
					{ name: "doctor-tool-missing" },
					{ name: "doctor-tool-noexec" },
				],
			}),
		});

		const { report } = await doctorJson(dest);

		const tools = checkOf(report, "tools");
		expect(tools.status).toBe("fail");
		expect(tools.detail).toBe(
			"1 of 3 declared tools found on PATH (presence only; nothing was run)",
		);
		expect(tools.items).toEqual([
			{
				name: "doctor-tool-present",
				status: "pass",
				detail: "found on PATH; declared >=11 (not verified)",
			},
			{
				name: "doctor-tool-missing",
				status: "fail",
				detail: "not found on PATH",
			},
			{
				name: "doctor-tool-noexec",
				status: "fail",
				detail: "not found on PATH",
			},
		]);
		expect(tools.fix).toEqual({
			description:
				"install doctor-tool-missing, doctor-tool-noexec and make sure they are on PATH",
		});
		expect(await exists(path.join(bin, "doctor-tool-present.ran"))).toBe(
			false,
		);
		// The declaration names no variables.
		expect(checkOf(report, "environment").status).toBe("skip");
	});
});

// ---------------------------------------------------------------------------
// mcp-servers
// ---------------------------------------------------------------------------

/** A local HTTP server that answers 401 and records what it was sent. */
async function listening(status: number): Promise<{
	server: Server;
	port: number;
	requests: IncomingHttpHeaders[];
}> {
	const requests: IncomingHttpHeaders[] = [];
	const server = createServer((request, response) => {
		requests.push(request.headers);
		response.writeHead(status, { "content-type": "text/plain" });
		response.end("not for you");
	});
	await new Promise<void>((resolve) =>
		server.listen(0, "127.0.0.1", () => resolve()),
	);
	return { server, port: (server.address() as AddressInfo).port, requests };
}

async function closedPort(): Promise<number> {
	const { server, port } = await listening(200);
	await new Promise<void>((resolve) => server.close(() => resolve()));
	return port;
}

async function writeMcpConfig(root: string, body: unknown): Promise<void> {
	await writeFile(
		path.join(root, ".mcp.json"),
		typeof body === "string" ? body : JSON.stringify(body),
		"utf8",
	);
}

describe("mcp-servers", () => {
	it("skips when there is no .mcp.json", async () => {
		const { dest } = await syncedTree({ "AGENTS.md": "# a\n" });

		const { report } = await doctorJson(dest);

		expect(checkOf(report, "mcp-servers")).toMatchObject({
			status: "skip",
			detail: `no .mcp.json in ${dest}`,
			evidence: "machine",
		});
	});

	it("fails an unparseable .mcp.json without quoting it", async () => {
		const { dest } = await syncedTree({ "AGENTS.md": "# a\n" });
		await writeMcpConfig(dest, `{"mcpServers": {"x": ${SENTINEL}`);

		const { stdout, report } = await doctorJson(dest);

		expect(checkOf(report, "mcp-servers")).toMatchObject({
			status: "fail",
			detail: "could not use .mcp.json: not valid JSON",
		});
		expect(stdout).not.toContain(SENTINEL);

		await writeMcpConfig(dest, { mcpServers: ["not", "an", "object"] });
		const second = await doctorJson(dest);
		expect(checkOf(second.report, "mcp-servers").detail).toBe(
			"could not use .mcp.json: mcpServers is not an object",
		);
	});

	it("refuses a symlinked .mcp.json instead of checking what it points to", async () => {
		const { dest } = await syncedTree({ "AGENTS.md": "# a\n" });
		const outside = await makeTree();
		// `fabric` is on the test PATH, so the target would pass if followed.
		await writeMcpConfig(outside, {
			mcpServers: { outside: { command: "fabric" } },
		});
		await symlink(
			path.join(outside, ".mcp.json"),
			path.join(dest, ".mcp.json"),
		);

		const { stdout, report } = await doctorJson(dest);

		const mcp = checkOf(report, "mcp-servers");
		expect(mcp).toMatchObject({
			status: "fail",
			detail: `could not use .mcp.json: ${READ_REFUSED}`,
		});
		expect(mcp.items).toBeUndefined();
		expect(stdout).not.toContain(outside);
	});

	it("fails an oversize .mcp.json with a size reason", async () => {
		const { dest } = await syncedTree({ "AGENTS.md": "# a\n" });
		await writeMcpConfig(dest, " ".repeat(262_145));

		const { report } = await doctorJson(dest);

		expect(checkOf(report, "mcp-servers").detail).toBe(
			"could not use .mcp.json: file is larger than 262144 bytes",
		);
	});

	it("finds command servers on PATH, never runs them, never prints their env", async () => {
		const bin = await binDirWith(["fabric", "doctor-mcp-server"]);
		process.env.PATH = bin;
		const { dest } = await syncedTree({ "AGENTS.md": "# a\n" });
		await writeMcpConfig(dest, {
			mcpServers: {
				present: {
					command: "doctor-mcp-server",
					args: ["--token", SENTINEL],
					env: { TOKEN: SENTINEL },
				},
				absent: { command: "doctor-mcp-missing" },
				"remote\u001b[31m": {
					url: `https://example.com/mcp?token=${SENTINEL}`,
				},
			},
		});

		const text = await runCli([
			"doctor",
			"--project",
			"project-1",
			"--dest",
			dest,
		]);
		const { stdout, report } = await doctorJson(dest);

		const mcp = checkOf(report, "mcp-servers");
		expect(mcp.status).toBe("fail");
		expect(mcp.items).toEqual([
			{
				name: "present",
				status: "pass",
				detail: "command found (not executed)",
			},
			{ name: "absent", status: "fail", detail: "command not found" },
			{
				// The key is sanitized: no terminal escape survives.
				name: "remote [31m",
				status: "skip",
				detail: "network probe disabled (rerun with --probe-network)",
			},
		]);
		expect(mcp.fix?.description).toBe(
			"fix or remove the failing server in .mcp.json: absent",
		);
		expect(await exists(path.join(bin, "doctor-mcp-server.ran"))).toBe(
			false,
		);
		for (const output of [stdout, text.stdout, text.stderr]) {
			expect(output).not.toContain(SENTINEL);
			expect(output).not.toContain("example.com/mcp");
			expect(output).not.toContain("\u001b");
		}
	});

	it("does not touch the network for url servers without --probe-network", async () => {
		const { server, port, requests } = await listening(401);
		try {
			const { dest } = await syncedTree({ "AGENTS.md": "# a\n" });
			await writeMcpConfig(dest, {
				mcpServers: { remote: { url: `http://127.0.0.1:${port}/mcp` } },
			});

			const { report } = await doctorJson(dest);

			expect(checkOf(report, "mcp-servers").status).toBe("skip");
			expect(requests).toHaveLength(0);
		} finally {
			server.close();
		}
	});

	it("with --probe-network, counts any HTTP answer as reachable and sends no config headers", async () => {
		const { server, port, requests } = await listening(401);
		const refused = await closedPort();
		try {
			const { dest } = await syncedTree({ "AGENTS.md": "# a\n" });
			await writeMcpConfig(dest, {
				mcpServers: {
					answers: {
						type: "http",
						url: `http://127.0.0.1:${port}/mcp?token=${SENTINEL}`,
						headers: { "X-Doctor-Secret": SENTINEL },
					},
					gone: { url: `http://127.0.0.1:${refused}/mcp` },
					odd: { url: "ftp://example.com/mcp" },
					creds: { url: `https://user:${SENTINEL}@example.com/mcp` },
				},
			});

			const { stdout, report } = await doctorJson(dest, [
				"--probe-network",
			]);

			const mcp = checkOf(report, "mcp-servers");
			expect(mcp.items).toEqual([
				{
					name: "answers",
					status: "pass",
					detail: "reachable (HTTP 401); an HTTP response is not proof of a working MCP server",
				},
				{ name: "gone", status: "fail", detail: "connection refused" },
				{ name: "odd", status: "fail", detail: "unsupported scheme" },
				{
					name: "creds",
					status: "warn",
					detail: "the URL embeds credentials; not probed",
				},
			]);
			expect(mcp.status).toBe("fail");
			expect(mcp.detail).toContain(
				"not that a working MCP server answered",
			);
			expect(requests).toHaveLength(1);
			expect(requests[0]?.["x-doctor-secret"]).toBeUndefined();
			expect(stdout).not.toContain(SENTINEL);
			expect(stdout).not.toContain(String(refused));
		} finally {
			server.close();
		}
	});
});

// ---------------------------------------------------------------------------
// The report as a whole
// ---------------------------------------------------------------------------
describe("the report", () => {
	async function healthyTree(): Promise<string> {
		const { dest } = await syncedTree({
			"AGENTS.md": "# a\n",
			"fabric.environment.json": JSON.stringify({
				version: 1,
				variables: [{ name: "DOCTOR_TEST_PRESENT" }],
				tools: [{ name: "fabric" }],
			}),
		});
		await writeHookFile(dest, CLAUDE_HOOK, [CANONICAL_CHECK]);
		process.env.DOCTOR_TEST_PRESENT = SENTINEL;
		return dest;
	}

	it("is exactly an InstructionChecksReport, in CHECK_IDS order, exit 0 when nothing fails", async () => {
		const dest = await healthyTree();

		const { code, stdout, stderr, report } = await doctorJson(dest);

		expect(code).toBe(0);
		expect(stderr).toBe("");
		expect(Object.keys(report).sort()).toEqual(
			["checks", "ok", "projectId", "summary", "surface"].sort(),
		);
		expect(report.projectId).toBe("project-1");
		expect(report.surface).toBe("cli");
		expect(report.checks.map((check) => check.id)).toEqual([...CHECK_IDS]);
		for (const check of report.checks) {
			expect(check.title).toBe(CHECK_TITLES[check.id]);
			expect(["server", "machine"]).toContain(check.evidence);
			expect(typeof check.detail).toBe("string");
		}
		expect(report.summary).toEqual({ pass: 8, fail: 0, warn: 0, skip: 1 });
		expect(report.ok).toBe(true);
		expect(stdout).not.toContain(SENTINEL);
	});

	it("exits 1 when any check fails, after printing the whole report", async () => {
		const dest = await healthyTree();
		delete process.env.DOCTOR_TEST_PRESENT;

		const { code, report, stderr } = await doctorJson(dest);

		expect(code).toBe(1);
		expect(report.ok).toBe(false);
		expect(report.summary.fail).toBe(1);
		expect(stderr).toBe(
			"✗ 1 check failed; the report above lists a proposed fix for each\n",
		);
	});

	it("prints one line per check in text, with fixes and a summary", async () => {
		const dest = await healthyTree();
		delete process.env.DOCTOR_TEST_PRESENT;

		const { stdout } = await runCli([
			"doctor",
			"--project",
			"project-1",
			"--dest",
			dest,
		]);

		const lines = stdout.split("\n");
		expect(lines[0]).toBe(
			`Coding instructions doctor: project project-1 in ${dest}`,
		);
		expect(stdout).toContain(
			"✓ API key                 organization key org_abc12345 with instructions:read",
		);
		expect(stdout).toContain(
			"✗ Environment variables   0 of 1 declared variable present; 1 required missing",
		);
		expect(stdout).toContain(
			"    ✗ DOCTOR_TEST_PRESENT  missing (required)",
		);
		expect(stdout).toContain(
			"    fix: set DOCTOR_TEST_PRESENT in your shell environment (values are never read by this tool)",
		);
		expect(stdout).toContain("- MCP servers");
		expect(stdout).toContain("7 passed, 1 failed, 0 warnings, 1 skipped");
		expect(stdout).toContain(
			"Fixes are proposals: doctor installed nothing, changed no credentials and wrote no files.",
		);
	});
});
