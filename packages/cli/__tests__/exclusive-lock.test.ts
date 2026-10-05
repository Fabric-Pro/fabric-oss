/**
 * The one-file exclusive lock the refresh lock and the fast-forward lock share
 * (Fizzy #2878): `O_EXCL` creation is the lock, a dead holder's file is taken
 * over once it is stale, and `work` never runs without it.
 */
import { mkdtemp, readFile, stat, utimes, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { beforeEach, describe, expect, it } from "vitest";
import {
	ExclusiveLockBusyError,
	withExclusiveLock,
} from "../src/lib/exclusive-lock.js";

let lockPath: string;

beforeEach(async () => {
	const dir = await mkdtemp(path.join(tmpdir(), "fabric-lock-"));
	lockPath = path.join(dir, "example.lock");
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
	it("holds the lock while the work runs, with the holder's pid in it, and releases it", async () => {
		let during: string | undefined;

		const result = await withExclusiveLock(async () => {
			during = await readFile(lockPath, "utf8");
			return "done";
		}, options());

		expect(result).toBe("done");
		expect(during).toBe(String(process.pid));
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

	it("takes over a lock older than staleMs, which a dead holder left behind", async () => {
		await writeFile(lockPath, "99999");
		const old = new Date(Date.now() - 60_000);
		await utimes(lockPath, old, old);

		const result = await withExclusiveLock(
			async () => "took it",
			options(),
		);

		expect(result).toBe("took it");
	});

	it("does not take over a lock that is not yet stale", async () => {
		await writeFile(lockPath, "99999");

		const attempt = withExclusiveLock(async () => "no", options());

		await expect(attempt).rejects.toBeInstanceOf(ExclusiveLockBusyError);
		expect(await exists(lockPath)).toBe(true);
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
