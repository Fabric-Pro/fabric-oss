/**
 * The name of a member's proposal branch (member proposal branch spec
 * Decision 3): `fabric/instructions/members/<slug>-<id4>/<n>`.
 *
 * Pure and shared by the API (reservation at admission) and Temporal, so both
 * derive the same candidate. A candidate is only a candidate: the permanent
 * reservation row, unique on `(repositoryKey, ref)`, is what makes a ref a
 * member's, and a refused or retired reservation is never reissued.
 *
 * The `members/` segment keeps these refs disjoint from #2563's per-proposal
 * `fabric/instructions/<cuid>` refs.
 *
 * Exported as the `@repo/instructions/proposal-branch-ref` subpath, not from
 * the package barrel: it hashes with `node:crypto`, and browser code imports
 * the barrel.
 */
import { createHash } from "node:crypto";
import { normaliseName, unsafeName } from "./pull-request-text";

/** Every member branch ref, exactly (plan Global Constraints). */
export const MEMBER_BRANCH_PATTERN =
	/^fabric\/instructions\/members\/[a-z0-9]+(?:-[a-z0-9]+)*-[0-9a-z]{4}\/[1-9][0-9]{0,5}$/;

export const MEMBER_BRANCH_SLUG_FALLBACK = "member";
export const MEMBER_BRANCH_SLUG_MAX = 40;
export const MEMBER_BRANCH_NUMBER_MAX = 999_999;

/**
 * The display name after the #2563 §5.2 normalisation and fallback,
 * lowercased and reduced to `[a-z0-9-]` (runs collapsed, ends trimmed), at
 * most 40 characters. An unsafe or empty name becomes `member`.
 */
export function memberBranchSlug(
	displayName: string | null | undefined,
): string {
	const normalised = normaliseName(displayName ?? "");
	if (unsafeName(normalised)) {
		return MEMBER_BRANCH_SLUG_FALLBACK;
	}
	const slug = normalised
		.toLowerCase()
		.replace(/[^a-z0-9]+/g, "-")
		.replace(/^-+|-+$/g, "")
		.slice(0, MEMBER_BRANCH_SLUG_MAX)
		.replace(/-+$/, "");
	return slug === "" ? MEMBER_BRANCH_SLUG_FALLBACK : slug;
}

/**
 * The first four base-36 characters of sha256(userId), read as a big-endian
 * unsigned integer. Stable per member; it separates two members whose names
 * normalise to the same slug in the common case, and the reservation handles
 * the rest.
 */
export function memberBranchId4(userId: string): string {
	const hex = createHash("sha256").update(userId, "utf8").digest("hex");
	return BigInt(`0x${hex}`).toString(36).padStart(4, "0").slice(0, 4);
}

export function memberBranchRef(input: {
	displayName: string | null | undefined;
	userId: string;
	n: number;
}): string {
	if (
		!Number.isInteger(input.n) ||
		input.n < 1 ||
		input.n > MEMBER_BRANCH_NUMBER_MAX
	) {
		throw new RangeError(
			`A member branch number must be an integer in 1..${MEMBER_BRANCH_NUMBER_MAX}`,
		);
	}
	const ref = `fabric/instructions/members/${memberBranchSlug(input.displayName)}-${memberBranchId4(input.userId)}/${input.n}`;
	if (!MEMBER_BRANCH_PATTERN.test(ref)) {
		throw new Error(
			"A derived member branch ref does not match its pattern",
		);
	}
	return ref;
}
