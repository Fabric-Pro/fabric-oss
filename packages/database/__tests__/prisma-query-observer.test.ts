/**
 * The query observer must actually FIRE. That is the whole point of this file.
 *
 * The previous instrumentation was `db.$use(...)` behind a
 * `typeof db.$use === "function"` guard. Prisma 6 removed `$use`, so the guard
 * was always false, the middleware was never installed, and the request-span
 * feature captured zero `db` spans — for months, while the traced-request API
 * kept advertising "low-level spans (db / temporal / http)". Nothing failed;
 * nothing was logged; the feature just quietly did nothing.
 *
 * A unit test asserting "the wiring function was called" would have passed
 * throughout that entire period, because it WAS called — it just did nothing. So
 * these tests assert the observer receives a real operation from a real
 * `$extends` client, which is the only claim that would have caught it.
 */

import { PrismaPg } from "@prisma/adapter-pg";
import { describe, expect, it } from "vitest";
import { setPrismaQueryObserver } from "../prisma/client";
import { PrismaClient } from "../prisma/generated/client";

/**
 * A client built the same way `createRealPrismaClient` builds the exported one,
 * but pointed at an unreachable host: these tests never let a query reach the
 * network, because the observer either short-circuits it or the assertion is
 * about what the observer SAW, not what Postgres returned.
 */
function makeClient() {
	// An adapter is required at construction under `engineType = "client"`, but
	// no connection is opened: every test either short-circuits before calling
	// `query` or asserts on what the observer saw.
	return new PrismaClient({
		adapter: new PrismaPg({
			connectionString: "postgresql://u:p@127.0.0.1:1/db",
		}),
	});
}

/**
 * What the extension hands the observer. Mirrors `PrismaQueryObserver` in
 * `prisma/client.ts` rather than being inferred from a `vi.fn()` — inferring it
 * from a mock types the parameter as `Mock<Procedure>`, which every arrow
 * function below then fails to satisfy.
 */
type TestObserver = (args: {
	model?: string;
	operation: string;
	args: unknown;
	query: (args: unknown) => Promise<unknown>;
}) => Promise<unknown>;

/** Mirrors `withQueryObserver`, which is module-private. */
function extend(client: PrismaClient, observer: TestObserver) {
	return client.$extends({
		query: {
			$allOperations({ model, operation, args, query }) {
				return observer({ model, operation, args, query });
			},
		},
	});
}

describe("the $extends query hook reaches every operation", () => {
	it("sees the model and operation for a model call", async () => {
		const seen: Array<{ model: string | undefined; operation: string }> =
			[];
		const client = extend(makeClient(), async ({ model, operation }) => {
			seen.push({ model, operation });
			// Short-circuit: never touch the network.
			return [];
		});

		await client.auditLog.findMany({ where: { id: "x" } });

		expect(seen).toEqual([{ model: "AuditLog", operation: "findMany" }]);
	});

	it("sees a write operation, which is what makes it usable as a write signal", async () => {
		const seen: string[] = [];
		const client = extend(makeClient(), async ({ operation }) => {
			seen.push(operation);
			return {};
		});

		await client.auditLog.create({
			data: {} as Parameters<
				ReturnType<typeof makeClient>["auditLog"]["create"]
			>[0]["data"],
		});

		expect(seen).toEqual(["create"]);
	});

	it("passes the args through and returns what the observer returns", async () => {
		const client = extend(makeClient(), async ({ args, query }) => {
			expect(args).toEqual({ where: { id: "abc" } });
			// Deliberately do NOT call `query` — proves the hook is in the path
			// rather than merely observing alongside it.
			void query;
			return { id: "substituted" };
		});

		await expect(
			client.auditLog.findFirst({ where: { id: "abc" } }),
		).resolves.toEqual({ id: "substituted" });
	});

	it("surfaces an observer throw to the caller", async () => {
		// The observer sits IN the path, so a bug in it must not be swallowed
		// into a silently-empty result.
		const client = extend(makeClient(), async () => {
			throw new Error("observer exploded");
		});

		await expect(client.auditLog.findMany()).rejects.toThrow(
			"observer exploded",
		);
	});
});

describe("setPrismaQueryObserver", () => {
	it("is exported as a required function, not an optional method", () => {
		// The shape is the fix. `$use` was optional, so `typeof x === "function"`
		// compiled fine and silently skipped. A missing required export is a
		// compile error instead.
		expect(typeof setPrismaQueryObserver).toBe("function");
	});
});

describe("the Prisma client no longer has the API the old code depended on", () => {
	it("does not expose $use", () => {
		// Pins the root cause. If a future Prisma release reinstated `$use`, the
		// comment explaining all of this would become misleading, and this test
		// says so.
		const client = makeClient() as unknown as Record<string, unknown>;
		expect(client.$use).toBeUndefined();
		expect(typeof client.$extends).toBe("function");
	});
});
