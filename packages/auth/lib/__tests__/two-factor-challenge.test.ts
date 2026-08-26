/**
 * Unit tests for `createTwoFactorChallenge`.
 *
 * Covers the companion-row pairing Better Auth 1.6.22 requires: the
 * challenge row (`2fa-<random>`) and the attempt-budget row
 * (`2fa-attempts-<identifier>`, value "0") must both exist, or
 * `verifyTwoFactor().beginAttempt()` throws UNAUTHORIZED /
 * INVALID_TWO_FACTOR_COOKIE before the submitted code is ever compared —
 * that fires when the attempts row is absent, or when the attempts row's
 * OWN `expiresAt` has passed (`db/internal-adapter.mjs`'s
 * `consumeVerificationValue`: `!consumed || consumed.expiresAt < new
 * Date()`). `beginAttempt()` never compares the two rows' `expiresAt`
 * values against each other. Sharing one `expiresAt` between them instead
 * matches Better Auth's own challenge creation and avoids the attempts
 * row expiring independently of the challenge it belongs to (see
 * ../two-factor-challenge.ts for the full mechanism).
 * Also covers that the two rows are written sequentially, not concurrently
 * (`await`, not `Promise.all`) — challenge row first, attempts row second —
 * matching Better Auth's own write order.
 *
 * Run with: pnpm --filter @repo/auth test lib/__tests__/two-factor-challenge.test.ts
 */

import { describe, expect, it, vi } from "vitest";
import { createTwoFactorChallenge } from "../two-factor-challenge";

interface RecordedRow {
	value: string;
	identifier: string;
	expiresAt: Date;
}

function buildAdapter() {
	const rows: RecordedRow[] = [];
	const createVerificationValue = vi.fn(async (row: RecordedRow) => {
		rows.push(row);
		return row;
	});
	return { createVerificationValue, rows };
}

describe("createTwoFactorChallenge", () => {
	it("creates both the challenge row and the attempts-budget row", async () => {
		const { createVerificationValue, rows } = buildAdapter();

		await createTwoFactorChallenge({
			internalAdapter: { createVerificationValue },
			userId: "user-1",
			maxAgeSeconds: 180,
			ctx: {},
		});

		expect(createVerificationValue).toHaveBeenCalledTimes(2);
		expect(rows).toHaveLength(2);
	});

	it("keys the attempts row as 2fa-attempts-<challenge identifier>", async () => {
		const { createVerificationValue, rows } = buildAdapter();

		const { identifier } = await createTwoFactorChallenge({
			internalAdapter: { createVerificationValue },
			userId: "user-1",
			maxAgeSeconds: 180,
			ctx: {},
		});

		const attemptsRow = rows.find((row) =>
			row.identifier.startsWith("2fa-attempts-"),
		);
		expect(attemptsRow?.identifier).toBe(`2fa-attempts-${identifier}`);
	});

	it('seeds the attempts row value at "0"', async () => {
		const { createVerificationValue, rows } = buildAdapter();

		await createTwoFactorChallenge({
			internalAdapter: { createVerificationValue },
			userId: "user-1",
			maxAgeSeconds: 180,
			ctx: {},
		});

		const attemptsRow = rows.find((row) =>
			row.identifier.startsWith("2fa-attempts-"),
		);
		expect(attemptsRow?.value).toBe("0");
	});

	it("gives both rows an identical expiresAt", async () => {
		const { createVerificationValue, rows } = buildAdapter();

		await createTwoFactorChallenge({
			internalAdapter: { createVerificationValue },
			userId: "user-1",
			maxAgeSeconds: 180,
			ctx: {},
		});

		expect(rows).toHaveLength(2);
		expect(rows[0]?.expiresAt.getTime()).toBe(rows[1]?.expiresAt.getTime());
	});

	it("writes the challenge row first and the attempts row second", async () => {
		const { createVerificationValue, rows } = buildAdapter();

		const { identifier } = await createTwoFactorChallenge({
			internalAdapter: { createVerificationValue },
			userId: "user-1",
			maxAgeSeconds: 180,
			ctx: {},
		});

		expect(rows).toHaveLength(2);
		expect(rows[0]).toMatchObject({ value: "user-1", identifier });
		expect(rows[1]).toMatchObject({
			value: "0",
			identifier: `2fa-attempts-${identifier}`,
		});
	});

	it("does not start the attempts-row write until the challenge-row write resolves", async () => {
		// A `Promise.all([writeChallenge(), writeAttempts()])` would invoke
		// both functions synchronously up front, before either promise
		// settles — so it would satisfy the "first/second" test above too.
		// Holding the first write's promise open here, and asserting the
		// second mock is still uncalled while it's pending, is what actually
		// distinguishes sequential `await`s from a `Promise.all`.
		const createVerificationValue = vi.fn();
		let resolveChallengeWrite: (() => void) | undefined;
		createVerificationValue.mockImplementationOnce(
			() =>
				new Promise<void>((resolve) => {
					resolveChallengeWrite = resolve;
				}),
		);
		createVerificationValue.mockImplementationOnce(async () => undefined);

		const pending = createTwoFactorChallenge({
			internalAdapter: { createVerificationValue },
			userId: "user-1",
			maxAgeSeconds: 180,
			ctx: {},
		});

		// Flush already-queued microtasks. A Promise.all implementation
		// would have called both mocks by now; a sequential one would not.
		await Promise.resolve();
		await Promise.resolve();
		expect(createVerificationValue).toHaveBeenCalledTimes(1);

		resolveChallengeWrite?.();
		await pending;

		expect(createVerificationValue).toHaveBeenCalledTimes(2);
	});

	it("generates a challenge identifier matching /^2fa-[A-Za-z0-9_-]+$/", async () => {
		const { createVerificationValue } = buildAdapter();

		const { identifier } = await createTwoFactorChallenge({
			internalAdapter: { createVerificationValue },
			userId: "user-1",
			maxAgeSeconds: 180,
			ctx: {},
		});

		expect(identifier).toMatch(/^2fa-[A-Za-z0-9_-]+$/);
	});
});
