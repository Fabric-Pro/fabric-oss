/**
 * Throttle tests for the last-seen writer. The Prisma
 * client is mocked; these pin the throttle window, the conditional
 * WHERE shape that keeps multi-instance writes bounded, and the
 * never-throw contract of a helper that runs un-awaited on every
 * authenticated request.
 */
import { beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
	userUpdateMany: vi.fn(),
	loggerWarn: vi.fn(),
}));

vi.mock("../prisma/client", () => ({
	db: { user: { updateMany: mocks.userUpdateMany } },
}));

vi.mock("@repo/logs", () => ({
	logger: { warn: mocks.loggerWarn },
}));

import {
	__lastSeenThrottleSize,
	__resetLastSeenThrottle,
	FAILURE_BACKOFF_MS,
	LAST_SEEN_THROTTLE_MS,
	touchLastSeen,
} from "../prisma/queries/user-last-seen";

const NOW = new Date("2026-07-23T12:00:00.000Z");

beforeEach(() => {
	vi.clearAllMocks();
	__resetLastSeenThrottle();
	mocks.userUpdateMany.mockResolvedValue({ count: 1 });
});

describe("touchLastSeen", () => {
	it("writes on the first call, guarded by the throttle cutoff", async () => {
		await touchLastSeen("u1", NOW);

		expect(mocks.userUpdateMany).toHaveBeenCalledTimes(1);
		expect(mocks.userUpdateMany).toHaveBeenCalledWith({
			where: {
				id: "u1",
				OR: [
					{ lastSeenAt: null },
					{
						lastSeenAt: {
							lt: new Date(NOW.getTime() - LAST_SEEN_THROTTLE_MS),
						},
					},
				],
			},
			data: { lastSeenAt: NOW },
		});
	});

	it("skips the write inside the throttle window", async () => {
		await touchLastSeen("u1", NOW);
		await touchLastSeen("u1", new Date(NOW.getTime() + 60_000));

		expect(mocks.userUpdateMany).toHaveBeenCalledTimes(1);
	});

	it("writes again once the window has elapsed", async () => {
		await touchLastSeen("u1", NOW);
		await touchLastSeen(
			"u1",
			new Date(NOW.getTime() + LAST_SEEN_THROTTLE_MS + 1),
		);

		expect(mocks.userUpdateMany).toHaveBeenCalledTimes(2);
	});

	it("throttles each user independently", async () => {
		await touchLastSeen("u1", NOW);
		await touchLastSeen("u2", NOW);

		expect(mocks.userUpdateMany).toHaveBeenCalledTimes(2);
	});

	it("never throws when the database write fails", async () => {
		mocks.userUpdateMany.mockRejectedValue(new Error("connection lost"));

		await expect(touchLastSeen("u1", NOW)).resolves.toBeUndefined();
	});

	// CRITICAL 1: a persistent failure must arm a bounded backoff, not clear
	// the throttle outright — clearing it would mean every subsequent
	// request from every user re-enters the write path unthrottled for as
	// long as the failure persists (e.g. the `lastSeenAt` migration hasn't
	// landed on this environment yet, or an ongoing database incident).
	it("does NOT write on the very next call after a failed write (bounded backoff, not an unthrottled retry)", async () => {
		mocks.userUpdateMany.mockRejectedValueOnce(
			new Error("connection lost"),
		);

		await touchLastSeen("u1", NOW);
		await touchLastSeen("u1", new Date(NOW.getTime() + 1_000));

		expect(mocks.userUpdateMany).toHaveBeenCalledTimes(1);
	});

	it("does not retry before the failure backoff elapses", async () => {
		mocks.userUpdateMany.mockRejectedValueOnce(
			new Error("connection lost"),
		);

		await touchLastSeen("u1", NOW);
		await touchLastSeen(
			"u1",
			new Date(NOW.getTime() + FAILURE_BACKOFF_MS - 1),
		);

		expect(mocks.userUpdateMany).toHaveBeenCalledTimes(1);
	});

	it("retries once the failure backoff has elapsed", async () => {
		mocks.userUpdateMany.mockRejectedValueOnce(
			new Error("connection lost"),
		);

		await touchLastSeen("u1", NOW);
		await touchLastSeen(
			"u1",
			new Date(NOW.getTime() + FAILURE_BACKOFF_MS + 1),
		);

		expect(mocks.userUpdateMany).toHaveBeenCalledTimes(2);
	});

	it("logs at most one warn per user per backoff window — the log flood is bounded by the same backoff that gates the write, not a separate mechanism", async () => {
		mocks.userUpdateMany.mockRejectedValue(new Error("connection lost"));

		// A burst of calls for the same user, all within the backoff
		// window opened by the first failure: only the first one reaches
		// the write attempt (and thus logs); the rest are thrown out by
		// the early-return throttle check before ever touching the
		// database or the logger. This is the exact "every subsequent
		// request re-enters the write path" flood CRITICAL 1 fixes.
		await touchLastSeen("u1", NOW);
		await touchLastSeen("u1", new Date(NOW.getTime() + 1));
		await touchLastSeen("u1", new Date(NOW.getTime() + 2));
		await touchLastSeen(
			"u1",
			new Date(NOW.getTime() + FAILURE_BACKOFF_MS - 1),
		);

		expect(mocks.userUpdateMany).toHaveBeenCalledTimes(1);
		expect(mocks.loggerWarn).toHaveBeenCalledTimes(1);

		// Once the backoff elapses, a fresh attempt is made — and if it
		// also fails, it logs again (this is the "still warn eventually"
		// half of the contract; the earlier assertions cover "not a
		// flood").
		await touchLastSeen(
			"u1",
			new Date(NOW.getTime() + FAILURE_BACKOFF_MS + 1),
		);

		expect(mocks.userUpdateMany).toHaveBeenCalledTimes(2);
		expect(mocks.loggerWarn).toHaveBeenCalledTimes(2);
	});

	it("prunes throttle entries older than the window so the map stays bounded", async () => {
		await touchLastSeen("u1", NOW);
		expect(__lastSeenThrottleSize()).toBe(1);

		await touchLastSeen(
			"u2",
			new Date(NOW.getTime() + LAST_SEEN_THROTTLE_MS + 1),
		);

		// u1's entry is older than the window and was swept on u2's write.
		expect(__lastSeenThrottleSize()).toBe(1);
	});
});
