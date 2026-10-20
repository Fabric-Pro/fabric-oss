/**
 * The one-file exclusive lock the refresh lock and the fast-forward lock share
 * (Fizzy #2878): `O_EXCL` creation is the lock, an old lock with no live
 * owner is reported for recovery when abandoned, and `work` never runs without it.
 */
import {
	mkdtemp,
	readFile,
	stat,
	symlink,
	unlink,
	utimes,
	writeFile,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
	ExclusiveLockBusyError,
	withExclusiveLock,
	withExclusiveLockSync,
} from "../src/lib/exclusive-lock.js";

const { lockIo } = vi.hoisted(() => ({
	lockIo: {
		afterStat: undefined as (() => void) | undefined,
		afterCreate: undefined as (() => void) | undefined,
		beforeCompare: undefined as (() => void) | undefined,
		failure: "actual" as "actual" | "unreadable" | "released-during-read",
	},
}));

vi.mock("node:fs", async (importOriginal) => {
	const actual = await importOriginal<typeof import("node:fs")>();
	const failure = (code: "EACCES" | "EEXIST" | "ENOENT") =>
		Object.assign(new Error(code), { code });
	return {
		...actual,
		openSync(...args: Parameters<typeof actual.openSync>) {
			if (lockIo.failure !== "actual") {
				if (args[1] === "wx") {
					throw failure("EEXIST");
				}
				throw failure(
					lockIo.failure === "unreadable" ? "EACCES" : "ENOENT",
				);
			}
			return actual.openSync(...args);
		},
		writeSync(...args: Parameters<typeof actual.writeSync>) {
			const written = actual.writeSync(...args);
			const run = lockIo.afterCreate;
			lockIo.afterCreate = undefined;
			run?.();
			return written;
		},
		fstatSync(...args: Parameters<typeof actual.fstatSync>) {
			const info = actual.fstatSync(...args);
			const run = lockIo.afterStat;
			lockIo.afterStat = undefined;
			run?.();
			return info;
		},
		lstatSync(...args: Parameters<typeof actual.lstatSync>) {
			const run = lockIo.beforeCompare;
			lockIo.beforeCompare = undefined;
			run?.();
			return actual.lstatSync(...args);
		},
		statSync(...args: Parameters<typeof actual.statSync>) {
			switch (lockIo.failure) {
				case "unreadable":
					throw failure("EACCES");
				case "released-during-read":
					throw failure("ENOENT");
				case "actual": {
					const info = actual.statSync(...args);
					const run = lockIo.afterStat;
					lockIo.afterStat = undefined;
					run?.();
					return info;
				}
			}
		},
	};
});

let lockPath: string;

beforeEach(async () => {
	const dir = await mkdtemp(path.join(tmpdir(), "fabric-lock-"));
	lockPath = path.join(dir, "example.lock");
});

afterEach(() => {
	lockIo.failure = "actual";
	lockIo.afterStat = undefined;
	lockIo.afterCreate = undefined;
	lockIo.beforeCompare = undefined;
});

const options = (
	overrides: Partial<Parameters<typeof withExclusiveLock>[1]> = {},
) => ({
	lockPath,
	staleMs: 30_000,
	waitMs: 0,
	...overrides,
});

async function exists(file: string): Promise<boolean> {
	return stat(file).then(
		() => true,
		() => false,
	);
}

describe("withExclusiveLock", () => {
	it("holds the lock while the work runs, with the holder's pid and identity in it, and releases it", async () => {
		let during: string | undefined;

		const result = await withExclusiveLock(async () => {
			during = await readFile(lockPath, "utf8");
			return "done";
		}, options());

		expect(result).toBe("done");
		expect(during).toMatch(new RegExp(`^${process.pid}:[0-9a-f-]+$`));
		expect(await exists(lockPath)).toBe(false);
	});

	it.skipIf(process.platform === "win32")(
		"creates the file readable by its owner only",
		async () => {
			let mode = 0;

			await withExclusiveLock(async () => {
				mode = (await stat(lockPath)).mode & 0o777;
			}, options());

			expect(mode).toBe(0o600);
		},
	);

	it("releases the lock when the work throws, and passes the error on", async () => {
		const failure = new Error("boom");

		const attempt = withExclusiveLock(async () => {
			throw failure;
		}, options());

		await expect(attempt).rejects.toBe(failure);
		expect(await exists(lockPath)).toBe(false);
	});

	it("gives up at once, without running the work, when waitMs is 0 and the lock is held", async () => {
		let ranSecond = false;

		await withExclusiveLock(async () => {
			const second = withExclusiveLock(
				async () => {
					ranSecond = true;
				},
				options({ waitMs: 0 }),
			);
			await expect(second).rejects.toBeInstanceOf(ExclusiveLockBusyError);
		}, options());

		expect(ranSecond).toBe(false);
		expect(await exists(lockPath)).toBe(false);
	});

	it("lets exactly one of two concurrent callers run", async () => {
		const ran: string[] = [];
		const run = (name: string) =>
			withExclusiveLock(async () => {
				ran.push(name);
				await new Promise((resolve) => setTimeout(resolve, 100));
			}, options()).then(
				() => "ran",
				(error: unknown) =>
					error instanceof ExclusiveLockBusyError ? "busy" : "failed",
			);

		const results = await Promise.all([run("a"), run("b")]);

		expect(results.sort()).toEqual(["busy", "ran"]);
		expect(ran).toHaveLength(1);
		expect(await exists(lockPath)).toBe(false);
	});

	it("waits for a held lock that is released in time, then runs", async () => {
		const order: string[] = [];

		await Promise.all([
			withExclusiveLock(async () => {
				order.push("first");
				await new Promise((resolve) => setTimeout(resolve, 150));
			}, options()),
			withExclusiveLock(
				async () => {
					order.push("second");
				},
				options({ waitMs: 2_000, pollMs: 20 }),
			),
		]);

		expect(order).toEqual(["first", "second"]);
	});

	it("reports an old lock a dead holder left behind without removing it", async () => {
		await writeFile(lockPath, "99999");
		const old = new Date(Date.now() - 60_000);
		await utimes(lockPath, old, old);

		await expect(
			withExclusiveLock(async () => "no", options()),
		).rejects.toMatchObject({
			abandoned: true,
		});
		expect(await readFile(lockPath, "utf8")).toBe("99999");
	});

	it("does not take over a lock that is not yet stale", async () => {
		await writeFile(lockPath, "99999");

		const attempt = withExclusiveLock(async () => "no", options());

		await expect(attempt).rejects.toBeInstanceOf(ExclusiveLockBusyError);
		expect(await exists(lockPath)).toBe(true);
	});

	it("does not take over a stale-looking lock while its owner is alive", async () => {
		let releaseFirst: (() => void) | undefined;
		const first = withExclusiveLock(
			async () =>
				await new Promise<void>((resolve) => {
					releaseFirst = resolve;
				}),
			options({ staleMs: 1 }),
		);
		await new Promise((resolve) => setTimeout(resolve, 10));

		await expect(
			withExclusiveLock(async () => "no", options({ staleMs: 1 })),
		).rejects.toBeInstanceOf(ExclusiveLockBusyError);

		releaseFirst?.();
		await first;
	});

	it("does not remove a successor's lock when its own identity no longer matches", async () => {
		const successor = `${process.pid}:successor`;

		await withExclusiveLock(async () => {
			await writeFile(lockPath, successor);
		}, options());

		expect(await readFile(lockPath, "utf8")).toBe(successor);
	});

	it("propagates an unreadable existing lock instead of retrying it forever", async () => {
		lockIo.failure = "unreadable";

		await expect(
			withExclusiveLock(async () => "no", options()),
		).rejects.toMatchObject({
			code: "EACCES",
		});
		expect(() => withExclusiveLockSync(() => "no", options())).toThrow(
			"EACCES",
		);
	});

	it("bounds release-and-recreate races in async and synchronous callers", async () => {
		lockIo.failure = "released-during-read";

		await expect(
			withExclusiveLock(
				async () => "no",
				options({ waitMs: 25, pollMs: 1 }),
			),
		).rejects.toBeInstanceOf(ExclusiveLockBusyError);
		expect(() =>
			withExclusiveLockSync(
				() => "no",
				options({ waitMs: 25, pollMs: 1 }),
			),
		).toThrow(ExclusiveLockBusyError);
	});

	it.each(["async", "sync"])(
		"retries regular-file turnover during inspection in the %s caller and waits for the successor to release",
		async (mode) => {
			const actual =
				await vi.importActual<typeof import("node:fs")>("node:fs");
			await writeFile(lockPath, "99999");
			const old = new Date(Date.now() - 60_000);
			await utimes(lockPath, old, old);
			const successor = `${process.pid}:successor`;
			let successorReleased = false;
			const work = vi.fn(() => {
				expect(successorReleased).toBe(true);
				return "done";
			});
			lockIo.beforeCompare = () => {
				actual.renameSync(lockPath, `${lockPath}.previous`);
				actual.writeFileSync(lockPath, successor);
				// Keep the successor through one complete inspection. The waiter
				// must wait for it rather than use the detached stale owner's text.
				lockIo.beforeCompare = () => {
					expect(work).not.toHaveBeenCalled();
					expect(actual.readFileSync(lockPath, "utf8")).toBe(
						successor,
					);
					lockIo.beforeCompare = () => {
						expect(work).not.toHaveBeenCalled();
						actual.unlinkSync(lockPath);
						successorReleased = true;
					};
				};
			};
			const waiting = options({ waitMs: 500, pollMs: 1 });
			const result =
				mode === "async"
					? await withExclusiveLock(async () => work(), waiting)
					: withExclusiveLockSync(work, waiting);

			expect(result).toBe("done");
			expect(work).toHaveBeenCalledTimes(1);
			expect(await exists(lockPath)).toBe(false);
		},
	);

	it.each(["async", "sync"])(
		"bounds repeated regular-file turnover in the %s caller",
		async (mode) => {
			const actual =
				await vi.importActual<typeof import("node:fs")>("node:fs");
			await writeFile(lockPath, `${process.pid}:holder`);
			const replace = () => {
				actual.renameSync(lockPath, `${lockPath}.previous`);
				actual.writeFileSync(lockPath, `${process.pid}:successor`);
				lockIo.beforeCompare = replace;
			};
			lockIo.beforeCompare = replace;
			const work = vi.fn();
			const waiting = options({ waitMs: 25, pollMs: 1 });
			const attempt = async () =>
				mode === "async"
					? withExclusiveLock(work, waiting)
					: withExclusiveLockSync(work, waiting);

			await expect(attempt()).rejects.toBeInstanceOf(
				ExclusiveLockBusyError,
			);
			expect(work).not.toHaveBeenCalled();
		},
	);

	it("stops waiting when the signal aborts, and runs nothing", async () => {
		await writeFile(lockPath, "99999");
		const controller = new AbortController();
		setTimeout(() => controller.abort(new Error("stop")), 50);

		const attempt = withExclusiveLock(
			async () => "no",
			options({ waitMs: 5_000, pollMs: 20, signal: controller.signal }),
		);

		await expect(attempt).rejects.toThrow("stop");
	});
});

describe("unsafe lock files", () => {
	it("rejects an oversized fresh lock immediately in both callers", async () => {
		await writeFile(lockPath, "x".repeat(1024));
		const work = vi.fn();
		await expect(withExclusiveLock(work, options())).rejects.toThrow(
			/lock.*(large|size)/i,
		);
		expect(() => withExclusiveLockSync(work, options())).toThrow(
			/lock.*(large|size)/i,
		);
		expect(work).not.toHaveBeenCalled();
	});
	it.skipIf(process.platform === "win32")(
		"rejects a symlink lock and leaves its target alone",
		async () => {
			const target = `${lockPath}.target`;
			await writeFile(target, "99999");
			await symlink(target, lockPath);
			const work = vi.fn();
			await expect(
				withExclusiveLock(work, options()),
			).rejects.toMatchObject({ code: "ELOOP" });
			expect(work).not.toHaveBeenCalled();
			expect(await readFile(target, "utf8")).toBe("99999");
		},
	);
	it.skipIf(process.platform === "win32")(
		"does not unlink a replacement symlink holding the same owner text on release",
		async () => {
			const target = `${lockPath}.target`;
			await withExclusiveLock(async () => {
				await writeFile(target, await readFile(lockPath));
				await unlink(lockPath);
				await symlink(target, lockPath);
			}, options());
			const { lstat } = await import("node:fs/promises");
			expect((await lstat(lockPath)).isSymbolicLink()).toBe(true);
		},
	);
});

it("bounds a lock that grows after its metadata is checked", async () => {
	const actual = await vi.importActual<typeof import("node:fs")>("node:fs");
	await writeFile(lockPath, "99999");
	const old = new Date(Date.now() - 60_000);
	await utimes(lockPath, old, old);
	lockIo.afterStat = () => actual.writeFileSync(lockPath, "x".repeat(1024));
	const work = vi.fn();
	await expect(withExclusiveLock(work, options())).rejects.toThrow(
		/lock.*large/i,
	);
	expect(work).not.toHaveBeenCalled();
});
it("rejects a directory lock without running work", async () => {
	const { mkdir } = await import("node:fs/promises");
	await mkdir(lockPath);
	const work = vi.fn();
	await expect(withExclusiveLock(work, options())).rejects.toThrow(
		/regular file/,
	);
	expect(() => withExclusiveLockSync(work, options())).toThrow(
		/regular file/,
	);
	expect(work).not.toHaveBeenCalled();
});
it("checks the created file identity immediately before work", async () => {
	const actual = await vi.importActual<typeof import("node:fs")>("node:fs");
	lockIo.afterCreate = () => {
		actual.renameSync(lockPath, `${lockPath}.original`);
		actual.writeFileSync(
			lockPath,
			actual.readFileSync(`${lockPath}.original`),
		);
	};
	const work = vi.fn();
	await expect(withExclusiveLock(work, options())).rejects.toThrow(
		/lock changed/,
	);
	expect(work).not.toHaveBeenCalled();
	expect(await exists(lockPath)).toBe(true);
});

it.each(["async", "sync"])(
	"refuses turnover during the %s caller's ownership check before work",
	async (mode) => {
		const actual =
			await vi.importActual<typeof import("node:fs")>("node:fs");
		let successor: string | undefined;
		lockIo.beforeCompare = () => {
			successor = actual.readFileSync(lockPath, "utf8");
			actual.renameSync(lockPath, `${lockPath}.previous`);
			actual.writeFileSync(lockPath, successor);
		};
		const work = vi.fn();
		const attempt = async () =>
			mode === "async"
				? withExclusiveLock(work, options({ waitMs: 500, pollMs: 1 }))
				: withExclusiveLockSync(
						work,
						options({ waitMs: 500, pollMs: 1 }),
					);

		await expect(attempt()).rejects.toThrow(/lock changed/);
		expect(work).not.toHaveBeenCalled();
		expect(await readFile(lockPath, "utf8")).toBe(successor);
	},
);

for (const kind of ["directory", "oversized", "symlink"]) {
	it.skipIf(kind === "symlink" && process.platform === "win32")(
		`rejects replacement by a ${kind} during inspection`,
		async () => {
			const actual =
				await vi.importActual<typeof import("node:fs")>("node:fs");
			await writeFile(lockPath, "99999");
			lockIo.beforeCompare = () => {
				actual.renameSync(lockPath, `${lockPath}.previous`);
				if (kind === "directory") {
					actual.mkdirSync(lockPath);
				} else if (kind === "oversized") {
					actual.writeFileSync(lockPath, "x".repeat(1024));
				} else {
					actual.symlinkSync(`${lockPath}.previous`, lockPath);
				}
			};
			const work = vi.fn();
			await expect(
				withExclusiveLock(work, options({ waitMs: 500, pollMs: 1 })),
			).rejects.toThrow(
				kind === "oversized" ? /too large/ : /regular file/,
			);
			expect(work).not.toHaveBeenCalled();
		},
	);
}
