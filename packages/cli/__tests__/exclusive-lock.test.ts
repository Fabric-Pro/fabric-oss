/**
 * The one-file exclusive lock the refresh lock and the fast-forward lock share
 * (Fizzy #2878): `O_EXCL` creation is the lock, an old lock with no live
 * owner is reported for recovery when abandoned, and `work` never runs without it.
 */
import { mkdtemp, readFile, stat, utimes, writeFile } from "node:fs/promises";
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
				throw failure("EEXIST");
			}
			return actual.openSync(...args);
		},
		statSync(...args: Parameters<typeof actual.statSync>) {
			switch (lockIo.failure) {
				case "unreadable":
					throw failure("EACCES");
				case "released-during-read":
					throw failure("ENOENT");
				case "actual":
					return actual.statSync(...args);
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
