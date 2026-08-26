import { createHash } from "node:crypto";

/**
 * Stable identity for a test failure — the "fingerprint" the QA capability mocks
 * show on every finding (screen C1, "Failures & Findings").
 *
 * The problem it solves: the same broken assertion recurs on every CI run, and
 * without an identity each occurrence looks new. Today's RCA sidesteps this by
 * deduping on `originTestCaseId` + a non-terminal bug, which works only because
 * one case maps to one bug — it cannot group two DIFFERENT failures of the same
 * case, and it cannot recognise the same failure arriving from a different case
 * or provider.
 *
 * A fingerprint has to be stable across runs but sensitive to the failure
 * actually changing, so it is computed from the parts of a failure that identify
 * it rather than the parts that vary:
 *
 *  - test name and classname — WHAT broke
 *  - the failure message, NORMALISED — WHY it broke
 *
 * and deliberately NOT from: the run id, timestamps, durations, or the machine
 * the job ran on, all of which differ on every execution of the same fault.
 *
 * Message normalisation is where the care goes. A stack trace embeds absolute
 * paths, line numbers, hex addresses and object ids that shift between runs
 * while describing the identical fault; leaving them in produces a "new" finding
 * every night. See {@link normaliseFailureMessage}.
 *
 * Pure and dependency-free so the grouping rule is unit-testable without a run.
 */

/** How much of the message contributes — enough to distinguish, bounded. */
const MAX_MESSAGE_CHARS = 400;

/**
 * Strip the parts of a failure message that change between runs of the SAME
 * fault: absolute paths, line/column numbers, hex addresses, uuids, ISO
 * timestamps and bare digits. Aggressive on purpose — an over-general
 * fingerprint groups two related failures, which a human can split; an
 * over-specific one produces a fresh finding every night, which nobody reads.
 */
export function normaliseFailureMessage(message: string): string {
	return (
		message
			.replace(/\r\n/g, "\n")
			// Windows and POSIX absolute paths → a placeholder, keeping the basename.
			.replace(/(?:[A-Za-z]:)?[\\/][^\s:()]*[\\/]([\w.-]+)/g, "<path>/$1")
			// :12:34 line/column suffixes.
			.replace(/:\d+:\d+/g, ":<pos>")
			// 0x… addresses and long hex blobs (object ids, hashes).
			.replace(/\b0x[0-9a-f]+\b/gi, "<addr>")
			.replace(/\b[0-9a-f]{8,}\b/gi, "<hash>")
			// UUIDs and ISO timestamps.
			.replace(
				/\b[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}\b/gi,
				"<uuid>",
			)
			.replace(/\d{4}-\d{2}-\d{2}T[\d:.]+Z?/g, "<time>")
			// Remaining bare numbers: run counts, ports, elapsed ms.
			.replace(/\b\d+(?:\.\d+)?(?:ms|s)?\b/g, "<n>")
			.replace(/\s+/g, " ")
			.trim()
			.toLowerCase()
			.slice(0, MAX_MESSAGE_CHARS)
	);
}

export interface FingerprintInput {
	/** The automated test's name. */
	testName: string;
	/** Its suite/class/file, when the provider reported one. */
	classname?: string | null;
	/** The assertion or error text, when the provider reported one. */
	failureMessage?: string | null;
}

/**
 * A short, stable hex digest identifying this failure.
 *
 * Truncated to 16 chars: this is a grouping key shown to humans (the mocks
 * render `fingerprint: a93f…2e1`), not a security primitive, and 64 bits is far
 * beyond the collision risk of one project's failure set.
 */
export function fingerprintFinding(input: FingerprintInput): string {
	const parts = [
		input.classname?.trim().toLowerCase() ?? "",
		input.testName.trim().toLowerCase(),
		// A failure with no message still fingerprints — by identity alone, so
		// run-level-only ingests (a provider that reported no per-test detail)
		// still group rather than each becoming a new finding.
		input.failureMessage
			? normaliseFailureMessage(input.failureMessage)
			: "",
	];
	return createHash("sha256")
		.update(parts.join("\0"))
		.digest("hex")
		.slice(0, 16);
}
