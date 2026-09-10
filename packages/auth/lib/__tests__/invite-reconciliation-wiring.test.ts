/**
 * Wiring tests for the three Better Auth trigger points that run invite
 * reconciliation.
 *
 * Like `seed-default-mcp-configs-wiring.test.ts`, this suite verifies the
 * wiring statically — `auth.ts` constructs the Better Auth instance at
 * module-load time with dozens of side-effecting dependencies, so booting
 * it inside a Vitest worker is fragile and slow by precedent. We read the
 * source of `auth.ts` and assert (a) the wrapper is imported from
 * `./lib/invite-reconciliation`, (b) each of the three trigger points
 * awaits it with the right `userId` + `trigger` label. This catches the
 * most common regression mode — a refactor that silently drops one of the
 * call sites.
 *
 * The wrapper's behavioral contract (emailVerified gating, side effects,
 * never-throw) is locked by `invite-reconciliation.test.ts`; this file
 * locks the wiring.
 */

import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { beforeAll, describe, expect, it } from "vitest";
import { databaseHooksBlock, sliceBetween } from "./support/auth-source-slice";

let AUTH_SOURCE = "";

beforeAll(() => {
	// `auth.ts` lives at packages/auth/auth.ts — two levels up from this
	// file in packages/auth/lib/__tests__/.
	const here = dirname(fileURLToPath(import.meta.url));
	AUTH_SOURCE = readFileSync(join(here, "..", "..", "auth.ts"), "utf8");
});

describe("auth.ts hook wiring — runInviteReconciliationForUser", () => {
	it("imports runInviteReconciliationForUser from ./lib/invite-reconciliation", () => {
		expect(AUTH_SOURCE).toMatch(
			/import\s+\{[^}]*runInviteReconciliationForUser[^}]*\}\s+from\s+["']\.\/lib\/invite-reconciliation["']/,
		);
	});

	it("has exactly three awaited call sites (one per trigger)", () => {
		const calls = AUTH_SOURCE.match(
			/await\s+runInviteReconciliationForUser\(/g,
		);
		expect(calls).toHaveLength(3);
	});

	it('awaits the wrapper inside databaseHooks.user.create.after with trigger "user_create"', () => {
		const userBlock = sliceBetween(
			databaseHooksBlock(AUTH_SOURCE),
			"user: {",
			"session: {",
		);
		expect(userBlock).toMatch(
			/await\s+runInviteReconciliationForUser\(\s*\{\s*userId:\s*user\.id,\s*trigger:\s*"user_create",?\s*\}\s*\)/,
		);
	});

	it('awaits the wrapper inside databaseHooks.session.create.after with trigger "session_create" and session.userId', () => {
		const dbHooks = databaseHooksBlock(AUTH_SOURCE);
		const sessionStart = dbHooks.indexOf("session: {");
		expect(
			sessionStart,
			'expected a "session: {" block inside databaseHooks',
		).toBeGreaterThanOrEqual(0);
		const sessionBlock = dbHooks.slice(sessionStart);
		// The hook receives the SESSION (not the user) — the id must come
		// from session.userId.
		expect(sessionBlock).toMatch(/create:\s*\{\s*[\s\S]*?after:\s*async/);
		expect(sessionBlock).toMatch(
			/await\s+runInviteReconciliationForUser\(\s*\{\s*userId:\s*session\.userId,\s*trigger:\s*"session_create",?\s*\}\s*\)/,
		);
	});

	it("skips reconciliation for impersonation sessions before the call", () => {
		const dbHooks = databaseHooksBlock(AUTH_SOURCE);
		const sessionStart = dbHooks.indexOf("session: {");
		const sessionBlock = dbHooks.slice(sessionStart);
		// An impersonation guard must short-circuit before the wrapper runs,
		// so an admin viewing-as a user never triggers grants/seat/audit.
		const guardIdx = sessionBlock.indexOf("session.impersonatedBy");
		const callIdx = sessionBlock.indexOf("runInviteReconciliationForUser");
		expect(
			guardIdx,
			"expected an `if (session.impersonatedBy) return` guard in session.create.after",
		).toBeGreaterThanOrEqual(0);
		expect(callIdx).toBeGreaterThan(guardIdx);
		// The branch short-circuits with a bare `return;`. It is no longer
		// EMPTY — the session's organization seed runs inside it, because an
		// impersonation session still needs the organization it runs in and
		// seeding grants the impersonated user nothing. `[^{}]*` is what keeps
		// this widening honest: a call taking an object argument (which is how
		// reconciliation and organization creation are both written) carries
		// braces and would not match, so this still cannot pass with either of
		// them moved inside the guard. That reconciliation specifically stays
		// out is asserted directly in
		// `seed-session-organization-wiring.test.ts`.
		expect(sessionBlock).toMatch(
			/if\s*\(\s*session\.impersonatedBy\s*\)\s*\{[^{}]*\breturn;\s*\}/,
		);
	});

	it('awaits the wrapper inside emailVerification.afterEmailVerification with trigger "email_verification"', () => {
		const block = sliceBetween(
			AUTH_SOURCE,
			"afterEmailVerification: async",
			"socialProviders",
		);
		expect(block).toMatch(
			/await\s+runInviteReconciliationForUser\(\s*\{\s*userId:\s*user\.id,\s*trigger:\s*"email_verification",?\s*\}\s*\)/,
		);
	});

	it("keeps the welcomeEmailSentAt atomic guard untouched in afterEmailVerification", () => {
		const block = sliceBetween(
			AUTH_SOURCE,
			"afterEmailVerification: async",
			"socialProviders",
		);
		// The guard's conditional updateMany must still precede the
		// reconciliation call.
		expect(block).toMatch(
			/updateMany\(\s*\{\s*where:\s*\{\s*id:\s*user\.id,\s*welcomeEmailSentAt:\s*null\s*\}/,
		);
		const guardIdx = block.indexOf("welcomeEmailSentAt: null");
		const reconcileIdx = block.indexOf("runInviteReconciliationForUser");
		expect(guardIdx).toBeGreaterThanOrEqual(0);
		expect(reconcileIdx).toBeGreaterThan(guardIdx);
	});
});
