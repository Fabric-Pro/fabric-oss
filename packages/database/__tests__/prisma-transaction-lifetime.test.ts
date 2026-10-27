import { waitUntil } from "@vercel/functions";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { withTransactionLifetime } from "../prisma/transaction-lifetime";

vi.mock("@vercel/functions", () => ({ waitUntil: vi.fn() }));

function deferred() {
	let resolve!: () => void;
	let reject!: (error: Error) => void;
	const promise = new Promise<void>((res, rej) => {
		resolve = res;
		reject = rej;
	});
	return { promise, resolve, reject };
}

function fixture() {
	const completion = deferred();
	const result = { columnNames: [], columnTypes: [], rows: [] };
	const transaction = {
		provider: "postgres" as const,
		adapterName: "fake",
		options: { usePhantomQuery: false },
		async queryRaw() {
			expect(this).toBe(transaction);
			return result;
		},
		async executeRaw(_query?: { sql: string }) {
			expect(this).toBe(transaction);
			return 7;
		},
		async commit() {
			expect(this).toBe(transaction);
			await completion.promise;
		},
		async rollback() {
			expect(this).toBe(transaction);
			await completion.promise;
		},
	};
	const adapter = {
		provider: "postgres" as const,
		adapterName: "fake",
		async startTransaction(isolation?: string) {
			expect(this).toBe(adapter);
			expect(isolation).toBe("Serializable");
			return transaction;
		},
		async queryRaw() {
			expect(this).toBe(adapter);
			return result;
		},
		async executeRaw() {
			expect(this).toBe(adapter);
			return 3;
		},
		async executeScript(script: string) {
			expect(this).toBe(adapter);
			expect(script).toBe("SELECT 1");
		},
		getConnectionInfo() {
			expect(this).toBe(adapter);
			return { schemaName: "public", supportsRelationJoins: true };
		},
		async dispose() {
			expect(this).toBe(adapter);
		},
	};
	const factory = {
		provider: "postgres" as const,
		adapterName: "fake",
		async connect() {
			expect(this).toBe(factory);
			return adapter;
		},
		extra() {
			expect(this).toBe(factory);
			return 42;
		},
	};
	return { factory, adapter, transaction, completion, result };
}

function registered(index = 0) {
	return vi.mocked(waitUntil).mock.calls[index][0];
}

async function expectPending(promise: Promise<unknown>) {
	const settled = vi.fn();
	void promise.then(settled, settled);
	await Promise.resolve();
	expect(settled).not.toHaveBeenCalled();
}

describe("Prisma transaction request lifetime", () => {
	beforeEach(() => {
		vi.clearAllMocks();
		vi.useFakeTimers();
	});
	afterEach(() => vi.useRealTimers());

	it("continues starting and committing when waitUntil throws", async () => {
		const { factory, completion } = fixture();
		vi.mocked(waitUntil).mockImplementationOnce(() => {
			throw new Error("invocation finished");
		});
		const adapter = await withTransactionLifetime(factory).connect();
		const tx = await adapter.startTransaction("Serializable");
		await expect(registered()).resolves.toBeUndefined();
		expect(vi.getTimerCount()).toBe(0);
		completion.resolve();
		await expect(tx.commit()).resolves.toBeUndefined();
	});

	it.each(["  cOmMiT  ", "\nrollback\t"])(
		"settles once the connection is released after closing SQL %j rejects",
		async (sql) => {
			const { factory, transaction, completion } = fixture();
			const error = new Error("closing SQL failed");
			vi.spyOn(transaction, "executeRaw").mockRejectedValue(error);
			const adapter = await withTransactionLifetime(factory).connect();
			const tx = await adapter.startTransaction("Serializable");
			const closing = tx.executeRaw({ sql });
			void closing.catch(() => {});
			await vi.advanceTimersByTimeAsync(0);
			await expectPending(registered());
			await expectPending(closing);
			completion.resolve();
			await expect(closing).rejects.toBe(error);
			const settled = vi.fn();
			void registered().then(settled);
			await Promise.resolve();
			expect(settled).toHaveBeenCalledOnce();
			expect(vi.getTimerCount()).toBe(0);
		},
	);

	it.each(["COMMIT", "ROLLBACK"])(
		"resets the session, then releases the connection exactly once, when closing SQL %j rejects",
		async (sql) => {
			const { factory, transaction } = fixture();
			const error = new Error("canceling statement due to user request");
			const executeRaw = vi
				.spyOn(transaction, "executeRaw")
				.mockRejectedValueOnce(error);
			const commit = vi.spyOn(transaction, "commit").mockResolvedValue();
			const rollback = vi
				.spyOn(transaction, "rollback")
				.mockResolvedValue();
			const adapter = await withTransactionLifetime(factory).connect();
			const tx = await adapter.startTransaction("Serializable");
			await expect(tx.executeRaw({ sql })).rejects.toBe(error);
			expect(executeRaw.mock.calls.map(([query]) => query?.sql)).toEqual([
				sql,
				"ROLLBACK",
			]);
			expect(rollback).toHaveBeenCalledOnce();
			expect(executeRaw.mock.invocationCallOrder[1]).toBeLessThan(
				rollback.mock.invocationCallOrder[0],
			);
			expect(commit).not.toHaveBeenCalled();
			// Prisma 7 calls rollback() itself after a failed COMMIT; pg-pool
			// throws if a client is released twice.
			await tx.rollback();
			await tx.commit();
			expect(rollback).toHaveBeenCalledOnce();
			expect(commit).not.toHaveBeenCalled();
		},
	);

	it("waits for the session reset to finish before releasing the connection", async () => {
		const { factory, transaction } = fixture();
		const error = new Error("canceling statement due to user request");
		const reset = deferred();
		vi.spyOn(transaction, "executeRaw")
			.mockRejectedValueOnce(error)
			.mockImplementationOnce(async () => {
				await reset.promise;
				return 0;
			});
		const rollback = vi.spyOn(transaction, "rollback").mockResolvedValue();
		const adapter = await withTransactionLifetime(factory).connect();
		const tx = await adapter.startTransaction("Serializable");
		const closing = tx.executeRaw({ sql: "COMMIT" });
		void closing.catch(() => {});
		await vi.advanceTimersByTimeAsync(0);
		expect(rollback).not.toHaveBeenCalled();
		reset.resolve();
		await expect(closing).rejects.toBe(error);
		expect(rollback).toHaveBeenCalledOnce();
	});

	it("still releases the connection when resetting the session fails", async () => {
		const { factory, transaction } = fixture();
		const error = new Error("connection terminated");
		vi.spyOn(transaction, "executeRaw").mockRejectedValue(error);
		const rollback = vi.spyOn(transaction, "rollback").mockResolvedValue();
		const adapter = await withTransactionLifetime(factory).connect();
		const tx = await adapter.startTransaction("Serializable");
		await expect(tx.executeRaw({ sql: "COMMIT" })).rejects.toBe(error);
		expect(rollback).toHaveBeenCalledOnce();
		await expect(registered()).resolves.toBeUndefined();
	});

	it("keeps the closing SQL error when releasing the connection also fails", async () => {
		const { factory, transaction } = fixture();
		const error = new Error("connection terminated");
		vi.spyOn(transaction, "executeRaw").mockRejectedValue(error);
		vi.spyOn(transaction, "rollback").mockRejectedValue(
			new Error("release failed"),
		);
		const adapter = await withTransactionLifetime(factory).connect();
		const tx = await adapter.startTransaction("Serializable");
		await expect(tx.executeRaw({ sql: "COMMIT" })).rejects.toBe(error);
		await expect(registered()).resolves.toBeUndefined();
	});

	it("keeps successful closing SQL pending until the adapter commit settles", async () => {
		const { factory, completion } = fixture();
		const adapter = await withTransactionLifetime(factory).connect();
		const tx = await adapter.startTransaction("Serializable");
		expect(await tx.executeRaw({ sql: "COMMIT" })).toBe(7);
		await expectPending(registered());
		const closing = tx.commit();
		await expectPending(registered());
		completion.resolve();
		await closing;
		await expect(registered()).resolves.toBeUndefined();
	});

	it.each([
		"UPDATE example SET value = 1",
		"COMMIT;",
		"ROLLBACK TO SAVEPOINT example",
	])("keeps rejected non-closing SQL %j pending", async (sql) => {
		const { factory, transaction, completion } = fixture();
		const error = new Error("statement failed");
		vi.spyOn(transaction, "executeRaw").mockRejectedValue(error);
		const rollback = vi.spyOn(transaction, "rollback");
		const adapter = await withTransactionLifetime(factory).connect();
		const tx = await adapter.startTransaction("Serializable");
		await expect(tx.executeRaw({ sql })).rejects.toBe(error);
		await expectPending(registered());
		expect(rollback).not.toHaveBeenCalled();
		completion.resolve();
		await tx.rollback();
		await expect(registered()).resolves.toBeUndefined();
	});

	it.each(["commit", "rollback"] as const)(
		"keeps one promise pending through %s until it settles",
		async (method) => {
			const { factory, completion } = fixture();
			const adapter = await withTransactionLifetime(factory).connect();
			const tx = await adapter.startTransaction("Serializable");
			expect(waitUntil).toHaveBeenCalledTimes(1);
			await expectPending(registered());
			const closing = tx[method]();
			await expectPending(registered());
			completion.resolve();
			await closing;
			await expect(registered()).resolves.toBeUndefined();
			expect(vi.getTimerCount()).toBe(0);
			await tx.commit();
			await tx.rollback();
			expect(waitUntil).toHaveBeenCalledTimes(1);
		},
	);

	it.each(["commit", "rollback"] as const)(
		"resolves the lifetime when %s throws and preserves the error",
		async (method) => {
			const { factory, completion } = fixture();
			const adapter = await withTransactionLifetime(factory).connect();
			const tx = await adapter.startTransaction("Serializable");
			const error = new Error("close failed");
			const closing = tx[method]();
			completion.reject(error);
			await expect(closing).rejects.toBe(error);
			await expect(registered()).resolves.toBeUndefined();
			expect(vi.getTimerCount()).toBe(0);
		},
	);

	it("leaves nothing pending when starting rejects", async () => {
		const { factory, adapter } = fixture();
		const error = new Error("start failed");
		vi.spyOn(adapter, "startTransaction").mockRejectedValue(error);
		const wrapped = await withTransactionLifetime(factory).connect();
		await expect(wrapped.startTransaction("Serializable")).rejects.toBe(
			error,
		);
		for (const [promise] of vi.mocked(waitUntil).mock.calls) {
			await expect(promise).resolves.toBeUndefined();
		}
		expect(vi.getTimerCount()).toBe(0);
	});

	it("registers before startup finishes and uses an unref'd fallback", async () => {
		const { factory, adapter, transaction, completion } = fixture();
		const startup = deferred();
		vi.spyOn(adapter, "startTransaction").mockImplementation(async () => {
			await startup.promise;
			return transaction;
		});
		const timeout = vi.spyOn(globalThis, "setTimeout");
		const wrapped = await withTransactionLifetime(factory).connect();
		const starting = wrapped.startTransaction("Serializable");
		expect(waitUntil).toHaveBeenCalledTimes(1);
		await expectPending(registered());
		expect(timeout.mock.results[0].value.hasRef()).toBe(false);
		startup.resolve();
		const tx = await starting;
		await expectPending(registered());
		completion.resolve();
		await tx.commit();
		await expect(registered()).resolves.toBeUndefined();
		timeout.mockRestore();
	});

	it("tracks concurrent transactions independently", async () => {
		const first = fixture();
		const second = fixture();
		vi.spyOn(first.adapter, "startTransaction")
			.mockResolvedValueOnce(first.transaction)
			.mockResolvedValueOnce(second.transaction);
		const adapter = await withTransactionLifetime(first.factory).connect();
		const a = await adapter.startTransaction("Serializable");
		const b = await adapter.startTransaction("Serializable");
		expect(waitUntil).toHaveBeenCalledTimes(2);
		expect(registered(0)).not.toBe(registered(1));
		first.completion.resolve();
		await a.commit();
		await expect(registered(0)).resolves.toBeUndefined();
		await expectPending(registered(1));
		second.completion.resolve();
		await b.rollback();
		await expect(registered(1)).resolves.toBeUndefined();
	});

	it("bounds the keepalive if Prisma skips closing the adapter transaction", async () => {
		const { factory } = fixture();
		const adapter = await withTransactionLifetime(factory).connect();
		await adapter.startTransaction("Serializable");
		await expectPending(registered());
		await vi.advanceTimersByTimeAsync(300_000);
		await expect(registered()).resolves.toBeUndefined();
		expect(vi.getTimerCount()).toBe(0);
	});

	it("preserves factory, adapter and transaction members and their receivers", async () => {
		const { factory, transaction, completion, result } = fixture();
		const wrapped = withTransactionLifetime(factory);
		expect(wrapped.provider).toBe("postgres");
		expect(wrapped.adapterName).toBe("fake");
		expect(wrapped.extra()).toBe(42);
		const adapter = await wrapped.connect();
		expect(adapter.provider).toBe("postgres");
		expect(adapter.adapterName).toBe("fake");
		const query = adapter.queryRaw;
		expect(await query()).toBe(result);
		expect(await adapter.executeRaw()).toBe(3);
		await adapter.executeScript("SELECT 1");
		expect(adapter.getConnectionInfo()).toEqual({
			schemaName: "public",
			supportsRelationJoins: true,
		});
		const tx = await adapter.startTransaction("Serializable");
		expect(tx.provider).toBe("postgres");
		expect(tx.adapterName).toBe("fake");
		expect(tx.options).toBe(transaction.options);
		expect(await tx.queryRaw()).toBe(result);
		expect(await tx.executeRaw()).toBe(7);
		completion.resolve();
		const commit = tx.commit;
		await commit();
		const dispose = adapter.dispose;
		await dispose();
	});
});
