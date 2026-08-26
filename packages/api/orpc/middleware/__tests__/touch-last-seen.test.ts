/**
 * Tests for the last-seen middleware.
 *
 * The contract under test is what keeps a telemetry write off the
 * critical path — the write is scheduled only AFTER `next()` resolves
 * (so it never contends with the handler's own queries, and a request
 * that throws records no activity — Minor 4), the write is scheduled via
 * `runInBackground` (not a bare `void promise`) and never blocks the
 * response on the write settling — and what keeps the write honest: it
 * must never fire for an impersonated session or for a passively-polled
 * procedure path (Important 2), and the middleware must hand back
 * whatever `next()` resolved to.
 */
import { beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
	touchLastSeen: vi.fn(),
	runInBackground: vi.fn(),
}));

vi.mock("@repo/database", async (importOriginal) => {
	const actual = (await importOriginal()) as Record<string, unknown>;
	return { ...actual, touchLastSeen: mocks.touchLastSeen };
});

// Mirrors how subscribe-to-newsletter.test.ts mocks the same helper: the
// path is resolved relative to THIS file, not to touch-last-seen.ts, but
// both resolve to the same module so the mock still intercepts the
// import inside the middleware.
vi.mock("../../../modules/weave/lib/run-in-background", () => ({
	runInBackground: mocks.runInBackground,
}));

import { touchLastSeenMiddleware } from "../touch-last-seen";

type Context = {
	user: { id: string };
	session: { impersonatedBy?: string | null };
};

type MiddlewareFactory = (args: {
	context: Context;
	next: () => Promise<unknown>;
	path: readonly string[];
}) => Promise<unknown>;

/** A procedure path that is not on the passive-poll skip list. */
const NORMAL_PATH = ["projects", "create"] as const;

/** Invoke the middleware the way oRPC would, recording whether the
 *  downstream handler ran and what it returned. Mirrors `runMiddleware`
 *  in require-audit-log-read.test.ts. */
async function runMiddleware(
	context: Context,
	path: readonly string[] = NORMAL_PATH,
): Promise<{
	called: boolean;
	error: unknown;
	result: unknown;
}> {
	let called = false;
	let error: unknown = null;
	let result: unknown;
	try {
		const factory = touchLastSeenMiddleware as unknown as MiddlewareFactory;
		result = await factory({
			context,
			path,
			next: async () => {
				called = true;
				return { fromHandler: true };
			},
		});
	} catch (err) {
		error = err;
	}
	return { called, error, result };
}

const notImpersonated = { impersonatedBy: null };

beforeEach(() => {
	vi.clearAllMocks();
	mocks.touchLastSeen.mockResolvedValue(undefined);
});

describe("touchLastSeenMiddleware", () => {
	it("records the caller's activity, continues the request, and returns next()'s result", async () => {
		const { called, error, result } = await runMiddleware({
			user: { id: "u1" },
			session: notImpersonated,
		});

		expect(mocks.touchLastSeen).toHaveBeenCalledWith("u1");
		expect(called).toBe(true);
		expect(error).toBeNull();
		// M-2: the middleware must hand back next()'s resolved value, not
		// discard it — otherwise every authenticated procedure would
		// silently return null/undefined to the client.
		expect(result).toEqual({ fromHandler: true });
	});

	it("schedules the write via runInBackground instead of a bare void promise", async () => {
		await runMiddleware({ user: { id: "u1" }, session: notImpersonated });

		expect(mocks.runInBackground).toHaveBeenCalledTimes(1);
		// runInBackground must be handed the write's promise, not called
		// with e.g. a thunk — the arg should resolve to whatever
		// touchLastSeen resolves to.
		const scheduled = mocks.runInBackground.mock.calls[0]?.[0];
		expect(scheduled).toBeInstanceOf(Promise);
	});

	it("resolves without waiting for the write promise to settle", async () => {
		// The write never resolves. If the middleware awaited it, this
		// test would hang until vitest's test timeout.
		mocks.touchLastSeen.mockReturnValue(new Promise<void>(() => {}));

		const { called, result } = await runMiddleware({
			user: { id: "u1" },
			session: notImpersonated,
		});

		expect(called).toBe(true);
		expect(result).toEqual({ fromHandler: true });
	});

	// Minor 4: the write must be scheduled AFTER next() resolves, not
	// before — scheduling it first would dispatch the UPDATE onto the
	// shared pg pool before the handler issues a single query of its own,
	// queueing ahead of the request the middleware must not slow down.
	it("schedules the write AFTER next() resolves, not before", async () => {
		const order: string[] = [];
		mocks.touchLastSeen.mockImplementation(async () => {
			order.push("write");
		});

		const factory = touchLastSeenMiddleware as unknown as MiddlewareFactory;
		await factory({
			context: { user: { id: "u1" }, session: notImpersonated },
			path: NORMAL_PATH,
			next: async () => {
				order.push("handler");
				return { fromHandler: true };
			},
		});

		expect(order).toEqual(["handler", "write"]);
	});

	// Minor 4: a consequence of scheduling after next() — a request that
	// throws records no activity. That's fine, and arguably more correct:
	// a failed call isn't evidence of active use either.
	it("does not record activity when next() throws", async () => {
		const factory = touchLastSeenMiddleware as unknown as MiddlewareFactory;

		await expect(
			factory({
				context: { user: { id: "u1" }, session: notImpersonated },
				path: NORMAL_PATH,
				next: async () => {
					throw new Error("handler failed");
				},
			}),
		).rejects.toThrow("handler failed");

		expect(mocks.touchLastSeen).not.toHaveBeenCalled();
		expect(mocks.runInBackground).not.toHaveBeenCalled();
	});

	it("does not fail the request when the write rejects", async () => {
		mocks.touchLastSeen.mockRejectedValue(new Error("connection lost"));

		const { called, error } = await runMiddleware({
			user: { id: "u1" },
			session: notImpersonated,
		});

		expect(called).toBe(true);
		expect(error).toBeNull();
	});

	it("does NOT record activity during an impersonated session", async () => {
		const { called, error } = await runMiddleware({
			user: { id: "u1" },
			session: { impersonatedBy: "admin-1" },
		});

		expect(mocks.touchLastSeen).not.toHaveBeenCalled();
		expect(mocks.runInBackground).not.toHaveBeenCalled();
		// The request must still proceed normally — only the activity
		// write is skipped.
		expect(called).toBe(true);
		expect(error).toBeNull();
	});

	it("records activity for a normal (non-impersonated) session", async () => {
		const { called } = await runMiddleware({
			user: { id: "u2" },
			session: { impersonatedBy: null },
		});

		expect(mocks.touchLastSeen).toHaveBeenCalledWith("u2");
		expect(called).toBe(true);
	});

	// Important 2: passive app-shell polls (NotificationBell, the
	// incident chip, the AI usage limits card) run on a timer on every
	// authenticated page regardless of user interaction. Counting them as
	// "activity" inverts the bug this middleware exists to fix — a user
	// on leave with a tab left open would read as active every day.
	//
	// Paths verified against the real router registration — see
	// PASSIVE_POLL_PATHS in ../touch-last-seen.ts for the exact
	// file/line evidence for each one.
	const passivePollPaths: ReadonlyArray<readonly string[]> = [
		["notifications", "unreadCount"],
		["integrationHealth", "listActiveIncidents"],
		["payments", "aiUsageLimits", "status"],
	];

	for (const path of passivePollPaths) {
		it(`does not record activity for passive poll path "${path.join(".")}"`, async () => {
			const { called, error } = await runMiddleware(
				{ user: { id: "u1" }, session: notImpersonated },
				path,
			);

			expect(mocks.touchLastSeen).not.toHaveBeenCalled();
			expect(mocks.runInBackground).not.toHaveBeenCalled();
			// The request must still proceed normally — only the activity
			// write is skipped.
			expect(called).toBe(true);
			expect(error).toBeNull();
		});
	}

	it("records activity for a path that merely shares a prefix with a skipped path", async () => {
		// Guards against an overly-broad prefix match: "payments.aiUsageLimits"
		// (list/upsert/delete) must still record activity — only the exact
		// "payments.aiUsageLimits.status" leaf is a passive poll.
		const { called } = await runMiddleware(
			{ user: { id: "u1" }, session: notImpersonated },
			["payments", "aiUsageLimits", "upsert"],
		);

		expect(mocks.touchLastSeen).toHaveBeenCalledWith("u1");
		expect(called).toBe(true);
	});

	it("records activity for an ordinary (non-polled) path", async () => {
		const { called } = await runMiddleware(
			{ user: { id: "u1" }, session: notImpersonated },
			NORMAL_PATH,
		);

		expect(mocks.touchLastSeen).toHaveBeenCalledWith("u1");
		expect(called).toBe(true);
	});
});
