import assert from "node:assert/strict";
import { mkdtemp, rm, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, it } from "node:test";
import { hashCredentials, ProcessPool } from "../process-pool";
import type { StdioTransport } from "../stdio-transport";

type FakeTransport = StdioTransport & { closed: boolean; name: string };

/**
 * `closeDelayMs` stands in for a child that takes a while to exit. Like
 * `StdioTransport`, it reports itself dead as soon as closing starts, and a
 * second `close` returns at once.
 */
function fakeTransport(name: string, closeDelayMs = 0): FakeTransport {
	let closing = false;
	const transport = {
		name,
		closed: false,
		isAlive() {
			return !closing;
		},
		async close() {
			if (closing) {
				return;
			}
			closing = true;
			if (closeDelayMs > 0) {
				await sleep(closeDelayMs);
			}
			transport.closed = true;
		},
		async request() {
			if (transport.closed) {
				throw new Error("Transport closed");
			}
			return { from: name };
		},
	};
	return transport as unknown as FakeTransport;
}

function sleep(ms: number): Promise<void> {
	return new Promise((resolve) => setTimeout(resolve, ms));
}

const createdDirs: string[] = [];
async function credentialDir(): Promise<string> {
	const dir = await mkdtemp(join(tmpdir(), "example-pool-test-"));
	createdDirs.push(dir);
	await writeFile(join(dir, "credentials.json"), "{}");
	return dir;
}

async function exists(path: string): Promise<boolean> {
	return stat(path).then(
		() => true,
		() => false,
	);
}

const pools: ProcessPool[] = [];
function newPool(
	config: ConstructorParameters<typeof ProcessPool>[0] = {},
): ProcessPool {
	const pool = new ProcessPool({ cleanupIntervalMs: 60_000, ...config });
	pools.push(pool);
	return pool;
}

afterEach(async () => {
	await Promise.all(pools.splice(0).map((pool) => pool.shutdown()));
	// Whatever a failing run left behind.
	await Promise.all(
		createdDirs
			.splice(0)
			.map((dir) => rm(dir, { recursive: true, force: true })),
	);
});

describe("hashCredentials", () => {
	it("ignores entry order and changes with any value", () => {
		assert.equal(
			hashCredentials({ A: "1", B: "2" }),
			hashCredentials({ B: "2", A: "1" }),
		);
		assert.notEqual(
			hashCredentials({ A: "1", B: "2" }),
			hashCredentials({ A: "1", B: "3" }),
		);
		assert.equal(hashCredentials(undefined), hashCredentials({}));
		// No key/value boundary is ambiguous.
		assert.notEqual(
			hashCredentials({ AB: "C" }),
			hashCredentials({ A: "BC" }),
		);
	});

	it("does not contain the credential", () => {
		const hash = hashCredentials({ TOKEN: "example-secret-value" });
		assert.ok(!hash.includes("example-secret-value"));
		assert.match(hash, /^[0-9a-f]{64}$/);
	});
});

describe("ProcessPool credentials", () => {
	it("replaces a live process when the same key brings other credentials, and deletes the old temp files", async () => {
		const pool = newPool();
		const firstDir = await credentialDir();
		const secondDir = await credentialDir();
		const first = fakeTransport("first");
		const second = fakeTransport("second");
		let spawns = 0;

		const a = await pool.getOrCreate(
			"example-user",
			"example-org",
			"example-config",
			async () => {
				spawns++;
				return { transport: first, cleanupPaths: [firstDir] };
			},
			hashCredentials({ TOKEN: "old" }),
		);
		// The request on the first process is done.
		await pool.release(a);
		const b = await pool.getOrCreate(
			"example-user",
			"example-org",
			"example-config",
			async () => {
				spawns++;
				return { transport: second, cleanupPaths: [secondDir] };
			},
			hashCredentials({ TOKEN: "new" }),
		);

		assert.equal(a, first);
		assert.equal(b, second);
		assert.equal(spawns, 2);
		await pool.closesSettled();
		assert.equal(first.closed, true);
		assert.equal(await exists(firstDir), false);
		assert.equal(second.closed, false);
		assert.equal(await exists(secondDir), true);
		assert.equal(pool.getStats().size, 1);
		// Stats never expose the hash.
		assert.ok(
			!JSON.stringify(pool.getStats()).includes(
				hashCredentials({ TOKEN: "new" }),
			),
		);
	});

	it("keeps a replaced process running until the request using it finishes", async () => {
		const pool = newPool();
		const firstDir = await credentialDir();
		const first = fakeTransport("first");
		const second = fakeTransport("second");

		const a = await pool.getOrCreate(
			"example-user",
			"example-org",
			"example-config",
			async () => ({ transport: first, cleanupPaths: [firstDir] }),
			hashCredentials({ TOKEN: "old" }),
		);
		// A second request on the first process, still in flight too.
		const a2 = await pool.getOrCreate(
			"example-user",
			"example-org",
			"example-config",
			async () => fakeTransport("unused"),
			hashCredentials({ TOKEN: "old" }),
		);
		assert.equal(a2, first);
		const b = await pool.getOrCreate(
			"example-user",
			"example-org",
			"example-config",
			async () => second,
			hashCredentials({ TOKEN: "new" }),
		);

		assert.equal(b, second);
		assert.equal(
			pool.get("example-user", "example-org", "example-config"),
			second,
		);
		// Both requests on the first process can still finish.
		assert.equal(first.closed, false);
		assert.deepEqual(await a.request("tools/call", {}), { from: "first" });
		await pool.release(a);
		assert.equal(first.closed, false);
		await pool.release(a2);
		await pool.closesSettled();
		assert.equal(first.closed, true);
		assert.equal(await exists(firstDir), false);
		assert.equal(second.closed, false);
	});

	it("reuses the live process for identical credentials", async () => {
		const pool = newPool();
		let spawns = 0;
		const factory = async () => {
			spawns++;
			return fakeTransport(`spawn-${spawns}`);
		};

		const a = await pool.getOrCreate(
			"example-user",
			undefined,
			"example-config",
			factory,
			hashCredentials({ A: "1", B: "2" }),
		);
		const b = await pool.getOrCreate(
			"example-user",
			undefined,
			"example-config",
			factory,
			hashCredentials({ B: "2", A: "1" }),
		);

		assert.equal(a, b);
		assert.equal(spawns, 1);
	});

	it("does not share a pending creation between different credentials", async () => {
		const pool = newPool();
		let releaseOld: () => void = () => {};
		const oldGate = new Promise<void>((resolve) => {
			releaseOld = resolve;
		});
		const spawned: string[] = [];

		const oldCall = pool.getOrCreate(
			"example-user",
			"example-org",
			"example-config",
			async () => {
				spawned.push("old");
				await oldGate;
				return fakeTransport("old");
			},
			hashCredentials({ TOKEN: "old" }),
		);
		const newCall = pool.getOrCreate(
			"example-user",
			"example-org",
			"example-config",
			async () => {
				spawned.push("new");
				return fakeTransport("new");
			},
			hashCredentials({ TOKEN: "new" }),
		);
		const sameAsNew = pool.getOrCreate(
			"example-user",
			"example-org",
			"example-config",
			async () => {
				spawned.push("new-again");
				return fakeTransport("new-again");
			},
			hashCredentials({ TOKEN: "new" }),
		);
		releaseOld();

		const [oldTransport, newTransport, sharedTransport] = await Promise.all(
			[oldCall, newCall, sameAsNew],
		);

		assert.deepEqual(spawned.sort(), ["new", "old"]);
		assert.equal((oldTransport as FakeTransport).name, "old");
		assert.equal((newTransport as FakeTransport).name, "new");
		assert.equal(sharedTransport, newTransport);
		// The old-credentials creation started first but finished last: it
		// must not replace (and close) the newer process.
		assert.equal((newTransport as FakeTransport).closed, false);
		assert.equal(
			pool.get("example-user", "example-org", "example-config"),
			newTransport,
		);
		// Its own request still runs on it; it is closed once that is done.
		assert.equal((oldTransport as FakeTransport).closed, false);
		await pool.release(oldTransport);
		assert.equal((oldTransport as FakeTransport).closed, true);
		// Two requests hold the new process.
		await pool.release(newTransport);
		await pool.release(sharedTransport);
		assert.equal((newTransport as FakeTransport).closed, false);
	});

	it("does not let a failure on a replaced process remove its replacement", async () => {
		const pool = newPool();
		const first = fakeTransport("first");
		const second = fakeTransport("second");

		await pool.getOrCreate(
			"example-user",
			"example-org",
			"example-config",
			async () => first,
			hashCredentials({ TOKEN: "old" }),
		);
		await pool.getOrCreate(
			"example-user",
			"example-org",
			"example-config",
			async () => second,
			hashCredentials({ TOKEN: "new" }),
		);
		await pool.remove(
			"example-user",
			"example-org",
			"example-config",
			first,
		);

		assert.equal(second.closed, false);
		assert.equal(
			pool.get("example-user", "example-org", "example-config"),
			second,
		);
	});
});

const USER = "example-user";
const ORG = "example-org";
const CONFIG = "example-config";

/** A creation whose factory resolves after `delayMs`. */
function createAfter(
	pool: ProcessPool,
	transport: FakeTransport,
	delayMs: number,
	token: string,
	configId = CONFIG,
	credentialsVersion?: number[],
): Promise<StdioTransport> {
	return pool.getOrCreate(
		USER,
		ORG,
		configId,
		async () => {
			await sleep(delayMs);
			return transport;
		},
		hashCredentials({ TOKEN: token }),
		credentialsVersion,
	);
}

/** Pools `transport` for `configId` and returns its lease, leaving it idle. */
async function pooledIdle(
	pool: ProcessPool,
	transport: FakeTransport,
	token: string,
	configId = CONFIG,
): Promise<void> {
	const leased = await createAfter(pool, transport, 0, token, configId);
	await pool.release(leased);
}

describe("ProcessPool overlapping creations for one key", () => {
	for (const [label, olderDelay, newerDelay] of [
		["the newer creation finishes first", 20, 5],
		["the older creation finishes first", 5, 20],
	] as const) {
		it(`pools the newer process and closes the older one when ${label}, while the replaced process closes slowly`, async () => {
			const pool = newPool();
			const idle = fakeTransport("idle", 50);
			await pooledIdle(pool, idle, "t0");
			const older = fakeTransport("older", 50);
			const newer = fakeTransport("newer", 50);

			const olderCall = createAfter(pool, older, olderDelay, "t1");
			const newerCall = createAfter(pool, newer, newerDelay, "t2");
			const [a, b] = await Promise.all([olderCall, newerCall]);

			// The later-started creation wins, whatever the finishing order.
			assert.equal(pool.get(USER, ORG, CONFIG), newer);
			assert.equal(pool.getStats().size, 1);
			await pool.release(a);
			await pool.release(b);
			await pool.closesSettled();
			// The older process is closed once its request is done; it is
			// not left running outside the pool.
			assert.equal(older.closed, true);
			assert.equal(idle.closed, true);
			assert.equal(newer.closed, false);
		});
	}

	it("does not lose a process when an LRU eviction close overlaps a second creation", async () => {
		const pool = newPool({ maxProcesses: 1 });
		const other = fakeTransport("other-config", 50);
		await pooledIdle(pool, other, "t0", "example-other-config");
		const older = fakeTransport("older", 50);
		const newer = fakeTransport("newer", 50);

		const [a, b] = await Promise.all([
			createAfter(pool, older, 5, "t1"),
			createAfter(pool, newer, 20, "t2"),
		]);

		assert.equal(pool.get(USER, ORG, CONFIG), newer);
		assert.equal(pool.getStats().size, 1);
		await pool.release(a);
		await pool.release(b);
		await pool.closesSettled();
		assert.equal(other.closed, true);
		assert.equal(older.closed, true);
		assert.equal(newer.closed, false);
	});
});

describe("ProcessPool credential freshness", () => {
	it("serves a request carrying older credentials without displacing the fresher pooled process", async () => {
		const pool = newPool();
		const fresh = fakeTransport("fresh");
		const stale = fakeTransport("stale");
		const spare = fakeTransport("spare");
		let spawns = 0;
		const call = async (
			transport: FakeTransport,
			token: string,
			version: number[],
		) => {
			const leased = await pool.getOrCreate(
				USER,
				ORG,
				CONFIG,
				async () => {
					spawns++;
					return transport;
				},
				hashCredentials({ TOKEN: token }),
				version,
			);
			const result = await leased.request("tools/list", {});
			await pool.release(leased);
			return result;
		};

		// The fresh token reaches the wrapper first, then a request that
		// resolved the older token just before the refresh, then the fresh
		// token again.
		assert.deepEqual(await call(fresh, "t2", [4, 2000]), { from: "fresh" });
		assert.deepEqual(await call(stale, "t1", [4, 1000]), { from: "stale" });
		assert.deepEqual(await call(spare, "t2", [4, 2000]), { from: "fresh" });

		assert.equal(spawns, 2);
		assert.equal(pool.get(USER, ORG, CONFIG), fresh);
		await pool.closesSettled();
		// The one-off process for the older credentials is closed once its
		// request is done; the fresher one keeps running.
		assert.equal(stale.closed, true);
		assert.equal(fresh.closed, false);
	});

	it("pools the fresher process when a creation with older credentials started later and finished first", async () => {
		const pool = newPool();
		const fresh = fakeTransport("fresh");
		const stale = fakeTransport("stale");

		const freshCall = createAfter(pool, fresh, 20, "t2", CONFIG, [4, 2000]);
		const staleCall = createAfter(pool, stale, 5, "t1", CONFIG, [4, 1000]);
		const [a, b] = await Promise.all([freshCall, staleCall]);

		assert.equal(a, fresh);
		assert.equal(b, stale);
		assert.equal(pool.get(USER, ORG, CONFIG), fresh);
		await pool.release(a);
		await pool.release(b);
		await pool.closesSettled();
		assert.equal(stale.closed, true);
		assert.equal(fresh.closed, false);
	});

	it("orders a reconnect (higher grant generation) above a later expiry of the old grant", async () => {
		const pool = newPool();
		const reconnected = fakeTransport("reconnected");
		const old = fakeTransport("old");
		const leased = await createAfter(
			pool,
			reconnected,
			0,
			"t-new",
			CONFIG,
			[5, 1000],
		);
		await pool.release(leased);
		const late = await createAfter(
			pool,
			old,
			0,
			"t-old",
			CONFIG,
			[4, 9000],
		);
		await pool.release(late);

		assert.equal(pool.get(USER, ORG, CONFIG), reconnected);
		await pool.closesSettled();
		assert.equal(old.closed, true);
	});

	it("falls back to start order when a request carries no version", async () => {
		const pool = newPool();
		const first = fakeTransport("first");
		const second = fakeTransport("second");
		await pooledIdle(pool, first, "t1");
		const leased = await createAfter(pool, second, 0, "t2");
		await pool.release(leased);

		assert.equal(pool.get(USER, ORG, CONFIG), second);
		await pool.closesSettled();
		assert.equal(first.closed, true);
	});
});

describe("ProcessPool idle reaper", () => {
	it("does not remove a replacement pooled while it closes the old process", async () => {
		const pool = newPool({ idleTtlMs: 1 });
		const idle = fakeTransport("idle", 50);
		await pooledIdle(pool, idle, "t0");
		await sleep(5);

		const reaping = (
			pool as unknown as { cleanupIdleProcesses(): Promise<void> }
		).cleanupIdleProcesses();
		// The first call after a token refresh, during the slow close.
		const replacement = fakeTransport("replacement");
		const leased = await createAfter(pool, replacement, 0, "t1");
		await reaping;
		await pool.closesSettled();

		assert.equal(idle.closed, true);
		assert.equal(leased, replacement);
		assert.equal(pool.get(USER, ORG, CONFIG), replacement);
		assert.equal(replacement.closed, false);
	});
});

describe("ProcessPool leases on removal and eviction", () => {
	it("keeps a process removed after one request failed running until its other request finishes", async () => {
		const pool = newPool();
		const shared = fakeTransport("shared");
		const r1 = await createAfter(pool, shared, 0, "t0");
		const r2 = await createAfter(pool, shared, 0, "t0");
		assert.equal(r1, r2);

		// R1's call failed: the server's catch block removes the process.
		await pool.remove(USER, ORG, CONFIG, r1);
		assert.equal(pool.get(USER, ORG, CONFIG), null);
		await pool.release(r1);
		// R2's call still completes on it.
		assert.equal(shared.closed, false);
		assert.deepEqual(await r2.request("tools/call", {}), {
			from: "shared",
		});
		await pool.release(r2);
		assert.equal(shared.closed, true);
	});

	it("closes an LRU-evicted process only after the request using it finishes", async () => {
		const pool = newPool({ maxProcesses: 1 });
		const busy = fakeTransport("busy");
		const held = await createAfter(
			pool,
			busy,
			0,
			"t0",
			"example-other-config",
		);
		await sleep(2);
		const next = await createAfter(pool, fakeTransport("next"), 0, "t1");

		assert.equal(pool.getStats().size, 1);
		assert.equal(pool.get(USER, ORG, CONFIG), next);
		assert.equal(busy.closed, false);
		await pool.release(held);
		assert.equal(busy.closed, true);
	});
});

describe("ProcessPool background closes", () => {
	it("does not make a request with new credentials, or one joining its creation, wait for the old process to close", async () => {
		const pool = newPool();
		const old = fakeTransport("old", 300);
		await pooledIdle(pool, old, "t0");
		const replacement = fakeTransport("replacement");

		const started = Date.now();
		const [a, b] = await Promise.all([
			createAfter(pool, replacement, 0, "t1"),
			createAfter(pool, fakeTransport("unused"), 0, "t1"),
		]);
		const waitedMs = Date.now() - started;

		assert.equal(a, replacement);
		assert.equal(b, replacement);
		assert.ok(waitedMs < 150, `waited ${waitedMs}ms for the old close`);
		assert.equal(old.closed, false);
		// The close still finishes, and shutdown waits for it.
		await pool.closesSettled();
		assert.equal(old.closed, true);
	});

	it("waits for a background close on shutdown", async () => {
		const pool = new ProcessPool({ cleanupIntervalMs: 60_000 });
		const old = fakeTransport("old", 100);
		await pooledIdle(pool, old, "t0");
		const leased = await createAfter(pool, fakeTransport("next"), 0, "t1");
		await pool.release(leased);
		assert.equal(old.closed, false);

		await pool.shutdown();

		assert.equal(old.closed, true);
	});

	it("gives a request after the new process died a fresh process, not the dead one, while the old process is still closing", async () => {
		const pool = newPool();
		const old = fakeTransport("old", 300);
		await pooledIdle(pool, old, "t0");
		const replacement = fakeTransport("replacement");

		const creator = createAfter(pool, replacement, 0, "t1");
		await sleep(30); // pooled; the old process is still closing
		// The new child exits: the transport reports it dead.
		(replacement as unknown as { isAlive(): boolean }).isAlive = () =>
			false;

		const fresh = fakeTransport("fresh");
		const next = await createAfter(pool, fresh, 0, "t1");

		assert.equal(next, fresh);
		assert.equal(pool.get(USER, ORG, CONFIG), fresh);
		await pool.release(next);
		await pool.release(await creator);
	});
});
