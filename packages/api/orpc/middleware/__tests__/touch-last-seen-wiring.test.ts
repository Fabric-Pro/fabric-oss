/**
 * Wiring test for `touchLastSeenMiddleware` on `protectedProcedure`.
 *
 * Modeled on
 * `packages/auth/lib/__tests__/invite-reconciliation-wiring.test.ts`:
 * every behavioral test for this middleware drives it in isolation
 * (see `touch-last-seen.test.ts`), so none of them notices if the
 * `.use(touchLastSeenMiddleware)` call is ever deleted from
 * `procedures.ts`, or moved above the session middleware. The latter is
 * the dangerous case — `touchLastSeenMiddleware` reads `context.user`
 * and `context.session`, neither of which exists yet before the session
 * middleware runs, so moving it up turns every authenticated request
 * into a synchronous 500 while evaluating the middleware's arguments
 * (before any `.catch()` is attached). We read the source of
 * `procedures.ts` and assert (a) the middleware is imported, (b) it is
 * `.use()`'d on `protectedProcedure`, and (c) that `.use()` call comes
 * AFTER the session middleware that populates `context.session` /
 * `context.user`.
 *
 * The middleware's own behavioral contract (impersonation skip,
 * fire-and-forget via runInBackground, never-throw, return value) is
 * locked by `touch-last-seen.test.ts`; this file locks the wiring.
 */

import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { beforeAll, describe, expect, it } from "vitest";

let PROCEDURES_SOURCE = "";

beforeAll(() => {
	// `procedures.ts` lives at packages/api/orpc/procedures.ts — two
	// levels up from this file in packages/api/orpc/middleware/__tests__/.
	const here = dirname(fileURLToPath(import.meta.url));
	PROCEDURES_SOURCE = readFileSync(
		join(here, "..", "..", "procedures.ts"),
		"utf8",
	);
});

/**
 * Slice the source between `startMarker` and the first occurrence of
 * `endMarker` after it. Fails loudly when either marker is missing so a
 * rename surfaces as a clear assertion message instead of a vacuous
 * pass.
 */
function sliceBetween(
	source: string,
	startMarker: string,
	endMarker: string,
): string {
	const start = source.indexOf(startMarker);
	expect(
		start,
		`expected to find "${startMarker}" in procedures.ts`,
	).toBeGreaterThanOrEqual(0);
	const end = source.indexOf(endMarker, start + startMarker.length);
	expect(
		end,
		`expected to find "${endMarker}" after "${startMarker}" in procedures.ts`,
	).toBeGreaterThanOrEqual(0);
	return source.slice(start, end);
}

/** The `export const protectedProcedure = ...` definition, up to the
 *  next top-level export that follows it. */
function protectedProcedureBlock(): string {
	return sliceBetween(
		PROCEDURES_SOURCE,
		"export const protectedProcedure",
		"export const tenantProtectedProcedure",
	);
}

describe("procedures.ts wiring — touchLastSeenMiddleware", () => {
	it("imports touchLastSeenMiddleware from ./middleware/touch-last-seen", () => {
		expect(PROCEDURES_SOURCE).toMatch(
			/import\s+\{\s*touchLastSeenMiddleware\s*\}\s+from\s+["']\.\/middleware\/touch-last-seen["']/,
		);
	});

	it("mounts touchLastSeenMiddleware on protectedProcedure", () => {
		expect(protectedProcedureBlock()).toMatch(
			/\.use\(\s*touchLastSeenMiddleware\s*\)/,
		);
	});

	it("mounts touchLastSeenMiddleware AFTER the session middleware that populates context.user / context.session", () => {
		const block = protectedProcedureBlock();
		// `session: session.session,` only appears inside the `next({
		// context: {...} })` call of the session-establishing middleware —
		// this is the earliest point at which context.user/context.session
		// exist for anything mounted afterward.
		const sessionIdx = block.indexOf("session: session.session");
		const touchIdx = block.indexOf(".use(touchLastSeenMiddleware)");
		expect(
			sessionIdx,
			"expected to find the session middleware's `session: session.session` in protectedProcedure",
		).toBeGreaterThanOrEqual(0);
		expect(
			touchIdx,
			"expected `.use(touchLastSeenMiddleware)` inside protectedProcedure",
		).toBeGreaterThanOrEqual(0);
		expect(touchIdx).toBeGreaterThan(sessionIdx);
	});
});
