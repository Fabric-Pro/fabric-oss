/**
 * WHERE the session's organization seed is mounted.
 *
 * This is the whole substance of the fix, and it is the one thing a
 * behavioural test cannot see. Seeding used to run only in
 * `databaseHooks.session.create.after`. In the installed Better Auth those
 * after-hooks are queued through `queueAfterTransactionHook` and drained
 * AFTER the request body returns, while the signed session cookie is written
 * inside that body — so the row got its organization and the cookie the API
 * reads did not. A unit test of the seed passes either way, which is exactly
 * how the defect survived. Hence a static wiring test, for the reason
 * `invite-reconciliation-wiring.test.ts` gives: `auth.ts` builds the Better
 * Auth instance at module load with dozens of side-effecting dependencies, so
 * booting it inside a Vitest worker is fragile and slow by precedent.
 *
 * Four properties, each of which is load-bearing:
 *
 *  - The create-time mount exists and its result is RETURNED — see the
 *    return-value contract on `seedSessionOrganizationOnCreate`.
 *  - The create-time hook never returns `false` — same contract.
 *  - The after-hook mount stays, because the create-time hook runs strictly
 *    ahead of invite reconciliation and organization creation. A brand-new
 *    signup has no membership when it runs, and the after-hook seed is that
 *    account's only one.
 *  - The impersonation branch seeds and returns. It must not reconcile
 *    invitations, create an organization, or write a durable last-active
 *    pointer for the impersonated person — and the ordinary path must keep
 *    seeding after both of those, not before them.
 *
 * The seed's own contract (never throws, never overwrites, refuses to guess)
 * is locked by `seed-session-organization.test.ts`; this file locks the wiring.
 * That the library really honours the return-value contract is exercised
 * against a real Better Auth instance in
 * `seed-session-organization-behavior.test.ts`.
 */

import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { beforeAll, describe, expect, it } from "vitest";
import { databaseHooksBlock, sliceBetween } from "./support/auth-source-slice";

let AUTH_SOURCE = "";

beforeAll(() => {
	// `auth.ts` lives at packages/auth/auth.ts — two levels up from this file
	// in packages/auth/lib/__tests__/.
	const here = dirname(fileURLToPath(import.meta.url));
	AUTH_SOURCE = readFileSync(join(here, "..", "..", "auth.ts"), "utf8");
});

/** The `session: { create: { ... } }` block inside `databaseHooks`. */
function sessionCreateBlock(): string {
	const dbHooks = databaseHooksBlock(AUTH_SOURCE);
	const start = dbHooks.indexOf("session: {");
	expect(
		start,
		'expected a "session: {" block inside databaseHooks',
	).toBeGreaterThanOrEqual(0);
	return dbHooks.slice(start);
}

/** The body of `databaseHooks.session.create.before`. */
function createBeforeBlock(): string {
	return sliceBetween(sessionCreateBlock(), "before: async", "after: async");
}

/**
 * The `{ ... }` body that opens after `startMarker`, ending at ITS OWN closing
 * brace.
 *
 * `sliceBetween` needs a marker that follows the block; the last hook in an
 * object has none, and slicing to the end of the enclosing block is the
 * unbounded read `member-offboarding-wiring.test.ts` warns about — "the call is
 * inside this hook" would still pass with the call moved into a sibling hook
 * declared below it. Brace-matching gives that last hook the same bound its
 * siblings get from a marker.
 *
 * Comments and string literals are skipped so a brace inside either cannot
 * unbalance the count; template substitutions (`${...}`) are followed back into
 * code. Pinned by the negative control at the bottom of this file.
 */
function balancedBlockAfter(source: string, startMarker: string): string {
	const markerIdx = source.indexOf(startMarker);
	expect(
		markerIdx,
		`expected to find "${startMarker}" in auth.ts`,
	).toBeGreaterThanOrEqual(0);
	const open = source.indexOf("{", markerIdx + startMarker.length);
	expect(
		open,
		`expected a "{" to open the block after "${startMarker}"`,
	).toBeGreaterThan(markerIdx);

	let depth = 0;
	// Brace depth at which each still-open `${` substitution began, so the `}`
	// that closes one is not mistaken for the end of a block.
	const substitutions: number[] = [];
	let state: "code" | "template" = "code";
	let index = open;

	while (index < source.length) {
		const char = source[index];
		const pair = source.slice(index, index + 2);

		if (state === "template") {
			if (char === "\\") {
				index += 2;
				continue;
			}
			if (char === "`") {
				state = "code";
			} else if (pair === "${") {
				substitutions.push(depth);
				depth += 1;
				state = "code";
				index += 2;
				continue;
			}
			index += 1;
			continue;
		}

		if (pair === "//") {
			const lineEnd = source.indexOf("\n", index);
			index = lineEnd === -1 ? source.length : lineEnd + 1;
			continue;
		}
		if (pair === "/*") {
			const commentEnd = source.indexOf("*/", index + 2);
			index = commentEnd === -1 ? source.length : commentEnd + 2;
			continue;
		}
		if (char === '"' || char === "'") {
			index += 1;
			while (index < source.length && source[index] !== char) {
				index += source[index] === "\\" ? 2 : 1;
			}
			index += 1;
			continue;
		}
		if (char === "`") {
			state = "template";
			index += 1;
			continue;
		}
		if (char === "{") {
			depth += 1;
		} else if (char === "}") {
			depth -= 1;
			if (
				substitutions.length > 0 &&
				depth === substitutions[substitutions.length - 1]
			) {
				substitutions.pop();
				state = "template";
			} else if (depth === 0) {
				return source.slice(open, index + 1);
			}
		}
		index += 1;
	}

	throw new Error(`unbalanced braces after "${startMarker}" in auth.ts`);
}

/**
 * The body of `databaseHooks.session.create.after`.
 *
 * Bounded at its own closing brace — it is the last hook in `session.create`,
 * so there is no following marker to slice to, and an unbounded read would let
 * a seed call moved out into a sibling hook below still satisfy every
 * assertion made about this one.
 */
function createAfterBlock(): string {
	return balancedBlockAfter(sessionCreateBlock(), "after: async");
}

/**
 * The body of the impersonation early return inside `session.create.after`,
 * bounded at the `return;` that closes it.
 */
function impersonationBranch(): string {
	return sliceBetween(
		createAfterBlock(),
		"if (session.impersonatedBy) {",
		"return;",
	);
}

/**
 * The named bindings imported from `./lib/seed-session-organization`, as exact
 * strings.
 *
 * Matched as a list rather than as a substring on purpose: a regex looking for
 * `seedSessionOrganization` anywhere inside the braces is also satisfied by an
 * import of `seedSessionOrganizationOnCreate` alone, which contains it — so the
 * shorter name would have been pinned by nothing. Exact list membership pins
 * each symbol independently.
 */
function seedImportBindings(): string[] {
	const match = AUTH_SOURCE.match(
		/import\s+\{([^}]*)\}\s+from\s+["']\.\/lib\/seed-session-organization["']/,
	);
	expect(
		match,
		"expected an import from ./lib/seed-session-organization in auth.ts",
	).not.toBeNull();
	return (match?.[1] ?? "")
		.split(",")
		.map((binding) => binding.trim())
		.filter(Boolean);
}

describe("auth.ts wiring — the session's organization seed", () => {
	it("imports both seeding paths from ./lib/seed-session-organization", () => {
		const bindings = seedImportBindings();

		expect(bindings).toContain("seedSessionOrganization");
		expect(bindings).toContain("seedSessionOrganizationOnCreate");
	});

	// The mount that closes the cookie window. Without it the row is patched
	// after the response body has already been signed and sent.
	it("mounts the create-time seed on databaseHooks.session.create.before", () => {
		expect(createBeforeBlock()).toMatch(
			/seedSessionOrganizationOnCreate\(\s*session\s*\)/,
		);
	});

	// `createWithHooks` merges only `{ data }`. A hook that awaits the seed and
	// returns nothing ships the fix as a no-op.
	it("RETURNS the create-time seed's result so the library merges it", () => {
		expect(createBeforeBlock()).toMatch(
			/return\s+(await\s+)?seedSessionOrganizationOnCreate\(\s*session\s*\)/,
		);
	});

	// A literal `false` aborts session creation. It is the only return value
	// that can fail a sign-in, and a default must never be able to.
	it("never returns false from the create-time hook", () => {
		expect(createBeforeBlock()).not.toMatch(/return\s+false/);
	});

	// The create-time hook runs before reconciliation and organization
	// creation, so a brand-new signup has no membership when it fires. The
	// after-hook seed is that account's only one.
	it("keeps the after-hook seed as the catch for a membership created in the same request", () => {
		// Bounded at the organization creation that writes that membership, so
		// the impersonation branch's own seed cannot satisfy this.
		const afterBlock = createAfterBlock();
		const ensureIdx = afterBlock.indexOf("ensureUserHasOrganization");
		expect(
			ensureIdx,
			"expected ensureUserHasOrganization in session.create.after",
		).toBeGreaterThanOrEqual(0);

		expect(afterBlock.slice(ensureIdx)).toMatch(
			/await\s+seedSessionOrganization\(\s*session\s*\)/,
		);
	});

	it("seeds an impersonation session and returns without reconciling or creating", () => {
		const branch = impersonationBranch();

		expect(branch).toMatch(
			/await\s+seedSessionOrganization\(\s*session\s*\)/,
		);
		// R3: no membership grant, seat change or reconciliation audit row for
		// the impersonated person.
		expect(branch).not.toContain("runInviteReconciliationForUser");
		expect(branch).not.toContain("ensureUserHasOrganization");
		// And no durable last-active pointer, which is written only by a
		// deliberate workspace switch.
		expect(branch).not.toContain("lastActiveOrganizationId");
	});

	// The seed is NOT hoisted above the impersonation guard. Doing so would put
	// it ahead of reconciliation and organization creation for an ordinary
	// session, and a new signup would end with no organization at all.
	it("seeds an ordinary session only after reconciliation and organization creation", () => {
		const afterBlock = createAfterBlock();
		const guardIdx = afterBlock.indexOf("if (session.impersonatedBy) {");
		const reconcileIdx = afterBlock.indexOf(
			"runInviteReconciliationForUser",
		);
		const ensureIdx = afterBlock.indexOf("ensureUserHasOrganization");
		const ordinarySeedIdx = afterBlock.lastIndexOf(
			"seedSessionOrganization(session)",
		);

		expect(guardIdx).toBeGreaterThanOrEqual(0);
		expect(reconcileIdx).toBeGreaterThan(guardIdx);
		expect(ensureIdx).toBeGreaterThan(reconcileIdx);
		expect(ordinarySeedIdx).toBeGreaterThan(ensureIdx);
	});

	it("has exactly two after-hook seed call sites — impersonation and ordinary", () => {
		// The trailing `(` keeps `seedSessionOrganizationOnCreate(` out of the
		// count.
		const calls = createAfterBlock().match(/seedSessionOrganization\(/g);
		expect(calls).toHaveLength(2);
	});

	// Negative control for the bound itself, which the two cases above rest on:
	// every claim they make about `session.create.after` is only worth as much
	// as the slice they make it against. Against a source where the seed has
	// been MOVED OUT into a sibling hook below, the after-hook block must not
	// contain it — the previous unbounded slice did, and both cases passed
	// anyway.
	it("bounds the after-hook at its own closing brace, not at the end of the block", () => {
		const seedMovedToASiblingHook = `session: {
			create: {
				before: async (session) => {
					return await seedSessionOrganizationOnCreate(session);
				},
				after: async (session) => {
					// A brace in a comment: {
					await runInviteReconciliationForUser({
						userId: session.userId,
						trigger: "session_create",
					});
				},
			},
			update: {
				after: async (session) => {
					await seedSessionOrganization(session);
				},
			},
		},`;

		const afterBlock = balancedBlockAfter(
			seedMovedToASiblingHook,
			"after: async",
		);

		expect(afterBlock).toContain("runInviteReconciliationForUser");
		expect(afterBlock).not.toContain("seedSessionOrganization(");
	});
});
