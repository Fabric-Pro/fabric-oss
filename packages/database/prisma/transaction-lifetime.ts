import type { SqlDriverAdapterFactory } from "@prisma/client/runtime/client";
import { waitUntil } from "@vercel/functions";

type SqlDriverAdapter = Awaited<ReturnType<SqlDriverAdapterFactory["connect"]>>;
type Transaction = Awaited<ReturnType<SqlDriverAdapter["startTransaction"]>>;

function delegate<T extends object>(target: T, overrides: Partial<T>): T {
	return new Proxy(target, {
		get(target, property) {
			if (Object.hasOwn(overrides, property)) {
				return Reflect.get(overrides, property);
			}
			const value = Reflect.get(target, property, target);
			return typeof value === "function" ? value.bind(target) : value;
		},
	});
}

async function startTransaction(
	adapter: SqlDriverAdapter,
	...args: Parameters<SqlDriverAdapter["startTransaction"]>
): Promise<Transaction> {
	let resolve!: () => void;
	const lifetime = new Promise<void>((done) => {
		resolve = done;
	});
	let settled = false;
	const settle = () => {
		if (settled) {
			return;
		}
		settled = true;
		clearTimeout(timer);
		resolve();
	};
	const timer = setTimeout(settle, 5 * 60_000);
	timer.unref();
	try {
		waitUntil(lifetime);
	} catch {
		settle();
	}
	try {
		const transaction = await adapter.startTransaction(...args);
		// The adapter's commit and rollback only release the pg client, and
		// pg-pool throws if a client is released twice.
		let finished = false;
		const finish = async (method: "commit" | "rollback") => {
			if (finished) {
				return;
			}
			finished = true;
			try {
				return await transaction[method]();
			} finally {
				settle();
			}
		};
		return delegate(transaction, {
			commit: () => finish("commit"),
			rollback: () => finish("rollback"),
			executeRaw: async (query) => {
				try {
					return await transaction.executeRaw(query);
				} catch (error) {
					if (/^(COMMIT|ROLLBACK)$/i.test(query.sql.trim())) {
						// A closing statement cancelled before it ran leaves the
						// session in an aborted transaction; reset it before the
						// connection is reused. If this also fails the socket is
						// usually gone, and pg-pool discards unqueryable clients.
						await transaction
							.executeRaw({
								sql: "ROLLBACK",
								args: [],
								argTypes: [],
							})
							.catch(() => {});
						await finish("rollback").catch(() => {});
					}
					throw error;
				}
			},
		});
	} catch (error) {
		settle();
		throw error;
	}
}

/**
 * Vercel can freeze a function after its response, between Prisma's implicit
 * BEGIN and COMMIT for an ORM write. Keep the request alive through adapter
 * transaction completion, including interactive transactions (Fizzy #3263/#3299).
 *
 * A failed closing SQL statement also releases the keepalive and the pg
 * connection. Prisma 6.19 skipped the adapter closing method in that case,
 * leaving the connection out of the pool after a failed COMMIT. The wrapper
 * runs ROLLBACK first so an aborted session is not handed to the next caller
 * (Fizzy #3304). Prisma 6.19 also left late-starting transactions unclosed
 * when disconnect raced startup. The five-minute keepalive fallback is retained
 * without re-checking that race on Prisma 7.10.1. It also bounds the keepalive
 * when tracing/query-event hooks throw
 * between closing SQL and adapter cleanup. It does not close the DB session.
 */
export function withTransactionLifetime<T extends SqlDriverAdapterFactory>(
	factory: T,
): T {
	return new Proxy(factory, {
		get(target, property) {
			if (property === "connect") {
				return async () => {
					const adapter = await target.connect();
					return delegate(adapter, {
						startTransaction: (...args) =>
							startTransaction(adapter, ...args),
					});
				};
			}
			const value = Reflect.get(target, property, target);
			return typeof value === "function" ? value.bind(target) : value;
		},
	});
}
