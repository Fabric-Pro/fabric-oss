import { beforeEach, describe, expect, it, type Mock, vi } from "vitest";

// ---------------------------------------------------------------------------
// Mocks -- external boundaries only
// ---------------------------------------------------------------------------

vi.mock("@repo/database", () => ({
	db: {
		user: {
			findFirst: vi.fn(),
			update: vi.fn(),
		},
	},
}));

vi.mock("@repo/logs", () => ({
	logger: {
		info: vi.fn(),
		warn: vi.fn(),
		error: vi.fn(),
	},
}));

// ---------------------------------------------------------------------------
// Imports (AFTER mocks are set up)
// ---------------------------------------------------------------------------

import { db } from "@repo/database";
import {
	checkLoginAllowed,
	clearLockout,
	hashEmail,
	LOCKOUT_DURATION_MS,
	LOCKOUT_THRESHOLD,
	maskEmail,
	recordFailedLogin,
	recordSuccessfulLogin,
} from "../brute-force";

// ---------------------------------------------------------------------------
// Test helpers
// ---------------------------------------------------------------------------

const TEST_EMAIL = "john@example.com";
const TEST_IP = "192.168.1.1";

function mockUser(overrides: Record<string, unknown> = {}) {
	return {
		id: "user-1",
		email: TEST_EMAIL,
		failedLoginAttempts: 0,
		lockedUntil: null,
		lastFailedLoginAt: null,
		...overrides,
	};
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe("brute-force protection service", () => {
	beforeEach(() => {
		vi.clearAllMocks();
	});

	it("allows login when no previous failures", async () => {
		(db.user.findFirst as Mock).mockResolvedValue(mockUser());

		const result = await checkLoginAllowed(TEST_EMAIL, TEST_IP);

		expect(result).toEqual({ allowed: true });
	});

	it("increments failure count on failed login", async () => {
		(db.user.findFirst as Mock).mockResolvedValue(mockUser());
		(db.user.update as Mock).mockResolvedValue({ failedLoginAttempts: 1 });

		const result = await recordFailedLogin(TEST_EMAIL, TEST_IP);

		expect(result.failedAttempts).toBe(1);
		expect(result.locked).toBe(false);
		expect(db.user.update).toHaveBeenCalledWith(
			expect.objectContaining({
				data: expect.objectContaining({
					failedLoginAttempts: { increment: 1 },
				}),
			}),
		);
	});

	it("locks account after 5 consecutive failures", async () => {
		(db.user.findFirst as Mock).mockResolvedValue(
			mockUser({ failedLoginAttempts: 4 }),
		);
		(db.user.update as Mock)
			.mockResolvedValueOnce({ failedLoginAttempts: LOCKOUT_THRESHOLD })
			.mockResolvedValueOnce({});

		const result = await recordFailedLogin(TEST_EMAIL, TEST_IP);

		expect(result.locked).toBe(true);
		expect(result.failedAttempts).toBe(LOCKOUT_THRESHOLD);
		expect(db.user.update).toHaveBeenCalledTimes(2);
		expect(db.user.update).toHaveBeenLastCalledWith(
			expect.objectContaining({
				data: expect.objectContaining({
					lockedUntil: expect.any(Date),
				}),
			}),
		);
	});

	it("rejects login during lockout period", async () => {
		const lockedUntil = new Date(Date.now() + LOCKOUT_DURATION_MS);
		(db.user.findFirst as Mock).mockResolvedValue(
			mockUser({ lockedUntil, failedLoginAttempts: LOCKOUT_THRESHOLD }),
		);

		const result = await checkLoginAllowed(TEST_EMAIL, TEST_IP);

		expect(result.allowed).toBe(false);
		if (!result.allowed) {
			expect(result.reason).toBe("locked");
			if (result.reason === "locked") {
				expect(result.lockedUntil).toEqual(lockedUntil);
				expect(result.retryAfterSeconds).toBeGreaterThan(0);
			}
		}
	});

	it("auto-unlocks after lockout expires", async () => {
		const expiredLock = new Date(Date.now() - 60_000);
		(db.user.findFirst as Mock).mockResolvedValue(
			mockUser({
				lockedUntil: expiredLock,
				failedLoginAttempts: LOCKOUT_THRESHOLD,
			}),
		);
		(db.user.update as Mock).mockResolvedValue({});

		const result = await checkLoginAllowed(TEST_EMAIL, TEST_IP);

		expect(result).toEqual({ allowed: true });
		expect(db.user.update).toHaveBeenCalledWith(
			expect.objectContaining({
				data: {
					failedLoginAttempts: 0,
					lockedUntil: null,
					lastFailedLoginAt: null,
				},
			}),
		);
	});

	it("clears lockout on password reset", async () => {
		(db.user.findFirst as Mock).mockResolvedValue(
			mockUser({
				failedLoginAttempts: LOCKOUT_THRESHOLD,
				lockedUntil: new Date(Date.now() + LOCKOUT_DURATION_MS),
			}),
		);
		(db.user.update as Mock).mockResolvedValue({});

		await clearLockout(TEST_EMAIL);

		expect(db.user.update).toHaveBeenCalledWith(
			expect.objectContaining({
				data: {
					failedLoginAttempts: 0,
					lockedUntil: null,
					lastFailedLoginAt: null,
				},
			}),
		);
	});

	it("successful login resets failure counter", async () => {
		(db.user.findFirst as Mock).mockResolvedValue(
			mockUser({ failedLoginAttempts: 3 }),
		);
		(db.user.update as Mock).mockResolvedValue({});

		await recordSuccessfulLogin(TEST_EMAIL);

		expect(db.user.update).toHaveBeenCalledWith(
			expect.objectContaining({
				data: {
					failedLoginAttempts: 0,
					lockedUntil: null,
					lastFailedLoginAt: null,
				},
			}),
		);
	});

	it("allows retry immediately after failed login (no cooldown)", async () => {
		(db.user.findFirst as Mock).mockResolvedValue(
			mockUser({ failedLoginAttempts: 3 }),
		);

		const result = await checkLoginAllowed(TEST_EMAIL, TEST_IP);

		expect(result).toEqual({ allowed: true });
	});

	it("masks email correctly in logs", () => {
		expect(maskEmail("john@example.com")).toBe("j***@example.com");
		expect(maskEmail("a@example.com")).toBe("a***@example.com");
		expect(maskEmail("test.user@example.org")).toBe("t***@example.org");
		expect(maskEmail("noatsign")).toBe("***@unknown");
	});

	it("hashes email consistently", () => {
		const hash = hashEmail(TEST_EMAIL);

		expect(hash).toMatch(/^[a-f0-9]{64}$/);
		expect(hashEmail(TEST_EMAIL)).toBe(hash);
		expect(hashEmail("JOHN@EXAMPLE.COM")).toBe(hash);
		expect(hashEmail("jane@example.com")).not.toBe(hash);
	});

	it("does not increment counter for non-existent users", async () => {
		(db.user.findFirst as Mock).mockResolvedValue(null);

		const result = await recordFailedLogin(TEST_EMAIL, TEST_IP);

		expect(result).toEqual({ locked: false, failedAttempts: 0 });
		expect(db.user.update).not.toHaveBeenCalled();
	});

	it("does not increment counter when already locked", async () => {
		(db.user.findFirst as Mock).mockResolvedValue(
			mockUser({
				failedLoginAttempts: LOCKOUT_THRESHOLD,
				lockedUntil: new Date(Date.now() + LOCKOUT_DURATION_MS),
			}),
		);

		const result = await recordFailedLogin(TEST_EMAIL, TEST_IP);

		expect(result).toEqual({
			locked: true,
			failedAttempts: LOCKOUT_THRESHOLD,
		});
		expect(db.user.update).not.toHaveBeenCalled();
	});

	it("allows login for non-existent users (no enumeration)", async () => {
		(db.user.findFirst as Mock).mockResolvedValue(null);

		const result = await checkLoginAllowed(
			"nonexistent@example.com",
			TEST_IP,
		);

		expect(result).toEqual({ allowed: true });
	});
});
