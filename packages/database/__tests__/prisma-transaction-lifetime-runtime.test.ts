import type { SqlDriverAdapterFactory } from "@prisma/client/runtime/client";
import { waitUntil } from "@vercel/functions";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { PrismaClient } from "../prisma/generated/client";
import { withTransactionLifetime } from "../prisma/transaction-lifetime";

vi.mock("@vercel/functions", () => ({ waitUntil: vi.fn() }));

type Adapter = Awaited<ReturnType<SqlDriverAdapterFactory["connect"]>>;
type Transaction = Awaited<ReturnType<Adapter["startTransaction"]>>;

function lifetime() {
	expect(waitUntil).toHaveBeenCalledOnce();
	return vi.mocked(waitUntil).mock.calls[0][0];
}

async function expectPending(promise: Promise<unknown>) {
	let settled = false;
	void promise.then(() => {
		settled = true;
	});
	await Promise.resolve();
	expect(settled).toBe(false);
}

function fakeFactory(expectTransaction = true) {
	const events: string[] = [];
	const queryRaw: Adapter["queryRaw"] = async (query) => {
		events.push(query.sql);
		expect(waitUntil).toHaveBeenCalledOnce();
		await expectPending(lifetime());
		return {
			columnNames: ["id"],
			columnTypes: [7],
			rows: [["example-user"]],
		};
	};
	const executeRaw: Adapter["executeRaw"] = async (query) => {
		events.push(query.sql);
		if (expectTransaction && /^UPDATE/.test(query.sql)) {
			expect(waitUntil).toHaveBeenCalledOnce();
			await expectPending(lifetime());
		}
		return 1;
	};
	const adapter: Adapter = {
		provider: "postgres",
		adapterName: "fake",
		queryRaw,
		executeRaw,
		executeScript: async () => {},
		dispose: async () => {},
		getConnectionInfo: () => ({ supportsRelationJoins: true }),
		async startTransaction() {
			events.push("startTransaction");
			const transaction: Transaction = {
				provider: "postgres",
				adapterName: "fake",
				options: { usePhantomQuery: false },
				queryRaw,
				executeRaw,
				async commit() {
					events.push("commit");
					await expectPending(lifetime());
				},
				async rollback() {
					events.push("rollback");
					await expectPending(lifetime());
				},
			};
			await transaction.executeRaw({
				sql: "BEGIN",
				args: [],
				argTypes: [],
			});
			return transaction;
		},
	};
	const factory: SqlDriverAdapterFactory = {
		provider: "postgres",
		adapterName: "fake",
		connect: async () => adapter,
	};
	return { factory, events };
}

function nestedWrite(client: PrismaClient) {
	const now = new Date("2026-01-01T00:00:00.000Z");
	return client.user.create({
		data: {
			id: "example-user",
			email: "dev@example.com",
			emailVerified: false,
			name: "Example",
			createdAt: now,
			updatedAt: now,
			accounts: {
				create: {
					id: "example-account",
					accountId: "example-account",
					providerId: "example",
					createdAt: now,
					updatedAt: now,
				},
			},
		},
		select: { id: true },
	});
}

describe("real Prisma transaction lifetime contract", () => {
	beforeEach(() => vi.clearAllMocks());
	afterEach(() => vi.restoreAllMocks());

	it("wires the wrapped adapter into the exported singleton", async () => {
		const { factory, events } = fakeFactory();
		const previous = globalThis.prisma;
		globalThis.prisma = undefined;
		vi.stubEnv(
			"DATABASE_URL",
			"postgresql://example:example@127.0.0.1:1/example",
		);
		vi.doMock("@prisma/adapter-pg", () => ({
			PrismaPg: class {
				provider = factory.provider;
				adapterName = factory.adapterName;
				connect = factory.connect;
			},
		}));
		let singleton: PrismaClient | undefined;
		try {
			const { db } = await import("../prisma/client");
			singleton = db;
			await expect(nestedWrite(db)).resolves.toEqual({
				id: "example-user",
			});
			expect(waitUntil).toHaveBeenCalledOnce();
			expect(events).toEqual([
				"startTransaction",
				"BEGIN",
				expect.stringMatching(/^INSERT/),
				expect.stringMatching(/^INSERT/),
				expect.stringMatching(/^SELECT/),
				"COMMIT",
				"commit",
			]);
			await expect(lifetime()).resolves.toBeUndefined();
		} finally {
			await singleton?.$disconnect();
			globalThis.prisma = previous;
			vi.doUnmock("@prisma/adapter-pg");
			vi.unstubAllEnvs();
		}
	});

	it("routes an implicit ORM write through adapter startup and commit", async () => {
		const { factory, events } = fakeFactory();
		const client = new PrismaClient({
			adapter: withTransactionLifetime(factory),
		});
		try {
			await expect(nestedWrite(client)).resolves.toEqual({
				id: "example-user",
			});
			expect(waitUntil).toHaveBeenCalledOnce();
			expect(events).toEqual([
				"startTransaction",
				"BEGIN",
				expect.stringMatching(/^INSERT/),
				expect.stringMatching(/^INSERT/),
				expect.stringMatching(/^SELECT/),
				"COMMIT",
				"commit",
			]);
			await expect(lifetime()).resolves.toBeUndefined();
		} finally {
			await client.$disconnect();
		}
	});

	it("allows Prisma 7 to execute a single-statement update without an explicit transaction", async () => {
		const { factory, events } = fakeFactory(false);
		const client = new PrismaClient({
			adapter: withTransactionLifetime(factory),
		});
		try {
			await expect(
				client.auditLog.updateMany({
					where: { id: "example-audit" },
					data: { resourceName: "example" },
				}),
			).resolves.toEqual({ count: 1 });
			expect(events).toEqual([expect.stringMatching(/^UPDATE/)]);
			expect(waitUntil).not.toHaveBeenCalled();
		} finally {
			await client.$disconnect();
		}
	});

	it.each([false, true])(
		"routes interactive transactions through adapter closure (rollback: %s)",
		async (rollback) => {
			const { factory, events } = fakeFactory();
			const client = new PrismaClient({
				adapter: withTransactionLifetime(factory),
			});
			const error = new Error("abort example transaction");
			try {
				const operation = client.$transaction(async (tx) => {
					await tx.auditLog.updateMany({
						where: { id: "example-audit" },
						data: { resourceName: "example" },
					});
					await expectPending(lifetime());
					if (rollback) {
						throw error;
					}
					return "done";
				});
				if (rollback) {
					await expect(operation).rejects.toBe(error);
				} else {
					await expect(operation).resolves.toBe("done");
				}
				expect(waitUntil).toHaveBeenCalledOnce();
				expect(events).toEqual([
					"startTransaction",
					"BEGIN",
					expect.stringMatching(/^UPDATE/),
					rollback ? "ROLLBACK" : "COMMIT",
					rollback ? "rollback" : "commit",
				]);
				await expect(lifetime()).resolves.toBeUndefined();
			} finally {
				await client.$disconnect();
			}
		},
	);
});
