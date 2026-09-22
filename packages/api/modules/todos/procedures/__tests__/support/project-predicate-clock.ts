/**
 * Read a handler's own clock back out of the project predicate it built
 * (Fizzy #2615).
 *
 * WHY ANY OF THIS EXISTS. The to-do procedures take `now` from their own
 * request rather than from a parameter, and several suites assert a handler
 * passed the SAME instant to the predicate that it used elsewhere. The only
 * place that instant survives into something a test can see is the membership
 * arm's `expiresAt: { gt: now }`, so the suites recover it from there.
 *
 * WHY IT IS SHARED, AND WHY IT SEARCHES RATHER THAN INDEXES. Four suites were
 * doing this by hand and three of them hard-coded a position —
 * `where.OR[0].members…` in two, `where.OR[1].members…` in a third. Those
 * indices were each correct for the one predicate that suite happened to be
 * looking at: `organizationProjectWhere` puts its membership arm first, and
 * `openableProjectWhere` puts it second, behind the creator arm. So the tests
 * were coupled to the ARM ORDER of a predicate in another file, and the two
 * spellings had already drifted apart in the same change that introduced them.
 *
 * That is the dangerous kind of coupling for an authorization suite. Reordering
 * the arms in `../../lib/visibility.ts` would not fail these tests loudly; it
 * would silently point them at the wrong arm, where `?.` returns `undefined`
 * and the assertion fails for a reason that has nothing to do with the
 * regression — or, if the arms ever happen to line up, passes while checking
 * nothing. A test that can quietly stop testing is worse than no test, because
 * it goes on reporting confidence it is no longer earning.
 *
 * Finding the arm by its SHAPE removes the coupling entirely: whichever
 * position the membership arm occupies, and whichever of the two predicates
 * built it, this reads the same instant.
 */

import { expect } from "vitest";

/** Prisma's `ProjectWhereInput` as these assertions need to walk it. */
type PredicateArm = {
	members?: {
		some?: { OR?: Array<{ expiresAt?: { gt?: Date } }> };
	};
};

/**
 * The `now` a handler passed to `organizationProjectWhere` or
 * `openableProjectWhere`.
 *
 * Asserts it found a Date, so a caller that changed shape fails here with a
 * clear message rather than propagating `undefined` into a comparison that
 * reads as an unrelated failure.
 */
export function clockFromProjectPredicate(where: unknown): Date {
	const arms = ((where as { OR?: PredicateArm[] } | undefined)?.OR ??
		[]) as PredicateArm[];
	// By shape, never by position — see the header.
	const membershipArm = arms.find((arm) => arm.members);
	const now = membershipArm?.members?.some?.OR?.find(
		(clause) => clause.expiresAt?.gt,
	)?.expiresAt?.gt;

	expect(
		now,
		"expected the project predicate to carry a membership arm with an expiry clock",
	).toBeInstanceOf(Date);
	return now as Date;
}
