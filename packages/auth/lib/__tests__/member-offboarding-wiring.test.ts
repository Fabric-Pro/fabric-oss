import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { beforeAll, describe, expect, it } from "vitest";

/**
 * WHICH hook each half of offboarding is wired to.
 *
 * That is not a detail — it is the entire substance of the fix, and it is the
 * one thing a unit test cannot see, because a unit test calls the functions
 * itself. Static, for the reason `invite-reconciliation-wiring.test.ts` gives:
 * `auth.ts` builds the Better Auth instance at module load with dozens of
 * side-effecting dependencies, so booting it inside a Vitest worker is fragile
 * and slow by precedent.
 *
 * Two properties, each of which was a real defect:
 *
 *  - The revocation must sit in `beforeRemoveMember`, not after. Before the
 *    member row is deleted a failure can refuse the removal, and no admin can
 *    re-add and re-grant in the window because there is nothing to re-add yet.
 *  - Nothing may re-read the `member` row to discover who was removed.
 *    better-auth hard-deletes it inside its own handler before any global
 *    after-hook fires, so the original wiring resolved null on every removal
 *    and never ran at all. No mocked test would catch that: a stubbed
 *    `db.member.findFirst` returns whatever the fixture says, which is exactly
 *    how it passed review the first time.
 */

let AUTH_SOURCE = "";

beforeAll(() => {
	const here = dirname(fileURLToPath(import.meta.url));
	AUTH_SOURCE = readFileSync(join(here, "..", "..", "auth.ts"), "utf8");
});

/**
 * The source between two markers, both required to exist.
 *
 * BOUNDED on purpose. An earlier version of this helper sliced from the start
 * marker to the end of the file, which made the "revokes in beforeRemoveMember"
 * case pass even when the call had been moved into `afterRemoveMember` — the
 * text was still somewhere after the marker. A negative control caught it; the
 * assertion had been vacuous in exactly the direction that matters.
 */
function sliceBetween(startMarker: string, endMarker: string): string {
	const start = AUTH_SOURCE.indexOf(startMarker);
	expect(
		start,
		`expected to find "${startMarker}" in auth.ts`,
	).toBeGreaterThanOrEqual(0);
	const end = AUTH_SOURCE.indexOf(endMarker, start + startMarker.length);
	expect(
		end,
		`expected to find "${endMarker}" after "${startMarker}" in auth.ts`,
	).toBeGreaterThan(start);
	return AUTH_SOURCE.slice(start, end);
}

describe("auth.ts wiring — member offboarding", () => {
	it("imports both halves from ./lib/member-offboarding", () => {
		expect(AUTH_SOURCE).toMatch(
			/import\s+\{[^}]*revokeDepartingMemberAccess[^}]*\}\s+from\s+["']\.\/lib\/member-offboarding["']/,
		);
		expect(AUTH_SOURCE).toMatch(
			/import\s+\{[^}]*syncSeatsAfterDeparture[^}]*\}\s+from\s+["']\.\/lib\/member-offboarding["']/,
		);
	});

	it("has exactly two awaited revocation call sites — one per way out", () => {
		const calls = AUTH_SOURCE.match(
			/await\s+revokeDepartingMemberAccess\(/g,
		);
		expect(calls).toHaveLength(2);
	});

	it("revokes an ejected member's access in beforeRemoveMember", () => {
		// Bounded at the sibling hook, so the call has to be INSIDE this one.
		const block = sliceBetween(
			"beforeRemoveMember: async",
			"afterRemoveMember: async",
		);

		expect(block).toMatch(
			/await\s+revokeDepartingMemberAccess\(\s*\{\s*organizationId:\s*org\.id,\s*userId:\s*member\.userId,\s*trigger:\s*"removed",?\s*\}\s*\)/,
		);
	});

	it("does NOT revoke in afterRemoveMember, where a failure could not refuse", () => {
		// The ordering claim, in the only form a static check can make it: the
		// revocation appears in the source strictly before `afterRemoveMember`
		// begins, and never inside it.
		const beforeIdx = AUTH_SOURCE.indexOf("beforeRemoveMember: async");
		const afterIdx = AUTH_SOURCE.indexOf("afterRemoveMember: async");
		expect(beforeIdx).toBeGreaterThanOrEqual(0);
		expect(afterIdx).toBeGreaterThan(beforeIdx);

		const afterBlock = AUTH_SOURCE.slice(afterIdx);
		expect(afterBlock).not.toContain("revokeDepartingMemberAccess");
	});

	it("syncs seats from afterRemoveMember, where the member is already gone", () => {
		// Seats count the organization's members, so counting them before the
		// deletion keeps paying for somebody on their way out.
		const block = sliceBetween("afterRemoveMember: async", "openAPI()");

		expect(block).toMatch(/await\s+syncSeatsAfterDeparture\(org\.id\)/);
	});

	it("offboards a departing member from a /organization/leave after-hook", () => {
		// Not a plugin hook, because there is none: `/organization/leave` calls
		// `adapter.deleteMember` directly and none of the fifteen
		// `organizationHooks` pairs covers leaving.
		const block = sliceBetween(
			'ctx.path === "/organization/leave"',
			"before: createAuthMiddleware",
		);

		expect(block).toMatch(
			/await\s+revokeDepartingMemberAccess\(\s*\{\s*organizationId,\s*userId:\s*leavingUserId,\s*trigger:\s*"left",?\s*\}\s*\)/,
		);
		expect(block).toMatch(
			/await\s+syncSeatsAfterDeparture\(organizationId\)/,
		);
	});

	it("no longer looks the removed member up after better-auth deleted it", () => {
		expect(AUTH_SOURCE).not.toContain(
			'ctx.path.startsWith("/organization/remove-member")',
		);
		expect(AUTH_SOURCE).not.toContain("memberIdOrEmail");
	});

	it("does not start the owned-data cascade workflow", () => {
		// Turning that workflow on is a first activation of destructive
		// behaviour, not a repair — it has never run, and it has no fence
		// against remove-then-re-add. Deliberately separate from closing the
		// access hole, so its absence is asserted rather than assumed.
		expect(AUTH_SOURCE).not.toContain("memberCascadeDeleteWorkflow");
	});
});
