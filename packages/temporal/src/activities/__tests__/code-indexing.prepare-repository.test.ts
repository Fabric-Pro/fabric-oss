import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { MockActivityEnvironment } from "@temporalio/testing";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

// The clone is host-local temp (`os.tmpdir()/fabric-code-index-<runId>`). When
// clone, secret scan and walk were separate activities, Temporal could run the
// scan or walk on a different worker host than the clone, where the directory
// does not exist — ENOENT on every retry, and the index stuck "indexing".
// `prepareRepositoryActivity` runs all three in one execution.

const jobCalls = vi.hoisted(() => [] as string[]);

vi.mock("../lib/job-progress", async (importOriginal) => {
	const actual = await importOriginal<typeof import("../lib/job-progress")>();
	return {
		...actual,
		jobStep: vi.fn(async (step: string, status: string) => {
			jobCalls.push(`${step}:${status}`);
		}),
		jobSetCounts: vi.fn(async (counts: { totalFiles?: number }) => {
			jobCalls.push(`counts:${counts.totalFiles}`);
		}),
		jobEnsure: vi.fn(async () => undefined),
		jobIncrement: vi.fn(async () => undefined),
		jobHeartbeat: vi.fn(async () => undefined),
		jobComplete: vi.fn(async () => undefined),
		jobFail: vi.fn(async () => undefined),
	};
});

// Assembled from fragments so no source literal looks like a real AWS key to a
// secret scanner; the runtime string still matches the activity's pattern.
const FAKE_AWS_KEY = `${"AK"}${"IA"}${"Q".repeat(16)}`;

const REPO_FILES: Record<string, string> = {
	"src/app.ts": "export const app = 1;\n",
	"src/config.ts": `export const key = "${FAKE_AWS_KEY}";\n`,
	"README.md": "# example\n",
	"logo.png": "not really a png",
	"node_modules/dep/index.js": "module.exports = 1;\n",
};

function writeRepo(dir: string): void {
	for (const [rel, content] of Object.entries(REPO_FILES)) {
		const full = path.join(dir, rel);
		fs.mkdirSync(path.dirname(full), { recursive: true });
		fs.writeFileSync(full, content);
	}
}

// Per-test hooks into the simple-git stand-in.
const gitControl = vi.hoisted(() => ({
	/** Runs after a clone has materialised its files, before git "returns". */
	afterClone: null as null | ((clonePath: string) => Promise<void>),
	/** When set, reading the cloned commit fails with this error. */
	logError: null as null | Error,
}));

// simple-git stand-in: a "clone" materialises REPO_FILES at the target path.
vi.mock("simple-git", () => ({
	default: (dir?: string) => ({
		clone: async (_url: string, clonePath: string) => {
			writeRepo(clonePath);
			await gitControl.afterClone?.(clonePath);
		},
		listRemote: async () => "ref: refs/heads/main\tHEAD\n",
		log: async () => {
			if (gitControl.logError) {
				throw gitControl.logError;
			}
			return { latest: { hash: "0123456789abcdef" } };
		},
		init: async () => undefined,
		addRemote: async () => undefined,
		fetch: async () => undefined,
		checkout: async () => writeRepo(dir as string),
	}),
}));

const {
	cloneRepositoryActivity,
	prepareRepositoryActivity,
	scanForSecretsActivity,
	walkFileTreeActivity,
} = await import("../code-indexing");

/** Run an activity as Temporal attempt `attempt` in a mock activity context. */
function runAttempt<A extends unknown[], R>(
	attempt: number,
	fn: (...args: A) => Promise<R>,
	...args: A
): Promise<R> {
	return new MockActivityEnvironment({ attempt }).run(
		fn,
		...args,
	) as Promise<R>;
}

/** Run an activity as attempt 1. */
function runActivity<A extends unknown[], R>(
	fn: (...args: A) => Promise<R>,
	...args: A
): Promise<R> {
	return runAttempt(1, fn, ...args);
}

let runSeq = 0;
let runId: string;

/** The pre-prepare clone path `cloneRepositoryActivity` has always used. */
function legacyClonePathFor(id: string): string {
	return path.join(os.tmpdir(), `fabric-code-index-${id}`);
}

/** A prepare attempt's own clone path. */
function clonePathFor(id: string, attempt = 1): string {
	return `${legacyClonePathFor(id)}-a${attempt}`;
}

function artifactsExist(clonePath: string): boolean {
	return (
		fs.existsSync(clonePath) ||
		fs.existsSync(`${clonePath}.code-index-manifest.json`) ||
		fs.existsSync(`${clonePath}.code-index-changed-manifest.json`)
	);
}

/** Every tmp entry (clone dir or sibling manifest) named for this run. */
function runArtifactsInTmp(id: string): string[] {
	const base = path.basename(legacyClonePathFor(id));
	return fs
		.readdirSync(os.tmpdir())
		.filter(
			(name) =>
				name === base ||
				name.startsWith(`${base}-a`) ||
				name.startsWith(`${base}.`),
		);
}

function removeRunArtifacts(id: string): void {
	for (const clonePath of [
		legacyClonePathFor(id),
		clonePathFor(id, 1),
		clonePathFor(id, 2),
	]) {
		fs.rmSync(clonePath, { recursive: true, force: true });
		fs.rmSync(`${clonePath}.code-index-manifest.json`, { force: true });
		fs.rmSync(`${clonePath}.code-index-changed-manifest.json`, {
			force: true,
		});
	}
}

function cloneInput(changedFiles?: string[]) {
	return {
		repositoryUrl: "https://github.com/example-org/example-repo",
		branch: "main",
		token: "example-token",
		provider: "GITHUB" as const,
		workflowRunId: runId,
		projectId: "proj-1",
		userId: "user-1",
		organizationId: "org-1",
		...(changedFiles ? { changedFiles } : {}),
	};
}

beforeEach(() => {
	runId = `prepare-test-${process.pid}-${runSeq++}`;
	jobCalls.length = 0;
	gitControl.afterClone = null;
	gitControl.logError = null;
});

afterEach(() => removeRunArtifacts(runId));

describe("prepareRepositoryActivity", () => {
	it("clones, redacts secrets and writes the manifest in one execution", async () => {
		const out = await runActivity(prepareRepositoryActivity, cloneInput());

		const clonePath = clonePathFor(runId);
		expect(out.clone).toEqual({
			clonePath,
			commitSha: "0123456789abcdef",
			branch: "main",
		});

		expect(out.scan.secretsFound).toBe(1);
		expect(out.scan.redactionManifest).toEqual([
			{ path: "src/config.ts", type: "secret", count: 1 },
		]);
		const redacted = fs.readFileSync(
			path.join(clonePath, "src/config.ts"),
			"utf8",
		);
		expect(redacted).not.toContain(FAKE_AWS_KEY);
		expect(redacted).toContain("[REDACTED]");

		expect(out.tree).toEqual({
			manifestPath: `${clonePath}.code-index-manifest.json`,
			totalFiles: 3,
			skippedFiles: 1,
		});
		// Counts and a path only — never a file list across the payload boundary.
		expect(out.tree).not.toHaveProperty("files");
		const manifest = JSON.parse(
			fs.readFileSync(out.tree.manifestPath, "utf8"),
		) as Array<{ relativePath: string }>;
		expect(manifest.map((e) => e.relativePath).sort()).toEqual([
			"README.md",
			"src/app.ts",
			"src/config.ts",
		]);

		// Full run: no changed-subset manifest.
		expect(out.changed).toBeUndefined();
		expect(
			fs.existsSync(`${clonePath}.code-index-changed-manifest.json`),
		).toBe(false);

		// Job Hub sees the same step sequence the split activities produced.
		expect(jobCalls).toEqual([
			"clone:running",
			"clone:completed",
			"secretScan:completed",
			"walk:completed",
			"counts:3",
		]);
	});

	it("writes the changed-subset manifest only when changedFiles are passed", async () => {
		const out = await runActivity(
			prepareRepositoryActivity,
			cloneInput(["src/app.ts", "src/deleted.ts"]),
		);

		const clonePath = clonePathFor(runId);
		expect(out.changed).toEqual({
			manifestPath: `${clonePath}.code-index-changed-manifest.json`,
			count: 1,
		});
		const subset = JSON.parse(
			fs.readFileSync(out.changed?.manifestPath as string, "utf8"),
		) as Array<{ relativePath: string }>;
		expect(subset.map((e) => e.relativePath)).toEqual(["src/app.ts"]);
	});

	it("a retry on a fresh host, where attempt 1's clone never existed, re-creates the clone and manifest", async () => {
		await runAttempt(1, prepareRepositoryActivity, cloneInput());

		// The next attempt lands on a host that has none of it.
		removeRunArtifacts(runId);

		const retry = await runAttempt(
			2,
			prepareRepositoryActivity,
			cloneInput(),
		);
		expect(retry.clone.clonePath).toBe(clonePathFor(runId, 2));
		expect(
			fs.existsSync(path.join(clonePathFor(runId, 2), "src/app.ts")),
		).toBe(true);
		expect(retry.tree.totalFiles).toBe(3);
		expect(fs.existsSync(retry.tree.manifestPath)).toBe(true);
		expect(retry.scan.secretsFound).toBe(1);
	});

	it("re-running the same attempt replaces its earlier manifests", async () => {
		const first = await runActivity(
			prepareRepositoryActivity,
			cloneInput(["src/app.ts"]),
		);
		const changedPath = first.changed?.manifestPath as string;
		expect(fs.existsSync(changedPath)).toBe(true);
		fs.writeFileSync(first.tree.manifestPath, "[]");

		const again = await runActivity(
			prepareRepositoryActivity,
			cloneInput(),
		);
		const manifest = JSON.parse(
			fs.readFileSync(again.tree.manifestPath, "utf8"),
		) as unknown[];
		expect(manifest).toHaveLength(3);
		expect(fs.existsSync(changedPath)).toBe(false);
	});

	it("overlapping attempts on one host use separate checkouts, and a late failure removes only its own", async () => {
		// Attempt 1 materialises its checkout, then stalls inside git past the
		// heartbeat timeout; Temporal starts attempt 2 on the same host.
		let releaseAttempt1!: () => void;
		const attempt1Released = new Promise<void>((resolve) => {
			releaseAttempt1 = resolve;
		});
		let markAttempt1Stalled!: () => void;
		const attempt1Stalled = new Promise<void>((resolve) => {
			markAttempt1Stalled = resolve;
		});
		gitControl.afterClone = async (clonePath) => {
			if (clonePath === clonePathFor(runId, 1)) {
				markAttempt1Stalled();
				await attempt1Released;
				throw new Error("connection reset by peer");
			}
		};
		const attempt1 = runAttempt(1, prepareRepositoryActivity, cloneInput());
		// Start attempt 2 only once attempt 1 is stuck inside git. (Also keeps
		// the two attempts' lazy simple-git imports from overlapping: vitest was
		// seen resolving the real module for the second of two in-flight
		// first-time imports.)
		await attempt1Stalled;

		const attempt2 = await runAttempt(
			2,
			prepareRepositoryActivity,
			cloneInput(["src/app.ts"]),
		);
		expect(attempt2.clone.clonePath).toBe(clonePathFor(runId, 2));
		expect(attempt2.clone.clonePath).not.toBe(clonePathFor(runId, 1));

		// Attempt 1 resumes and fails; its cleanup must not touch attempt 2.
		releaseAttempt1();
		await expect(attempt1).rejects.toThrow("connection reset by peer");

		expect(artifactsExist(clonePathFor(runId, 1))).toBe(false);
		expect(
			fs.existsSync(path.join(attempt2.clone.clonePath, "src/app.ts")),
		).toBe(true);
		expect(fs.existsSync(attempt2.tree.manifestPath)).toBe(true);
		expect(fs.existsSync(attempt2.changed?.manifestPath as string)).toBe(
			true,
		);
	});

	it("leaves no checkout behind when the clone lands on disk but reading its commit fails", async () => {
		gitControl.logError = new Error("fatal: bad object HEAD");

		await expect(
			runActivity(prepareRepositoryActivity, cloneInput()),
		).rejects.toThrow("bad object HEAD");

		// Nothing for this run anywhere in tmp — whatever path the attempt used.
		expect(runArtifactsInTmp(runId)).toEqual([]);
	});
});

describe("split clone → scan → walk activities (histories recorded before prepare)", () => {
	it("fail with ENOENT when the scan or walk runs on a host without the clone", async () => {
		const { clonePath } = await runActivity(
			cloneRepositoryActivity,
			cloneInput(),
		);
		// The pre-prepare activity keeps its original, attempt-less path.
		expect(clonePath).toBe(legacyClonePathFor(runId));
		expect(fs.existsSync(clonePath)).toBe(true);

		// Worker B never had worker A's host-local temp dir.
		fs.rmSync(clonePath, { recursive: true, force: true });

		await expect(
			runActivity(scanForSecretsActivity, { clonePath }),
		).rejects.toMatchObject({ code: "ENOENT" });
		await expect(
			runActivity(walkFileTreeActivity, { clonePath }),
		).rejects.toMatchObject({ code: "ENOENT" });
	});
});
