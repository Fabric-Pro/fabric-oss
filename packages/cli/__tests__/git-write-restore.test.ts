/**
 * When `git merge --ff-only` refuses over a tracked file that `git diff` calls
 * unchanged, `fastForwardTo` may put the file back from the index, but only
 * when that cannot lose anything: the raw bytes in the work tree equal the
 * index's apart from CRLF versus LF. `git diff` is not that proof: it skips
 * assume-unchanged and skip-worktree entries and compares through clean
 * filters, so a local edit can read as "no change". REAL git, a local bare
 * remote, and the developer's own git configuration kept out.
 */
import { execFileSync, spawnSync } from "node:child_process";
import {
	chmod,
	mkdir,
	mkdtemp,
	readFile,
	realpath,
	rm,
	stat,
	utimes,
	writeFile,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import {
	afterAll,
	afterEach,
	beforeAll,
	describe,
	expect,
	it,
	vi,
} from "vitest";
import { fastForwardTo } from "../src/lib/instructions/git.js";

const restoreRace = vi.hoisted(() => ({
	file: "",
	afterRead: undefined as (() => Promise<void>) | undefined,
	afterStat: undefined as (() => Promise<void>) | undefined,
}));
vi.mock("node:fs/promises", async (importOriginal) => {
	const actual = await importOriginal<typeof import("node:fs/promises")>();
	async function trigger(file: unknown, key: "afterRead" | "afterStat") {
		if (file === restoreRace.file && restoreRace[key]) {
			const run = restoreRace[key];
			restoreRace[key] = undefined;
			await run();
		}
	}
	return {
		...actual,
		async lstat(...args: Parameters<typeof actual.lstat>) {
			const info = await actual.lstat(...args);
			await trigger(args[0], "afterStat");
			return info;
		},
		async readFile(...args: Parameters<typeof actual.readFile>) {
			const bytes = await actual.readFile(...args);
			await trigger(args[0], "afterRead");
			return bytes;
		},
		async open(...args: Parameters<typeof actual.open>) {
			const handle = await actual.open(...args);
			const read = handle.read.bind(handle);
			handle.read = async (
				...options: Parameters<typeof handle.read>
			) => {
				const answer = await read(...options);
				if (answer.bytesRead === 0) {
					await trigger(args[0], "afterRead");
				}
				return answer;
			};
			return handle;
		},
	};
});
afterEach(() => {
	restoreRace.afterRead = undefined;
	restoreRace.afterStat = undefined;
});

const hasGit =
	spawnSync("git", ["--version"], { stdio: "ignore" }).status === 0;
const itWithGit = it.skipIf(!hasGit);

const saved: Record<string, string | undefined> = {};
const ISOLATED = [
	"HOME",
	"USERPROFILE",
	"XDG_CONFIG_HOME",
	"GIT_CONFIG_GLOBAL",
	"GIT_CONFIG_NOSYSTEM",
];

beforeAll(async () => {
	const dir = await mkdtemp(path.join(tmpdir(), "fabric-restore-config-"));
	const empty = path.join(dir, "gitconfig");
	await writeFile(empty, "");
	for (const name of ISOLATED) {
		saved[name] = process.env[name];
		delete process.env[name];
	}
	process.env.HOME = dir;
	process.env.USERPROFILE = dir;
	process.env.XDG_CONFIG_HOME = dir;
	process.env.GIT_CONFIG_GLOBAL = empty;
	process.env.GIT_CONFIG_NOSYSTEM = "1";
});

afterAll(() => {
	for (const [name, value] of Object.entries(saved)) {
		if (value === undefined) {
			delete process.env[name];
		} else {
			process.env[name] = value;
		}
	}
});

function git(cwd: string, ...args: string[]): string {
	return execFileSync(
		"git",
		[
			"-c",
			"user.name=Example Dev",
			"-c",
			"user.email=dev@example.com",
			...args,
		],
		{ cwd, encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] },
	).trim();
}

interface Fixture {
	up: string;
	wt: string;
	tip: () => string;
}

/**
 * `up` is the upstream with `file` committed as `initial`; `wt` is a clone of
 * it; the upstream then commits `incoming` to the same file and `wt` fetches
 * it, so a fast-forward to `tip()` touches `file`.
 */
async function fixture(
	file: string,
	initial: string | Buffer,
	incoming: string | Buffer,
	prepare?: (wt: string) => void,
): Promise<Fixture> {
	const base = await realpath(
		await mkdtemp(path.join(tmpdir(), "fabric-restore-")),
	);
	const up = path.join(base, "up");
	const wt = path.join(base, "wt");
	git(base, "init", "-q", "-b", "main", up);
	git(up, "config", "core.autocrlf", "false");
	await mkdir(path.dirname(path.join(up, file)), { recursive: true });
	await writeFile(path.join(up, file), initial);
	git(up, "add", "-A");
	git(up, "commit", "-q", "-m", "one");
	git(base, "clone", "-q", "-c", "core.autocrlf=false", up, wt);
	await writeFile(path.join(up, file), incoming);
	git(up, "commit", "-q", "-a", "-m", "two");
	prepare?.(wt);
	git(wt, "fetch", "-q", "origin");
	return { up, wt, tip: () => git(wt, "rev-parse", "origin/main") };
}

const soon = (): number => Date.now() + 60_000;

describe("fastForwardTo restoring files git refuses over", () => {
	itWithGit(
		"restores a file that differs only in line endings, and merges",
		async () => {
			const fx = await fixture("f.txt", "a\nb\n", "a\nb\nc\n", (wt) =>
				git(wt, "config", "core.autocrlf", "true"),
			);
			await rm(path.join(fx.wt, "f.txt"));
			git(fx.wt, "checkout", "-q", "--", "f.txt");
			expect(await readFile(path.join(fx.wt, "f.txt"), "utf8")).toBe(
				"a\r\nb\r\n",
			);
			await writeFile(path.join(fx.wt, "f.txt"), "a\nb\n");

			const result = await fastForwardTo(fx.wt, fx.tip(), soon());

			expect(result).toEqual({ kind: "merged", head: fx.tip() });
		},
	);

	itWithGit(
		"never overwrites an assume-unchanged file holding a local edit",
		async () => {
			const fx = await fixture(
				"config.txt",
				"line1\nline2\n",
				"line1\nline2\nup\n",
			);
			await writeFile(
				path.join(fx.wt, "config.txt"),
				"line1\nMY-LOCAL-SECRET=hunter2\n",
			);
			git(fx.wt, "update-index", "--assume-unchanged", "config.txt");

			const result = await fastForwardTo(fx.wt, fx.tip(), soon());

			expect(result).toEqual({
				kind: "failed",
				reason: "local-changes",
				files: ["config.txt"],
			});
			expect(await readFile(path.join(fx.wt, "config.txt"), "utf8")).toBe(
				"line1\nMY-LOCAL-SECRET=hunter2\n",
			);
		},
	);

	itWithGit(
		"never overwrites a skip-worktree file holding a local edit",
		async () => {
			const fx = await fixture("config.txt", "line1\n", "line1\nup\n");
			await writeFile(path.join(fx.wt, "config.txt"), "mine\n");
			git(fx.wt, "update-index", "--skip-worktree", "config.txt");

			const result = await fastForwardTo(fx.wt, fx.tip(), soon());

			expect(result).toMatchObject({
				kind: "failed",
				reason: "local-changes",
			});
			expect(await readFile(path.join(fx.wt, "config.txt"), "utf8")).toBe(
				"mine\n",
			);
		},
	);

	itWithGit(
		"never overwrites a file a lossy clean filter hides a local value in",
		async () => {
			const fx = await fixture(
				"secret.cfg",
				"name=x\nKEY=REDACTED\n",
				"name=y\nKEY=REDACTED\n",
				(wt) => {
					git(
						wt,
						"config",
						"filter.strip.clean",
						"sed -e 's/^KEY=.*/KEY=REDACTED/'",
					);
					git(wt, "config", "filter.strip.smudge", "cat");
				},
			);
			await writeFile(
				path.join(fx.wt, ".git", "info", "attributes"),
				"secret.cfg filter=strip\n",
			);
			await writeFile(
				path.join(fx.wt, "secret.cfg"),
				"name=x\nKEY=my-real-key\n",
			);

			const result = await fastForwardTo(fx.wt, fx.tip(), soon());

			expect(result).toMatchObject({
				kind: "failed",
				reason: "local-changes",
			});
			expect(
				await readFile(path.join(fx.wt, "secret.cfg"), "utf8"),
			).toContain("KEY=my-real-key");
		},
	);

	itWithGit(
		"treats any file with a filter as the person's, even an LFS-like pass-through",
		async () => {
			const fx = await fixture(
				"big.bin",
				"pointer\n",
				"pointer2\n",
				(wt) => {
					git(wt, "config", "filter.lfs.clean", "cat");
					git(wt, "config", "filter.lfs.smudge", "cat");
				},
			);
			await writeFile(
				path.join(fx.wt, ".git", "info", "attributes"),
				"big.bin filter=lfs\n",
			);
			await writeFile(path.join(fx.wt, "big.bin"), "pointer\r\n");

			const result = await fastForwardTo(fx.wt, fx.tip(), soon());

			expect(result).toMatchObject({
				kind: "failed",
				reason: "local-changes",
			});
			expect(await readFile(path.join(fx.wt, "big.bin"), "utf8")).toBe(
				"pointer\r\n",
			);
		},
	);

	itWithGit(
		"never rewrites a binary file whose bytes differ, even by a CRLF",
		async () => {
			const initial = Buffer.from([0, 1, 10, 2, 0, 10, 3]);
			const fx = await fixture(
				"data.bin",
				initial,
				Buffer.from([0, 9, 9, 9]),
			);
			const mine = Buffer.from([0, 1, 13, 10, 2, 0, 13, 10, 3]);
			await writeFile(path.join(fx.wt, "data.bin"), mine);

			const result = await fastForwardTo(fx.wt, fx.tip(), soon());

			expect(result).toMatchObject({
				kind: "failed",
				reason: "local-changes",
			});
			expect(await readFile(path.join(fx.wt, "data.bin"))).toEqual(mine);
		},
	);

	it.skipIf(!hasGit || process.platform === "win32")(
		"never drops a local chmod +x on a byte-identical file",
		async () => {
			const fx = await fixture("run.sh", "echo a\n", "echo b\n");
			await chmod(path.join(fx.wt, "run.sh"), 0o755);

			const result = await fastForwardTo(fx.wt, fx.tip(), soon());

			expect(result).toMatchObject({
				kind: "failed",
				reason: "local-changes",
				files: ["run.sh"],
			});
			expect(
				(await stat(path.join(fx.wt, "run.sh"))).mode & 0o111,
			).not.toBe(0);
		},
	);

	itWithGit(
		"does not rewrite, at every session, a file git can never see as clean (CRLF in the index, eol=lf)",
		async () => {
			const fx = await fixture("f.txt", "a\r\nb\r\n", "a\r\nb\r\nc\r\n");
			await writeFile(
				path.join(fx.wt, ".git", "info", "attributes"),
				"* text eol=lf\n",
			);
			const before = await readFile(path.join(fx.wt, "f.txt"));
			const modified = (await stat(path.join(fx.wt, "f.txt"))).mtimeMs;
			await utimes(path.join(fx.wt, "f.txt"), new Date(), new Date());

			const result = await fastForwardTo(fx.wt, fx.tip(), soon());

			expect(result).toMatchObject({
				kind: "failed",
				reason: "local-changes",
				files: ["f.txt"],
			});
			expect(await readFile(path.join(fx.wt, "f.txt"))).toEqual(before);
			expect(modified).toBeGreaterThan(0);
		},
	);

	itWithGit(
		"reads an attribute with an empty value as converting, not as a shifted triplet",
		async () => {
			const fx = await fixture("a.cfg", "x\n", "y\n");
			await writeFile(
				path.join(fx.wt, ".git", "info", "attributes"),
				"a.cfg filter=\n",
			);
			await writeFile(path.join(fx.wt, "a.cfg"), "x\r\n");

			const result = await fastForwardTo(fx.wt, fx.tip(), soon());

			expect(result).toMatchObject({
				kind: "failed",
				reason: "local-changes",
			});
			expect(await readFile(path.join(fx.wt, "a.cfg"), "utf8")).toBe(
				"x\r\n",
			);
		},
	);

	itWithGit(
		"restores many line-ending-only files with one batched read",
		async () => {
			const names = Array.from({ length: 12 }, (_, at) => `d/f${at}.txt`);
			const fx = await fixture(names[0] as string, "0\n", "0b\n", (wt) =>
				git(wt, "config", "core.autocrlf", "true"),
			);
			for (const [at, name] of names.entries()) {
				await mkdir(path.dirname(path.join(fx.up, name)), {
					recursive: true,
				});
				await writeFile(path.join(fx.up, name), `${at}\n`);
			}
			git(fx.up, "add", "-A");
			git(fx.up, "commit", "-q", "-m", "many");
			git(fx.wt, "fetch", "-q", "origin");
			git(fx.wt, "merge", "-q", "--ff-only", "origin/main");
			for (const name of names) {
				await writeFile(path.join(fx.up, name), "changed upstream\n");
			}
			git(fx.up, "commit", "-q", "-a", "-m", "touch all");
			git(fx.wt, "fetch", "-q", "origin");
			for (const name of names) {
				await rm(path.join(fx.wt, name));
				git(fx.wt, "checkout", "-q", "--", name);
				await writeFile(
					path.join(fx.wt, name),
					`${names.indexOf(name)}\n`,
				);
			}

			const result = await fastForwardTo(fx.wt, fx.tip(), soon());

			expect(result).toEqual({ kind: "merged", head: fx.tip() });
		},
	);

	itWithGit("still refuses a staged change", async () => {
		const fx = await fixture("f.txt", "a\n", "a\nup\n");
		await writeFile(path.join(fx.wt, "f.txt"), "staged edit\n");
		git(fx.wt, "add", "f.txt");

		const result = await fastForwardTo(fx.wt, fx.tip(), soon());

		expect(result).toMatchObject({
			kind: "failed",
			reason: "local-changes",
			files: ["f.txt"],
		});
		expect(await readFile(path.join(fx.wt, "f.txt"), "utf8")).toBe(
			"staged edit\n",
		);
	});
});

describe("restore descriptor guards", () => {
	it.skipIf(!hasGit || process.platform === "win32")(
		"refuses a symlink swapped in after the file check",
		async () => {
			const { symlink } = await import("node:fs/promises");
			const fx = await fixture("f.txt", "a\nb\n", "incoming\n", (wt) =>
				git(wt, "config", "core.autocrlf", "true"),
			);
			const file = path.join(fx.wt, "f.txt");
			await rm(file);
			git(fx.wt, "checkout", "-q", "--", "f.txt");
			await writeFile(file, "a\nb\n");
			const target = path.join(fx.wt, "outside.txt");
			await writeFile(target, "a\nb\n");
			restoreRace.file = file;
			restoreRace.afterStat = async () => {
				await rm(file);
				await symlink(target, file);
			};
			expect(await fastForwardTo(fx.wt, fx.tip(), soon())).toMatchObject({
				kind: "failed",
				reason: "local-changes",
			});
			const { lstat } = await import("node:fs/promises");
			expect((await lstat(file)).isSymbolicLink()).toBe(true);
		},
	);
	it.skipIf(!hasGit || process.platform === "win32")(
		"refuses a mode change made after the first content read",
		async () => {
			const fx = await fixture("f.txt", "a\nb\n", "incoming\n", (wt) =>
				git(wt, "config", "core.autocrlf", "true"),
			);
			const file = path.join(fx.wt, "f.txt");
			await rm(file);
			git(fx.wt, "checkout", "-q", "--", "f.txt");
			await writeFile(file, "a\nb\n");
			restoreRace.file = file;
			restoreRace.afterRead = async () => {
				await chmod(file, 0o755);
			};
			expect(await fastForwardTo(fx.wt, fx.tip(), soon())).toMatchObject({
				kind: "failed",
				reason: "local-changes",
			});
			expect((await stat(file)).mode & 0o111).not.toBe(0);
		},
	);
});

it.skipIf(!hasGit || process.platform === "win32")(
	"rechecks file type after judging the first content read",
	async () => {
		const { symlink, lstat } = await import("node:fs/promises");
		const fx = await fixture("f.txt", "a\nb\n", "incoming\n", (wt) =>
			git(wt, "config", "core.autocrlf", "true"),
		);
		const file = path.join(fx.wt, "f.txt");
		await rm(file);
		git(fx.wt, "checkout", "-q", "--", "f.txt");
		await writeFile(file, "a\nb\n");
		const target = path.join(fx.wt, "outside.txt");
		await writeFile(target, "a\nb\n");
		restoreRace.file = file;
		restoreRace.afterRead = async () => {
			await rm(file);
			await symlink(target, file);
		};
		expect(await fastForwardTo(fx.wt, fx.tip(), soon())).toMatchObject({
			kind: "failed",
			reason: "local-changes",
		});
		expect((await lstat(file)).isSymbolicLink()).toBe(true);
	},
);

itWithGit(
	"restores line-ending-only files through a checkout directory alias",
	async () => {
		const { symlink } = await import("node:fs/promises");
		const fx = await fixture("f.txt", "a\nb\n", "a\nb\nc\n", (wt) =>
			git(wt, "config", "core.autocrlf", "true"),
		);
		const file = path.join(fx.wt, "f.txt");
		await rm(file);
		git(fx.wt, "checkout", "-q", "--", "f.txt");
		await writeFile(file, "a\nb\n");
		const alias = `${fx.wt}-alias`;
		await symlink(fx.wt, alias, "junction");
		expect(await fastForwardTo(alias, fx.tip(), soon())).toEqual({
			kind: "merged",
			head: fx.tip(),
		});
	},
);
