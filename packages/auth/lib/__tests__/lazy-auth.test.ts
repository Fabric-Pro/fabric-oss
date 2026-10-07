import { type BetterAuthPlugin, betterAuth } from "better-auth";
import { memoryAdapter } from "better-auth/adapters/memory";
import { toNextJsHandler } from "better-auth/next-js";
import { expect, expectTypeOf, it, vi } from "vitest";
import { createLazyAuth } from "../lazy-auth";

function fixture(plugin: BetterAuthPlugin) {
	const data = { user: [], session: [], account: [], verification: [] };
	const factory = vi.fn(() =>
		betterAuth({
			baseURL: "http://localhost:3000",
			secret: "example-secret-for-lazy-auth-contract-at-least-32-characters",
			database: memoryAdapter(data),
			plugins: [plugin],
		}),
	);
	const auth = createLazyAuth(factory);
	return { auth, factory };
}

it("keeps native API types and methods and initializes once across concurrent requests", async () => {
	const init = vi.fn(async () => {});
	const { auth, factory } = fixture({ id: "example-lazy-init", init });
	expect(factory).not.toHaveBeenCalled();
	// Merely setting up the Next.js request adapter must not initialize auth.
	const next = toNextJsHandler(auth);
	expect(factory).not.toHaveBeenCalled();
	const [session, response] = await Promise.all([
		auth.api.getSession({ headers: new Headers() }),
		next.GET(new Request("http://localhost:3000/api/auth/get-session")),
	]);
	expect(session).toBeNull();
	expect(response.status).toBe(200);
	expect(factory).toHaveBeenCalledTimes(1);
	expect(init).toHaveBeenCalledTimes(1);
	const native = factory.mock.results[0].value;
	expectTypeOf(auth).toEqualTypeOf<ReturnType<typeof factory>>();
	expect(auth.api).toBe(native.api);
	expect(auth.api.getSession).toBe(native.api.getSession);
	expect(auth.api.signUpEmail).toBe(native.api.signUpEmail);
	expect(auth.handler).toBe(native.handler);
	expect(auth.options).toBe(native.options);
	expect(auth.$context).toBe(native.$context);
	expect(auth.$ERROR_CODES).toBe(native.$ERROR_CODES);
	expect("handler" in auth).toBe(true);
	expect(Object.keys(auth)).toEqual(Object.keys(native));
	expect(Object.getOwnPropertyDescriptor(auth, "api")?.value).toBe(
		native.api,
	);
});

it("caches a failed native plugin initialization and rejects API, handler and context use", async () => {
	const failure = new Error("Example plugin initialization failed");
	const init = vi.fn(async () => {
		throw failure;
	});
	const { auth, factory } = fixture({ id: "example-lazy-init", init });
	expect(factory).not.toHaveBeenCalled();
	const calls = await Promise.allSettled([
		auth.api.getSession({ headers: new Headers() }),
		auth.handler(new Request("http://localhost:3000/api/auth/get-session")),
	]);
	expect(calls).toEqual([
		{ status: "rejected", reason: failure },
		{ status: "rejected", reason: failure },
	]);
	await expect(auth.$context).rejects.toBe(failure);
	await expect(auth.api.getSession({ headers: new Headers() })).rejects.toBe(
		failure,
	);
	expect(factory).toHaveBeenCalledTimes(1);
	expect(init).toHaveBeenCalledTimes(1);
});

it("does not retry a synchronous factory failure on later access", () => {
	const failure = new Error("Example auth factory failed");
	const factory = vi.fn(() => {
		throw failure;
	});
	const auth = createLazyAuth<{ handler: () => Promise<Response> }>(factory);
	expect(factory).not.toHaveBeenCalled();
	expect(() => auth.handler).toThrow(failure);
	expect(() => auth.handler).toThrow(failure);
	expect(factory).toHaveBeenCalledTimes(1);
});
