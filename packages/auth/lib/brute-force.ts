/**
 * Brute Force Protection Service
 *
 * Counts consecutive failures in PostgreSQL, locks at threshold (5 failures → 1 hour).
 * No per-request cooldown — the API-level rate limiter (auth-rate-limit.ts)
 * already handles rapid-fire / bot protection at the IP level.
 *
 * This module is standalone and does not depend on Hono or Better Auth.
 * It is wired into the auth flow via Better Auth hooks.
 */

import { createHash } from "node:crypto";
import { db } from "@repo/database";
import { logger } from "@repo/logs";
import { getAuthRedisClient } from "./redis-client";

const _ipCapParsed = Number.parseInt(
	process.env.BRUTE_FORCE_IP_LOCKOUT_CAP ?? "3",
	10,
);
const IP_LOCKOUT_CAP =
	Number.isFinite(_ipCapParsed) && _ipCapParsed > 0 ? _ipCapParsed : 3;
const IP_LOCKOUT_KEY_TTL_SEC = 60 * 60;

async function ipLockedOut(ip: string): Promise<boolean> {
	if (!ip || ip === "unknown") {
		return false;
	}
	const redis = getAuthRedisClient();
	if (!redis) {
		return false;
	}
	try {
		const raw = await redis.get<string>(`bf:ip-locks:${ip}`);
		const count = Number.parseInt(raw ?? "0", 10);
		return count > IP_LOCKOUT_CAP;
	} catch {
		// Fail open at the IP-cap layer — don't break authentication on Redis errors
		return false;
	}
}

async function bumpIpLockCounter(ip: string): Promise<number> {
	if (!ip || ip === "unknown") {
		return 0;
	}
	const redis = getAuthRedisClient();
	if (!redis) {
		return 0;
	}
	try {
		const key = `bf:ip-locks:${ip}`;
		const count = await redis.incr(key);
		if (count === 1) {
			await redis.expire(key, IP_LOCKOUT_KEY_TTL_SEC);
		}
		return count;
	} catch {
		return 0;
	}
}

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

/** Number of consecutive failures before account lockout */
export const LOCKOUT_THRESHOLD = 5;

/** Lockout duration in milliseconds (1 hour) */
export const LOCKOUT_DURATION_MS = 3_600_000;

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export type LoginCheckResult =
	| { allowed: true }
	| {
			allowed: false;
			reason: "locked";
			lockedUntil: Date;
			retryAfterSeconds: number;
	  };

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/** SHA-256 hash an email (used for logging, no PII) */
export function hashEmail(email: string): string {
	return createHash("sha256")
		.update(email.toLowerCase().trim())
		.digest("hex");
}

/** Mask email for logs: first char + *** + @ + domain */
export function maskEmail(email: string): string {
	const parts = email.split("@");
	if (parts.length !== 2 || parts[0].length === 0) {
		return "***@unknown";
	}
	return `${parts[0][0]}***@${parts[1]}`;
}

// ---------------------------------------------------------------------------
// Core functions
// ---------------------------------------------------------------------------

/**
 * Pre-login check: determine whether a login attempt is allowed.
 *
 * Checks DB lockout state only. Rapid-fire protection is handled
 * by the API-level rate limiter (auth-rate-limit.ts).
 *
 * User enumeration prevention: if the email does not match a user, this
 * function still returns `{ allowed: true }` so that the normal
 * "invalid credentials" error is shown (never ACCOUNT_LOCKED).
 */
export async function checkLoginAllowed(
	email: string,
	_ip: string,
): Promise<LoginCheckResult> {
	const normalizedEmail = email.toLowerCase().trim();

	const user = await db.user.findFirst({
		where: { email: normalizedEmail },
		select: {
			id: true,
			failedLoginAttempts: true,
			lockedUntil: true,
			lastFailedLoginAt: true,
		},
	});

	if (!user) {
		return { allowed: true };
	}

	if (user.lockedUntil) {
		const now = new Date();
		if (user.lockedUntil > now) {
			const retryAfterSeconds = Math.ceil(
				(user.lockedUntil.getTime() - now.getTime()) / 1000,
			);

			logger.warn(
				{
					event: "auth.login.failed",
					security: true,
					email: maskEmail(normalizedEmail),
					attemptNumber: user.failedLoginAttempts,
					reason: "locked",
				},
				"Login attempt on locked account",
			);

			return {
				allowed: false,
				reason: "locked",
				lockedUntil: user.lockedUntil,
				retryAfterSeconds,
			};
		}

		// Lockout expired — auto-unlock
		logger.info(
			{
				event: "auth.account.unlocked",
				security: true,
				email: maskEmail(normalizedEmail),
				reason: "expired",
			},
			"Account auto-unlocked after lockout expiry",
		);

		await db.user.update({
			where: { id: user.id },
			data: {
				failedLoginAttempts: 0,
				lockedUntil: null,
				lastFailedLoginAt: null,
			},
		});
	}

	return { allowed: true };
}

/**
 * Record a failed login attempt.
 *
 * Increments the DB failure counter and locks the account at LOCKOUT_THRESHOLD.
 */
export async function recordFailedLogin(
	email: string,
	ip: string,
): Promise<{ locked: boolean; failedAttempts: number }> {
	const normalizedEmail = email.toLowerCase().trim();

	const user = await db.user.findFirst({
		where: { email: normalizedEmail },
		select: { id: true, failedLoginAttempts: true, lockedUntil: true },
	});

	if (!user) {
		return { locked: false, failedAttempts: 0 };
	}

	// IP-cap black-hole: if this IP has already locked too many accounts,
	// silently drop without bumping the victim counter.
	if (await ipLockedOut(ip)) {
		logger.warn(
			{ event: "auth.brute_force.ip_blackhole", ip, security: true },
			"Black-holing failed login from IP — lockout cap reached",
		);
		return { locked: false, failedAttempts: user.failedLoginAttempts };
	}

	// Already locked — don't increment
	if (user.lockedUntil && user.lockedUntil > new Date()) {
		return { locked: true, failedAttempts: user.failedLoginAttempts };
	}

	const updatedUser = await db.user.update({
		where: { id: user.id },
		data: {
			failedLoginAttempts: { increment: 1 },
			lastFailedLoginAt: new Date(),
		},
		select: { failedLoginAttempts: true },
	});

	const newCount = updatedUser.failedLoginAttempts;

	let locked = false;
	if (newCount >= LOCKOUT_THRESHOLD) {
		const lockedUntil = new Date(Date.now() + LOCKOUT_DURATION_MS);
		await db.user.update({
			where: { id: user.id },
			data: { lockedUntil },
		});
		locked = true;

		const ipLockCount = await bumpIpLockCounter(ip);
		logger.info(
			{
				event: "auth.brute_force.ip_lock_count",
				ip,
				count: ipLockCount,
				cap: IP_LOCKOUT_CAP,
			},
			"IP-level lockout counter incremented",
		);

		logger.warn(
			{
				event: "auth.account.locked",
				security: true,
				email: maskEmail(normalizedEmail),
				attemptNumber: newCount,
				lockedUntil: lockedUntil.toISOString(),
			},
			"Account locked after repeated failed login attempts",
		);
	} else {
		logger.warn(
			{
				event: "auth.login.failed",
				security: true,
				email: maskEmail(normalizedEmail),
				attemptNumber: newCount,
				reason: "invalid_credentials",
			},
			"Failed login attempt recorded",
		);
	}

	return { locked, failedAttempts: newCount };
}

/**
 * Record a successful login.
 *
 * Resets the DB failure counter.
 */
export async function recordSuccessfulLogin(email: string): Promise<void> {
	const normalizedEmail = email.toLowerCase().trim();

	const user = await db.user.findFirst({
		where: { email: normalizedEmail },
		select: { id: true, failedLoginAttempts: true },
	});

	if (!user) {
		return;
	}

	const wasLocked = user.failedLoginAttempts > 0;

	await db.user.update({
		where: { id: user.id },
		data: {
			failedLoginAttempts: 0,
			lockedUntil: null,
			lastFailedLoginAt: null,
		},
	});

	if (wasLocked) {
		logger.info(
			{
				event: "auth.login.success_after_lockout",
				security: true,
				email: maskEmail(normalizedEmail),
			},
			"Successful login after previous failures",
		);
	}
}

/**
 * Clear lockout state (called after password reset).
 *
 * Resets all DB lockout fields. Idempotent.
 */
export async function clearLockout(email: string): Promise<void> {
	const normalizedEmail = email.toLowerCase().trim();

	const user = await db.user.findFirst({
		where: { email: normalizedEmail },
		select: { id: true },
	});

	if (!user) {
		return;
	}

	await db.user.update({
		where: { id: user.id },
		data: {
			failedLoginAttempts: 0,
			lockedUntil: null,
			lastFailedLoginAt: null,
		},
	});

	logger.info(
		{
			event: "auth.account.unlocked",
			security: true,
			email: maskEmail(normalizedEmail),
			reason: "password_reset",
		},
		"Account lockout cleared via password reset",
	);
}
