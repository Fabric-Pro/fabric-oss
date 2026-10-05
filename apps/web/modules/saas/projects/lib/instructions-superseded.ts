import type { InstructionsSnapshot } from "./instructions-snapshot";

/**
 * An edit that passed its checks but did NOT publish, because the version
 * it was made from stopped being the published one while it was being
 * checked, or null. The auto-publish is a fast-forward for exactly this reason
 * (`publishInstructionSnapshot`, `requireBaseUnmoved`): publishing it
 * would have reverted whoever got there first, whose change this edit
 * never saw. The edit itself is intact and sits in History.
 *
 * `baseVersion` is what makes this an EDIT — `baseSnapshotId` is null
 * once the base has been deleted or pruned, which is one of the ways the
 * fast-forward is refused and precisely the case with nothing else to
 * explain it.
 *
 * Deliberately only about the NEWEST row. If the two edits finish out of
 * version order the stranded one is not the newest and says nothing here
 * — History still shows it as an unpublished version, which is the
 * durable answer; this line is the cheap one for the ordinary case.
 *
 * `publishedAt == null` is what keeps a ROLLBACK out of this line. After
 * a rollback from v9 to v7, v9 is still the newest READY row, is still
 * newer than the pointer, and its base is no longer published — every
 * condition above holds — but it was not stranded: it published, and a
 * person deliberately replaced it. Telling them it "was not published"
 * would be false, and would invite them to re-publish something they had
 * just chosen to leave behind.
 */
export function supersededEdit(input: {
	newest: InstructionsSnapshot | null;
	published: InstructionsSnapshot | null;
	newerThanPublished: boolean;
}): { version: number; baseVersion: number } | null {
	const { newest, published, newerThanPublished } = input;
	const candidate =
		newest &&
		newest.status === "READY" &&
		newerThanPublished &&
		newest.publishOnReady !== false &&
		typeof newest.baseVersion === "number" &&
		newest.baseSnapshotId !== published?.id
			? newest
			: null;
	return candidate &&
		(candidate.publishedAt ?? null) === null &&
		typeof candidate.baseVersion === "number"
		? { version: candidate.version, baseVersion: candidate.baseVersion }
		: null;
}
