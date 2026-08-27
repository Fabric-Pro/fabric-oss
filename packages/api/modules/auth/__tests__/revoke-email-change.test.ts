/**
 * Tests for the revokeEmailChange handler (B3 — M6).
 *
 * We import the real `revokeEmailChangeHandler` and pass a mock `deps.db`,
 * so changes to the procedure are caught by these tests. The exported
 * handler factor pattern matches `resendVerificationEmailHandler` in the
 * sibling resend-verification-email.ts.
 */

import { ORPCError } from "@orpc/server";
import { signToken } from "@repo/auth/lib/signed-token";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
	type RevokeEmailChangeDeps,
	revokeEmailChangeHandler,
} from "../procedures/revoke-email-change";

// ---------------------------------------------------------------------------
// Mock @repo/logs so log output doesn't pollute the test runner
// ---------------------------------------------------------------------------

vi.mock("@repo/logs", () => ({
	logger: {
		info: vi.fn(),
		error: vi.fn(),
		warn: vi.fn(),
	},
}));

vi.mock("@repo/database", () => ({
	db: {
		session: {
			deleteMany: vi.fn(),
		},
	},
	getOrganizationMembership: vi.fn(),
	getTenantContext: vi.fn(),
}));

vi.mock("@repo/auth", () => ({
	auth: {
		api: {
			getSession: vi.fn(),
		},
	},
}));

// ---------------------------------------------------------------------------
// Mock deps — only `db.session.deleteMany`, no Prisma needed
// ---------------------------------------------------------------------------

const mockDeleteMany = vi.fn().mockResolvedValue({ count: 1 });
const mockBlockEmailVerifyJWT = vi.fn().mockResolvedValue(undefined);
const mockMarkEmailChangeRevoked = vi.fn().mockResolvedValue(undefined);
const mockUserFindUnique = vi.fn();
const mockUserUpdate = vi.fn().mockResolvedValue({});

const makeDeps = (): RevokeEmailChangeDeps => ({
	db: {
		session: {
			deleteMany: mockDeleteMany,
		},
		user: {
			findUnique: mockUserFindUnique,
			update: mockUserUpdate,
		},
	},
	blockEmailVerifyJWT: mockBlockEmailVerifyJWT,
	markEmailChangeRevoked: mockMarkEmailChangeRevoked,
});

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

const VALID_SECRET = "test-secret-32-chars-or-longer-aaaaaa";

function makeToken(
	overrides?: Partial<{
		userId: string;
		oldEmail: string;
		newEmail: string;
		betterAuthToken: string;
		kind: string;
		ttlSec: number;
	}>,
) {
	const {
		userId = "user-123",
		oldEmail = "old@example.com",
		newEmail = "new@example.com",
		betterAuthToken = "ba-token-xyz",
		kind = "email-change-revoke",
		ttlSec = 3600,
	} = overrides ?? {};
	return signToken(
		{ userId, oldEmail, newEmail, betterAuthToken, kind },
		{ ttlSec },
	);
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe("revokeEmailChangeHandler", () => {
	const originalEnv = { ...process.env };

	beforeEach(() => {
		process.env = { ...originalEnv, BETTER_AUTH_SECRET: VALID_SECRET };
		mockDeleteMany.mockClear();
		mockDeleteMany.mockResolvedValue({ count: 1 });
		mockBlockEmailVerifyJWT.mockClear();
		mockBlockEmailVerifyJWT.mockResolvedValue(undefined);
		mockMarkEmailChangeRevoked.mockClear();
		mockMarkEmailChangeRevoked.mockResolvedValue(undefined);
		mockUserFindUnique.mockClear();
		mockUserFindUnique.mockResolvedValue({ email: "old@example.com" });
		mockUserUpdate.mockClear();
		mockUserUpdate.mockResolvedValue({});
	});

	afterEach(() => {
		process.env = { ...originalEnv };
	});

	it("(a) valid token revokes sessions and returns ok:true", async () => {
		const token = makeToken();

		const result = await revokeEmailChangeHandler(token, makeDeps());

		expect(result).toEqual({ ok: true });
		expect(mockDeleteMany).toHaveBeenCalledOnce();
		expect(mockDeleteMany).toHaveBeenCalledWith({
			where: { userId: "user-123" },
		});
	});

	it("(b) tampered token is rejected with BAD_REQUEST", async () => {
		const token = makeToken();
		const [head] = token.split(".");
		const tamperedToken = `${head}.deadbeef`;

		await expect(
			revokeEmailChangeHandler(tamperedToken, makeDeps()),
		).rejects.toThrow(ORPCError);
		expect(mockDeleteMany).not.toHaveBeenCalled();
	});

	it("(c) expired token is rejected with BAD_REQUEST", async () => {
		const token = makeToken({ ttlSec: -1 });

		await expect(
			revokeEmailChangeHandler(token, makeDeps()),
		).rejects.toThrow(ORPCError);
		expect(mockDeleteMany).not.toHaveBeenCalled();
	});

	it("(d) wrong kind field is rejected with BAD_REQUEST", async () => {
		const token = makeToken({ kind: "wrong-kind" });

		await expect(
			revokeEmailChangeHandler(token, makeDeps()),
		).rejects.toThrow(ORPCError);
		expect(mockDeleteMany).not.toHaveBeenCalled();
	});

	it("(e) DB session delete is called exactly once for a valid token", async () => {
		const token = makeToken({ userId: "user-abc" });

		await revokeEmailChangeHandler(token, makeDeps());

		expect(mockDeleteMany).toHaveBeenCalledTimes(1);
		expect(mockDeleteMany).toHaveBeenCalledWith({
			where: { userId: "user-abc" },
		});
	});

	it("(f) blocklists the Better Auth verification JWT after revoke", async () => {
		const token = makeToken({ betterAuthToken: "ba-jwt-to-block" });

		await revokeEmailChangeHandler(token, makeDeps());

		expect(mockBlockEmailVerifyJWT).toHaveBeenCalledOnce();
		expect(mockBlockEmailVerifyJWT).toHaveBeenCalledWith("ba-jwt-to-block");
	});

	it("(g) skips blocklist when betterAuthToken is missing/empty", async () => {
		const token = makeToken({ betterAuthToken: "" });

		await revokeEmailChangeHandler(token, makeDeps());

		expect(mockBlockEmailVerifyJWT).not.toHaveBeenCalled();
	});

	it("(h) rolls back user.email to oldEmail when current email matches newEmail", async () => {
		mockUserFindUnique.mockResolvedValueOnce({ email: "new@example.com" });
		const token = makeToken({
			userId: "user-rollback",
			oldEmail: "owner@example.com",
			newEmail: "new@example.com",
		});

		await revokeEmailChangeHandler(token, makeDeps());

		expect(mockUserUpdate).toHaveBeenCalledOnce();
		expect(mockUserUpdate).toHaveBeenCalledWith({
			where: { id: "user-rollback" },
			data: { email: "owner@example.com", emailVerified: true },
		});
	});

	it("(i) skips rollback when user.email does not match newEmail", async () => {
		mockUserFindUnique.mockResolvedValueOnce({
			email: "owner@example.com",
		});
		const token = makeToken({
			oldEmail: "owner@example.com",
			newEmail: "new@example.com",
		});

		await revokeEmailChangeHandler(token, makeDeps());

		expect(mockUserUpdate).not.toHaveBeenCalled();
	});

	it("(j) fails closed when rollback DB write fails after JWT 2 was clicked", async () => {
		mockUserFindUnique.mockResolvedValueOnce({ email: "new@example.com" });
		mockUserUpdate.mockRejectedValueOnce(new Error("db transient"));
		const token = makeToken({ newEmail: "new@example.com" });

		await expect(
			revokeEmailChangeHandler(token, makeDeps()),
		).rejects.toThrow(ORPCError);
	});

	it("(j2) fails closed when the user lookup itself fails", async () => {
		mockUserFindUnique.mockRejectedValueOnce(new Error("db down"));
		const token = makeToken();

		await expect(
			revokeEmailChangeHandler(token, makeDeps()),
		).rejects.toThrow(ORPCError);
	});

	it("(l) marks the {oldEmail, newEmail} tuple as revoked so JWT 2 is rejected", async () => {
		const token = makeToken({
			oldEmail: "owner@example.com",
			newEmail: "attacker@evil.example",
		});

		await revokeEmailChangeHandler(token, makeDeps());

		expect(mockMarkEmailChangeRevoked).toHaveBeenCalledOnce();
		expect(mockMarkEmailChangeRevoked).toHaveBeenCalledWith(
			"owner@example.com",
			"attacker@evil.example",
		);
	});

	it("(m) fails closed when the tuple marker write fails (no sessions touched)", async () => {
		mockMarkEmailChangeRevoked.mockRejectedValueOnce(
			new Error("redis down"),
		);
		const token = makeToken();

		await expect(
			revokeEmailChangeHandler(token, makeDeps()),
		).rejects.toThrow(ORPCError);
		expect(mockDeleteMany).not.toHaveBeenCalled();
		expect(mockBlockEmailVerifyJWT).not.toHaveBeenCalled();
	});

	it("(k) rejects payload missing oldEmail", async () => {
		const tamperedToken = signToken(
			{
				userId: "u1",
				newEmail: "n@example.com",
				betterAuthToken: "t",
				kind: "email-change-revoke",
			},
			{ ttlSec: 60 },
		);

		await expect(
			revokeEmailChangeHandler(tamperedToken, makeDeps()),
		).rejects.toThrow(ORPCError);
		expect(mockDeleteMany).not.toHaveBeenCalled();
	});
});
