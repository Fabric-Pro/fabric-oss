/**
 * Global RPC request limiter — behaviour and wiring.
 *
 * Behaviour is driven through a real oRPC procedure built on `os` with the
 * middleware mounted, so what is asserted is what a caller sees: the call
 * proceeds, or it fails with the codebase's standard 429 shape and a
 * `Retry-After` header on the response-headers bag the handler plugin
 * supplies. `checkRateLimit` is mocked at the module boundary; its own
 * Redis / in-memory / fail-closed semantics are covered in
 * `lib/__tests__/rate-limit-fail-closed.test.ts` and are not re-tested here.
 *
 * Wiring is a source-level check on `procedures.ts` and `handler.ts`, in the
 * style of `touch-last-seen-wiring.test.ts`: a behavioural test cannot notice
 * the `.use()` being deleted, moved above the session middleware (where
 * `context.user` does not exist yet, so every authenticated call would be
 * charged to the IP bucket), or the `ResponseHeadersPlugin` being dropped
 * (which would silently lose the `Retry-After` header).
 *
 * Run with:
 *   pnpm --filter @repo/api test orpc/middleware/__tests__/rpc-rate-limit-middleware.test.ts
 */

import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { call, ORPCError, os } from "@orpc/server";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
	checkRateLimit: vi.fn(),
	getTrustedClientIp: vi.fn(),
	warn: vi.fn(),
}));

vi.mock("../../../lib/rate-limit", () => ({
	checkRateLimit: (...args: unknown[]) => mocks.checkRateLimit(...args),
}));

vi.mock("@repo/auth/lib/client-ip", () => ({
	getTrustedClientIp: (...args: unknown[]) =>
		mocks.getTrustedClientIp(...args),
}));

vi.mock("@repo/logs", () => ({
	logger: {
		info: vi.fn(),
		warn: (...args: unknown[]) => mocks.warn(...args),
		error: vi.fn(),
	},
}));

import {
	RPC_RATE_LIMIT_DEFAULT_PER_MINUTE,
	RPC_RATE_LIMIT_ENV,
	RPC_RATE_LIMIT_WINDOW_MS,
	type RpcRateLimitContext,
	resolveRpcRateLimitPerMinute,
	rpcRateLimitKey,
	rpcRateLimitMiddleware,
} from "../rpc-rate-limit-middleware";

const procedure = os
	.$context<RpcRateLimitContext>()
	.use(rpcRateLimitMiddleware)
	.handler(() => "ok");

const PATH = ["projects", "list"] as const;

function invoke(context: RpcRateLimitContext) {
	// `call` does not know the router path, so pass it the way the handler
	// would: through the procedure's own `path` option.
	return call(procedure, undefined, {
		context,
		path: [...PATH],
	});
}

function authedContext(overrides: Partial<RpcRateLimitContext> = {}) {
	return {
		headers: new Headers(),
		resHeaders: new Headers(),
		user: { id: "user-42" },
		...overrides,
	} satisfies RpcRateLimitContext;
}

beforeEach(() => {
	mocks.checkRateLimit.mockReset();
	mocks.getTrustedClientIp.mockReset();
	mocks.warn.mockReset();
	mocks.getTrustedClientIp.mockReturnValue("203.0.113.42");
	mocks.checkRateLimit.mockResolvedValue({
		allowed: true,
		remaining: 999,
		resetInSeconds: 60,
	});
	vi.unstubAllEnvs();
});

afterEach(() => {
	vi.unstubAllEnvs();
});

describe("rpcRateLimitMiddleware — behaviour", () => {
	it("lets an allowed request through and charges the user bucket", async () => {
		await expect(invoke(authedContext())).resolves.toBe("ok");

		expect(mocks.checkRateLimit).toHaveBeenCalledTimes(1);
		expect(mocks.checkRateLimit).toHaveBeenCalledWith(
			"rpc:user:user-42",
			RPC_RATE_LIMIT_DEFAULT_PER_MINUTE,
			RPC_RATE_LIMIT_WINDOW_MS,
		);
		// The IP is only consulted when there is no user to key on.
		expect(mocks.getTrustedClientIp).not.toHaveBeenCalled();
	});

	it("falls back to the trusted client IP when no session has been established", async () => {
		const headers = new Headers({ "x-real-ip": "203.0.113.42" });
		await expect(
			invoke({ headers, resHeaders: new Headers() }),
		).resolves.toBe("ok");

		expect(mocks.getTrustedClientIp).toHaveBeenCalledWith(headers);
		expect(mocks.checkRateLimit).toHaveBeenCalledWith(
			"rpc:ip:203.0.113.42",
			RPC_RATE_LIMIT_DEFAULT_PER_MINUTE,
			RPC_RATE_LIMIT_WINDOW_MS,
		);
	});

	it("rejects with TOO_MANY_REQUESTS, retryAfter data and a Retry-After header when the budget is spent", async () => {
		mocks.checkRateLimit.mockResolvedValue({
			allowed: false,
			remaining: 0,
			resetInSeconds: 37,
		});
		const context = authedContext();

		const error = await invoke(context).catch((e: unknown) => e);

		expect(error).toBeInstanceOf(ORPCError);
		const orpcError = error as ORPCError<string, unknown>;
		expect(orpcError.code).toBe("TOO_MANY_REQUESTS");
		expect(orpcError.status).toBe(429);
		expect(orpcError.message).toMatch(/try again in 37 seconds/i);
		expect(orpcError.data).toEqual({ retryAfter: 37 });
		expect(context.resHeaders?.get("Retry-After")).toBe("37");
	});

	it("logs a warning naming the user and the procedure path when tripped", async () => {
		mocks.checkRateLimit.mockResolvedValue({
			allowed: false,
			remaining: 0,
			resetInSeconds: 12,
		});

		await expect(invoke(authedContext())).rejects.toMatchObject({
			code: "TOO_MANY_REQUESTS",
		});

		expect(mocks.warn).toHaveBeenCalledTimes(1);
		expect(mocks.warn).toHaveBeenCalledWith(
			expect.objectContaining({
				event: "ratelimit.rpc.exceeded",
				userId: "user-42",
				path: "projects.list",
				retryAfter: 12,
			}),
			expect.any(String),
		);
	});

	it("never emits a Retry-After of 0 — a client would retry immediately", async () => {
		mocks.checkRateLimit.mockResolvedValue({
			allowed: false,
			remaining: 0,
			resetInSeconds: 0,
		});
		const context = authedContext();

		await expect(invoke(context)).rejects.toMatchObject({
			data: { retryAfter: 1 },
		});
		expect(context.resHeaders?.get("Retry-After")).toBe("1");
	});

	it("does not touch the rate limiter at all when RPC_RATE_LIMIT_PER_MINUTE is 0", async () => {
		vi.stubEnv(RPC_RATE_LIMIT_ENV, "0");

		await expect(invoke(authedContext())).resolves.toBe("ok");

		expect(mocks.checkRateLimit).not.toHaveBeenCalled();
	});

	it("uses the configured budget when RPC_RATE_LIMIT_PER_MINUTE is set", async () => {
		vi.stubEnv(RPC_RATE_LIMIT_ENV, "250");

		await invoke(authedContext());

		expect(mocks.checkRateLimit).toHaveBeenCalledWith(
			"rpc:user:user-42",
			250,
			RPC_RATE_LIMIT_WINDOW_MS,
		);
	});

	it("surfaces the limiter's fail-closed 503 unchanged, with Retry-After", async () => {
		mocks.checkRateLimit.mockResolvedValue({
			allowed: false,
			remaining: 0,
			resetInSeconds: 60,
			statusCode: 503,
			reason: "ratelimit-unavailable",
		});
		const context = authedContext();

		await expect(invoke(context)).rejects.toMatchObject({
			code: "SERVICE_UNAVAILABLE",
		});
		expect(context.resHeaders?.get("Retry-After")).toBe("60");
		// Not an abuse signal — the limiter itself was unavailable.
		expect(mocks.warn).not.toHaveBeenCalled();
	});

	it("works without a resHeaders bag (in-process callers)", async () => {
		mocks.checkRateLimit.mockResolvedValue({
			allowed: false,
			remaining: 0,
			resetInSeconds: 5,
		});

		await expect(
			invoke({ headers: new Headers(), user: { id: "user-42" } }),
		).rejects.toMatchObject({ code: "TOO_MANY_REQUESTS" });
	});
});

describe("rpcRateLimitKey", () => {
	it("prefers the user id over the IP", () => {
		expect(
			rpcRateLimitKey({ headers: new Headers(), user: { id: "u1" } }),
		).toEqual({ key: "rpc:user:u1", userId: "u1" });
	});

	it("keys by trusted client IP when there is no user", () => {
		mocks.getTrustedClientIp.mockReturnValue("198.51.100.7");
		expect(rpcRateLimitKey({ headers: new Headers() })).toEqual({
			key: "rpc:ip:198.51.100.7",
			ip: "198.51.100.7",
		});
	});
});

describe("resolveRpcRateLimitPerMinute", () => {
	it("defaults to 1000 when unset or blank", () => {
		expect(resolveRpcRateLimitPerMinute(undefined)).toBe(1000);
		expect(resolveRpcRateLimitPerMinute("")).toBe(1000);
		expect(resolveRpcRateLimitPerMinute("   ")).toBe(1000);
	});

	it("returns 0 for '0' (disabled)", () => {
		expect(resolveRpcRateLimitPerMinute("0")).toBe(0);
	});

	it("parses a positive integer", () => {
		expect(resolveRpcRateLimitPerMinute("1500")).toBe(1500);
		expect(resolveRpcRateLimitPerMinute(" 42 ")).toBe(42);
	});

	it("refuses garbage and negatives rather than failing open or closed", () => {
		for (const raw of ["abc", "-5", "1e3", "NaN", "10.5", "Infinity"]) {
			expect(resolveRpcRateLimitPerMinute(raw), raw).toBe(1000);
		}
		expect(mocks.warn).toHaveBeenCalled();
	});
});

describe("wiring", () => {
	const here = dirname(fileURLToPath(import.meta.url));
	const PROCEDURES = readFileSync(
		join(here, "..", "..", "procedures.ts"),
		"utf8",
	);
	const HANDLER = readFileSync(join(here, "..", "..", "handler.ts"), "utf8");

	function sliceBetween(source: string, start: string, end: string) {
		const s = source.indexOf(start);
		expect(s, `expected "${start}"`).toBeGreaterThanOrEqual(0);
		const e = source.indexOf(end, s + start.length);
		expect(e, `expected "${end}" after "${start}"`).toBeGreaterThanOrEqual(
			0,
		);
		return source.slice(s, e);
	}

	it("imports the middleware in procedures.ts", () => {
		expect(PROCEDURES).toMatch(
			/import\s+\{\s*rpcRateLimitMiddleware\s*\}\s+from\s+["']\.\/middleware\/rpc-rate-limit-middleware["']/,
		);
	});

	it("mounts it on publicProcedure (IP-keyed: no user yet)", () => {
		const block = sliceBetween(
			PROCEDURES,
			"export const publicProcedure",
			"export const rateLimitedPublicProcedure",
		);
		expect(block).toMatch(/\.use\(\s*rpcRateLimitMiddleware\s*\)/);
	});

	it("mounts it on protectedProcedure AFTER the session middleware and BEFORE touchLastSeen", () => {
		const block = sliceBetween(
			PROCEDURES,
			"export const protectedProcedure",
			"export const tenantProtectedProcedure",
		);
		const sessionIdx = block.indexOf("session: session.session");
		const limiterIdx = block.indexOf(".use(rpcRateLimitMiddleware)");
		const touchIdx = block.indexOf(".use(touchLastSeenMiddleware)");
		expect(sessionIdx).toBeGreaterThanOrEqual(0);
		expect(limiterIdx).toBeGreaterThan(sessionIdx);
		expect(touchIdx).toBeGreaterThan(limiterIdx);
	});

	it("does not derive protectedProcedure from publicProcedure (that would double-charge every authenticated call)", () => {
		expect(PROCEDURES).toMatch(
			/export const protectedProcedure = rootProcedure\b/,
		);
		expect(PROCEDURES).not.toMatch(
			/export const protectedProcedure = publicProcedure\b/,
		);
	});

	it("mounts exactly one limiter per chain", () => {
		const count = PROCEDURES.match(/\.use\(rpcRateLimitMiddleware\)/g);
		expect(count).toHaveLength(2);
	});

	it("registers ResponseHeadersPlugin on both HTTP handlers so Retry-After reaches the wire", () => {
		expect(HANDLER).toMatch(
			/import\s+\{\s*ResponseHeadersPlugin\s*\}\s+from\s+["']@orpc\/server\/plugins["']/,
		);
		const rpc = sliceBetween(
			HANDLER,
			"export const rpcHandler",
			"export const openApiHandler",
		);
		const openApi = HANDLER.slice(
			HANDLER.indexOf("export const openApiHandler"),
		);
		expect(rpc).toMatch(/new ResponseHeadersPlugin\(\)/);
		expect(openApi).toMatch(/new ResponseHeadersPlugin\(\)/);
	});
});
