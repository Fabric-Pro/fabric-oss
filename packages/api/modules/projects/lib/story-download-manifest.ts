/**
 * Pure helper to build the `MANIFEST.txt` payload shipped inside the bulk
 * feature-export ZIP from
 * `projects.stories.createStoriesBatchDownloadUrl`.
 *
 * Mirrors the format used by `context-download-manifest.ts` so users see a
 * consistent layout across the contexts and stories batch downloads. No I/O.
 */

/** Stable reasons recorded against a skipped feature in the manifest. */
type StorySkipReason = "INSUFFICIENT_CONTENT" | "NOT_FOUND_OR_NO_PERMISSION";

export interface StoryManifestIncludedRow {
	storyId: string;
	identifier: string;
	filename: string;
}

export interface StoryManifestSkippedRow {
	storyId: string;
	identifier: string | null;
	reason: StorySkipReason;
}

export interface BuildStoryDownloadManifestArgs {
	project: { id: string; name: string };
	exportedAt: Date;
	exportedBy: { id: string; email: string };
	included: ReadonlyArray<StoryManifestIncludedRow>;
	skipped: ReadonlyArray<StoryManifestSkippedRow>;
}

const COL_INDEX = 3;
const COL_IDENT = 12;
const COL_FILE = 48;

/** Format an ISO 8601 UTC timestamp with the `Z` suffix (no millis). */
function formatIsoUtc(date: Date): string {
	return `${date.toISOString().replace(/\.\d{3}Z$/, "Z")}`;
}

/** Pad a string on the right; allow overflow for long titles / identifiers. */
function padRightAllowOverflow(value: string, width: number): string {
	if (value.length >= width) {
		return value;
	}
	return value.padEnd(width, " ");
}

function formatIndex(index: number): string {
	const display = index.toString().padStart(2, "0");
	return padRightAllowOverflow(display, COL_INDEX);
}

/**
 * Map the stable `StorySkipReason` enum to the user-facing English copy
 * shown in the manifest. The i18n keys
 * `projects.stories.download.manifest.reason.*` mirror these strings, but
 * the manifest itself is plain English (one source of truth at upload time).
 */
function reasonLabel(reason: StorySkipReason): string {
	switch (reason) {
		case "INSUFFICIENT_CONTENT":
			return "SKIPPED — insufficient content";
		case "NOT_FOUND_OR_NO_PERMISSION":
			return "SKIPPED — feature not found or access denied";
	}
}

function renderIncludedRow(
	row: StoryManifestIncludedRow,
	index: number,
): string {
	return (
		`${formatIndex(index)} ` +
		`${padRightAllowOverflow(row.identifier, COL_IDENT)} ` +
		`${padRightAllowOverflow(row.filename, COL_FILE)} ` +
		row.storyId
	);
}

function renderSkippedRow(row: StoryManifestSkippedRow, index: number): string {
	const ident = row.identifier ?? "-";
	return (
		`${formatIndex(index)} ` +
		`${padRightAllowOverflow(ident, COL_IDENT)} ` +
		`${padRightAllowOverflow(row.storyId, COL_FILE)} ` +
		reasonLabel(row.reason)
	);
}

/**
 * Build a `MANIFEST.txt` payload for a stories bulk export. Pure — every
 * row sourced from `args`. The trailing newline is intentional (POSIX
 * friendliness, mirrors `context-download-manifest.ts`).
 */
export function buildStoryDownloadManifest(
	args: BuildStoryDownloadManifestArgs,
): string {
	const lines: string[] = [];
	lines.push("Fabric — Feature Export");
	lines.push(`Project       : ${args.project.name}`);
	lines.push(`Project ID    : ${args.project.id}`);
	lines.push(`Exported at   : ${formatIsoUtc(args.exportedAt)}`);
	lines.push(
		`Exported by   : ${args.exportedBy.id} (${args.exportedBy.email})`,
	);
	lines.push(
		`Feature count : ${args.included.length} included, ${args.skipped.length} skipped`,
	);
	lines.push("");

	lines.push(`--- INCLUDED (${args.included.length}) ---`);
	lines.push(
		"#   IDENTIFIER   FILE IN ZIP                                      STORY ID",
	);
	args.included.forEach((row, i) => {
		lines.push(renderIncludedRow(row, i + 1));
	});

	if (args.skipped.length > 0) {
		lines.push("");
		lines.push(`--- SKIPPED (${args.skipped.length}) ---`);
		lines.push(
			"#   IDENTIFIER   STORY ID                                         REASON",
		);
		args.skipped.forEach((row, i) => {
			lines.push(renderSkippedRow(row, i + 1));
		});
	}

	return `${lines.join("\n")}\n`;
}
