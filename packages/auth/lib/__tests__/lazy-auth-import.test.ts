/** Importing the real auth module must not start the provider's database work. */
import { expect, it, vi } from "vitest";

const observed = vi.hoisted(() => ({
	factory: vi.fn(),
	seedRead: vi.fn(),
	failure: new Error("Example OAuth resource store unavailable"),
}));

vi.mock("better-auth", async (importOriginal) => {
	const actual = await importOriginal<typeof import("better-auth")>();
	return {
		...actual,
		betterAuth: (...args: Parameters<typeof actual.betterAuth>) => {
			observed.factory();
			return actual.betterAuth(...args);
		},
	};
});

vi.mock("@repo/database", async (importOriginal) => {
	const actual = await importOriginal<typeof import("@repo/database")>();
	return {
		...actual,
		db: new Proxy(actual.db, {
			get(target, property, receiver) {
				if (property === "oauthResource") {
					return {
						findFirst: observed.seedRead.mockRejectedValue(
							observed.failure,
						),
					};
				}
				return Reflect.get(target, property, receiver);
			},
		}),
	};
});

it("defers native initialization until auth use and keeps a failed initialization closed", async () => {
	const { auth } = await import("../../auth");
	const factoriesAtImport = observed.factory.mock.calls.length;
	const readsAtImport = observed.seedRead.mock.calls.length;
	// Attach consumers before making the red assertions: a regression must not
	// leave the eagerly started context rejection unhandled in the test runner.
	const calls = await Promise.allSettled([
		auth.api.getSession({ headers: new Headers() }),
		auth.handler(new Request("http://localhost:3000/api/auth/get-session")),
	]);
	expect(factoriesAtImport).toBe(0);
	expect(readsAtImport).toBe(0);
	expect(observed.factory).toHaveBeenCalledTimes(1);
	expect(observed.seedRead).toHaveBeenCalledTimes(1);
	expect(calls).toEqual([
		{ status: "rejected", reason: observed.failure },
		{ status: "rejected", reason: observed.failure },
	]);
	await expect(auth.api.getSession({ headers: new Headers() })).rejects.toBe(
		observed.failure,
	);
	await expect(auth.$context).rejects.toBe(observed.failure);
	expect(observed.factory).toHaveBeenCalledTimes(1);
	expect(observed.seedRead).toHaveBeenCalledTimes(1);
});
