import { beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("@repo/logs", () => ({
	logger: { info: vi.fn(), warn: vi.fn(), error: vi.fn() },
}));

const dbUserFindFirst = vi.fn();
const dbUserUpdate = vi.fn();
vi.mock("@repo/database", () => ({
	db: {
		user: {
			findFirst: (...args: unknown[]) => dbUserFindFirst(...args),
			update: (...args: unknown[]) => dbUserUpdate(...args),
		},
	},
}));

const redisIncr = vi.fn();
const redisExpire = vi.fn();
const redisGet = vi.fn();
vi.mock("../redis-client", () => ({
	getAuthRedisClient: () => ({
		incr: redisIncr,
		expire: redisExpire,
		get: redisGet,
	}),
}));

import { recordFailedLogin } from "../brute-force";

describe("recordFailedLogin per-IP lockout cap", () => {
	beforeEach(() => {
		vi.resetAllMocks();
		// Default: user exists, 4 failures already, not locked
		dbUserFindFirst.mockResolvedValue({
			id: "u1",
			failedLoginAttempts: 4,
			lockedUntil: null,
		});
		dbUserUpdate.mockImplementation(
			async (args: {
				data?: { failedLoginAttempts?: { increment: number } };
			}) => {
				// First update increments, returning new count = 5
				if (args.data?.failedLoginAttempts) {
					return { failedLoginAttempts: 5 };
				}
				return {};
			},
		);
		// Default: no IP locks yet
		redisGet.mockResolvedValue(null);
		redisIncr.mockResolvedValue(1);
	});

	it("locks the victim on the 5th failed attempt and bumps IP counter", async () => {
		await recordFailedLogin("victim@example.com", "1.2.3.4");
		// Two updates happened: increment + lockedUntil
		expect(dbUserUpdate).toHaveBeenCalledTimes(2);
		expect(dbUserUpdate.mock.calls[1][0]).toMatchObject({
			data: expect.objectContaining({ lockedUntil: expect.any(Date) }),
		});
		expect(redisIncr).toHaveBeenCalledWith("bf:ip-locks:1.2.3.4");
		expect(redisExpire).toHaveBeenCalledWith("bf:ip-locks:1.2.3.4", 3600);
	});

	it("does not bump IP counter when failure does not reach lockout threshold", async () => {
		dbUserFindFirst.mockResolvedValue({
			id: "u1",
			failedLoginAttempts: 1,
			lockedUntil: null,
		});
		dbUserUpdate.mockImplementation(async () => ({
			failedLoginAttempts: 2,
		}));
		await recordFailedLogin("victim@example.com", "1.2.3.4");
		expect(redisIncr).not.toHaveBeenCalled();
	});

	it("black-holes additional locks once IP cap (3) exceeded", async () => {
		// IP already has 4 locks recorded (above default cap of 3)
		redisGet.mockResolvedValue("4");
		await recordFailedLogin("victim2@example.com", "1.2.3.4");
		// User counter NOT incremented, no lock applied
		expect(dbUserUpdate).not.toHaveBeenCalled();
	});

	it("allows the lock when IP count is at cap exactly", async () => {
		// IP has 3 locks (at cap, not over)
		redisGet.mockResolvedValue("3");
		await recordFailedLogin("victim@example.com", "1.2.3.4");
		expect(dbUserUpdate).toHaveBeenCalled();
	});

	it("works when IP is 'unknown' (skips IP-cap path but still locks)", async () => {
		await recordFailedLogin("victim@example.com", "unknown");
		expect(dbUserUpdate).toHaveBeenCalledTimes(2);
		// No IP counter operations
		expect(redisIncr).not.toHaveBeenCalled();
		expect(redisGet).not.toHaveBeenCalled();
	});

	it("works when Redis client is unavailable (skips IP-cap path, still locks)", async () => {
		// Replace the mock to return null
		vi.resetModules();
		vi.doMock("../redis-client", () => ({
			getAuthRedisClient: () => null,
		}));
		const { recordFailedLogin: rfl } = await import("../brute-force");
		dbUserFindFirst.mockResolvedValue({
			id: "u1",
			failedLoginAttempts: 4,
			lockedUntil: null,
		});
		dbUserUpdate.mockImplementation(async () => ({
			failedLoginAttempts: 5,
		}));
		await rfl("victim@example.com", "1.2.3.4");
		expect(dbUserUpdate).toHaveBeenCalled();
	});
});
