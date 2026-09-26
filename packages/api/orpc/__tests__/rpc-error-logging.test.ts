/**
 * Proves the interceptor hook choice, end to end, through the REAL
 * `@orpc/server` `RPCHandler` — not a re-implementation of its internals.
 *
 * Two things under test: that `interceptors` (not `clientInterceptors`) sees
 * an input-decode failure (malformed body → BAD_REQUEST, thrown before any
 * procedure runs), and that classification is read from the FINAL response
 * status via `rootInterceptors`, not guessed from the raw thrown error's
 * type — a procedure that itself raises a raw `SyntaxError` must log as a
 * 500, the same as any other procedure bug, not as a 400. A throwaway router
 * keeps this fast and decoupled from the production one.
 *
 * Run with:
 *   pnpm --filter @repo/api test orpc/__tests__/rpc-error-logging.test.ts
 */

import { ORPCError, os } from "@orpc/server";
import { RPCHandler } from "@orpc/server/fetch";
import { logger } from "@repo/logs";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { z } from "zod";
import {
	createRpcErrorCaptureInterceptor,
	createRpcErrorLoggingInterceptor,
} from "../rpc-error-logging";

// Reporter/log-entry types derived from `@repo/logs`'s own `logger` rather
// than importing `consola` directly — this package does not depend on it,
// and importing it here would be a phantom dependency.
type Reporter = Parameters<typeof logger.addReporter>[0];
type LogEntry = Parameters<Reporter["log"]>[0];

// consola can default to a level below warn/error in this test environment
// (see packages/logs/__tests__/correlation-binding.test.ts for the same
// note) — raised for the duration of this file so every call reaches the
// reporter this suite attaches below.
const originalLevel = logger.level;
beforeAll(() => {
	logger.level = 5;
});
afterAll(() => {
	logger.level = originalLevel;
});

const testRouter = {
	ping: os
		.input(z.object({ name: z.string() }))
		.handler(({ input }) => ({ ok: true, name: input.name })),
	boom: os.handler(() => {
		throw new Error("unexpected failure");
	}),
	forbidden: os.handler(() => {
		throw new ORPCError("FORBIDDEN", { message: "not a member" });
	}),
	// A procedure raising a raw SyntaxError itself (e.g. JSON.parse on stored
	// data) — `createProcedureClient` rethrows a non-ORPCError unchanged
	// (node_modules/@orpc/server/dist/shared/server.DEBcqOjg.mjs:104-109,
	// 147-148), so this is indistinguishable BY TYPE from a decode failure;
	// only the final status (500, since it is not the `decode_input` step)
	// tells the two apart.
	parsesStoredJson: os.handler(() => {
		JSON.parse("{not valid json");
		return { ok: true };
	}),
};

function makeHandler() {
	return new RPCHandler(testRouter, {
		interceptors: [createRpcErrorCaptureInterceptor()],
		rootInterceptors: [createRpcErrorLoggingInterceptor()],
	});
}

/** Runs `fn` with a reporter attached, capturing every entry it sees, and
 *  removes the reporter afterward regardless of outcome. */
async function withCapturedLogs(
	fn: (entries: LogEntry[]) => Promise<void>,
): Promise<void> {
	const entries: LogEntry[] = [];
	const reporter: Reporter = {
		log: (entry) => entries.push(entry),
	};
	logger.addReporter(reporter);
	try {
		await fn(entries);
	} finally {
		logger.removeReporter(reporter);
	}
}

function fieldsOf(entry: LogEntry | undefined): Record<string, unknown> {
	const meta = entry?.args.find(
		(a) =>
			a &&
			typeof a === "object" &&
			!Array.isArray(a) &&
			!(a instanceof Error),
	);
	return (meta as Record<string, unknown>) ?? {};
}

function errorOf(entry: LogEntry | undefined): Error | undefined {
	return entry?.args.find((a) => a instanceof Error) as Error | undefined;
}

/** JSON body encoding a valid RPC input, matching StandardRPCSerializer's
 *  `{ json, meta }` envelope for a plain object with no special types. */
function rpcBody(input: unknown): string {
	return JSON.stringify({ json: input });
}

describe("createRpcErrorCaptureInterceptor + createRpcErrorLoggingInterceptor", () => {
	it("logs exactly one warn line for a malformed request body (input-decode failure)", async () => {
		await withCapturedLogs(async (entries) => {
			const handler = makeHandler();
			const request = new Request("http://localhost/ping", {
				method: "POST",
				headers: { "content-type": "application/json" },
				// Invalid JSON — fails inside `toStandardBody`'s `JSON.parse`,
				// before the router ever touches an input schema.
				body: "{not valid json",
			});

			const { matched, response } = await handler.handle(request, {
				context: {},
			});

			expect(matched).toBe(true);
			expect(response?.status).toBe(400);
			const warns = entries.filter((e) => e.type === "warn");
			const errors = entries.filter((e) => e.type === "error");
			expect(warns).toHaveLength(1);
			expect(errors).toHaveLength(0);
			expect(fieldsOf(warns[0])).toMatchObject({
				event: "rpc.error",
				procedure: "ping",
				code: "BAD_REQUEST",
				status: 400,
			});
		});
	});

	it("logs exactly one error line, with the Error attached, for a 5xx procedure failure", async () => {
		await withCapturedLogs(async (entries) => {
			const handler = makeHandler();
			const request = new Request("http://localhost/boom", {
				method: "POST",
				headers: { "content-type": "application/json" },
				body: rpcBody(undefined),
			});

			const { matched, response } = await handler.handle(request, {
				context: {},
			});

			expect(matched).toBe(true);
			expect(response?.status).toBe(500);
			const warns = entries.filter((e) => e.type === "warn");
			const errors = entries.filter((e) => e.type === "error");
			expect(errors).toHaveLength(1);
			expect(warns).toHaveLength(0);
			expect(fieldsOf(errors[0])).toMatchObject({
				event: "rpc.error",
				procedure: "boom",
				code: "INTERNAL_SERVER_ERROR",
				status: 500,
			});
			const loggedError = errorOf(errors[0]);
			expect(loggedError).toBeInstanceOf(Error);
			expect(loggedError?.message).toBe("unexpected failure");
		});
	});

	it("logs a procedure's own raw SyntaxError as a 500 error, not a 400 warn", async () => {
		// The regression this suite exists to catch: classifying by the
		// thrown error's TYPE (SyntaxError → BAD_REQUEST) instead of the
		// final status would misfile this as a warn/400 — it is a genuine
		// procedure bug and must reach error-level alerting as a 500.
		await withCapturedLogs(async (entries) => {
			const handler = makeHandler();
			const request = new Request("http://localhost/parsesStoredJson", {
				method: "POST",
				headers: { "content-type": "application/json" },
				body: rpcBody(undefined),
			});

			const { matched, response } = await handler.handle(request, {
				context: {},
			});

			expect(matched).toBe(true);
			expect(response?.status).toBe(500);
			const warns = entries.filter((e) => e.type === "warn");
			const errors = entries.filter((e) => e.type === "error");
			expect(errors).toHaveLength(1);
			expect(warns).toHaveLength(0);
			expect(fieldsOf(errors[0])).toMatchObject({
				event: "rpc.error",
				procedure: "parsesStoredJson",
				code: "INTERNAL_SERVER_ERROR",
				status: 500,
			});
			expect(errorOf(errors[0])).toBeInstanceOf(SyntaxError);
		});
	});

	it("logs a defined ORPCError (FORBIDDEN) as a warn, not an error", async () => {
		await withCapturedLogs(async (entries) => {
			const handler = makeHandler();
			const request = new Request("http://localhost/forbidden", {
				method: "POST",
				headers: { "content-type": "application/json" },
				body: rpcBody(undefined),
			});

			const { response } = await handler.handle(request, {
				context: {},
			});

			expect(response?.status).toBe(403);
			const warns = entries.filter((e) => e.type === "warn");
			const errors = entries.filter((e) => e.type === "error");
			expect(warns).toHaveLength(1);
			expect(errors).toHaveLength(0);
			expect(fieldsOf(warns[0])).toMatchObject({
				event: "rpc.error",
				procedure: "forbidden",
				code: "FORBIDDEN",
				status: 403,
			});
		});
	});

	it("truncates the logged message to 300 characters", async () => {
		await withCapturedLogs(async (entries) => {
			const longMessageRouter = {
				tooLong: os.handler(() => {
					throw new ORPCError("BAD_REQUEST", {
						message: "x".repeat(500),
					});
				}),
			};
			const handler = new RPCHandler(longMessageRouter, {
				interceptors: [createRpcErrorCaptureInterceptor()],
				rootInterceptors: [createRpcErrorLoggingInterceptor()],
			});

			await handler.handle(
				new Request("http://localhost/tooLong", {
					method: "POST",
					headers: { "content-type": "application/json" },
					body: rpcBody(undefined),
				}),
				{ context: {} },
			);

			const warns = entries.filter((e) => e.type === "warn");
			const message = fieldsOf(warns[0]).message as string;
			expect(message.length).toBeLessThanOrEqual(300);
		});
	});

	it("does not log a successful call", async () => {
		await withCapturedLogs(async (entries) => {
			const handler = makeHandler();
			const request = new Request("http://localhost/ping", {
				method: "POST",
				headers: { "content-type": "application/json" },
				body: rpcBody({ name: "ok" }),
			});

			const { matched, response } = await handler.handle(request, {
				context: {},
			});

			expect(matched).toBe(true);
			expect(response?.status).toBe(200);
			expect(
				entries.filter((e) => e.type === "warn" || e.type === "error"),
			).toHaveLength(0);
		});
	});

	it("computes the procedure path from the URL, correctly stripping a prefix", async () => {
		await withCapturedLogs(async (entries) => {
			const handler = makeHandler();
			const request = new Request("http://localhost/api/rpc/forbidden", {
				method: "POST",
				headers: { "content-type": "application/json" },
				body: rpcBody(undefined),
			});

			await handler.handle(request, {
				prefix: "/api/rpc",
				context: {},
			});

			const warns = entries.filter((e) => e.type === "warn");
			expect(fieldsOf(warns[0])).toMatchObject({
				procedure: "forbidden",
			});
		});
	});
});
