/**
 * Pure helper to build the `MANIFEST.txt` payload shipped inside the batch
 * context ZIP and — in abbreviated form — alongside synthesized single-file
 * downloads. See spec §4.6 and §13.1 in
 * `docs/specs/2026-04-15-download-project-context-files/spec.md`.
 *
 * English-only, plain UTF-8, fixed 3 / 14 / 40 / rest column layout. No I/O.
 */

/** Stable, human-readable reasons for skipping a context during export. */
export type SkipReason =
	| "Source object not found in storage"
	| "Storage read failed"
	| "Context not ready"
	| "Content unavailable";

export interface ManifestIncludedRow {
	type: string;
	title: string;
	fileInZip: string;
}

export interface ManifestSkippedRow {
	type: string;
	title: string;
	reason: SkipReason;
}

type ManifestTenant =
	| { kind: "org"; id: string; name: string }
	| { kind: "personal" };

export interface BuildContextDownloadManifestArgs {
	project: { id: string; name: string };
	tenant: ManifestTenant;
	exportedAt: Date;
	exportedBy: { id: string; email: string };
	included: ReadonlyArray<ManifestIncludedRow>;
	skipped: ReadonlyArray<ManifestSkippedRow>;
	totalBytes: number;
}

/** Fixed column widths for the INCLUDED / SKIPPED tables. */
const COL_INDEX = 3;
const COL_TYPE = 14;
const COL_TITLE = 40;

/** Format an ISO 8601 UTC timestamp with the `Z` suffix. */
function formatIsoUtc(date: Date): string {
	// Drop milliseconds for stable, human-friendly output — spec example uses
	// second precision.
	return `${date.toISOString().replace(/\.\d{3}Z$/, "Z")}`;
}

/** Human-readable byte size (IEC-ish), used for the manifest total line. */
function humanReadableBytes(bytes: number): string {
	if (bytes < 1024) {
		return `${bytes} B`;
	}
	const kb = bytes / 1024;
	if (kb < 1024) {
		return `${kb.toFixed(1)} KB`;
	}
	const mb = kb / 1024;
	if (mb < 1024) {
		return `${mb.toFixed(1)} MB`;
	}
	const gb = mb / 1024;
	return `${gb.toFixed(1)} GB`;
}

/**
 * Pad a string on the right to the given width. If `value` exceeds `width`,
 * it is returned verbatim (overflow is allowed per spec §4.6: "Long titles
 * may overflow their column; titles are never truncated in the manifest").
 */
function padRightAllowOverflow(value: string, width: number): string {
	if (value.length >= width) {
		return value;
	}
	return value.padEnd(width, " ");
}

/** Format a 1-based row index as a zero-padded 2-digit string + trailing space. */
function formatIndex(index: number): string {
	const display = index.toString().padStart(2, "0");
	// COL_INDEX is 3 to accommodate the trailing space separator.
	return padRightAllowOverflow(display, COL_INDEX);
}

function renderTenantLine(tenant: ManifestTenant): string {
	if (tenant.kind === "personal") {
		return "Personal";
	}
	return `${tenant.id} (${tenant.name})`;
}

function renderIncludedRow(row: ManifestIncludedRow, index: number): string {
	return (
		formatIndex(index) +
		" " +
		padRightAllowOverflow(row.type, COL_TYPE) +
		" " +
		padRightAllowOverflow(row.title, COL_TITLE) +
		" " +
		row.fileInZip
	);
}

function renderSkippedRow(row: ManifestSkippedRow, index: number): string {
	return (
		formatIndex(index) +
		" " +
		padRightAllowOverflow(row.type, COL_TYPE) +
		" " +
		padRightAllowOverflow(row.title, COL_TITLE) +
		" " +
		row.reason
	);
}

/**
 * Build a `MANIFEST.txt` payload for a project contexts export. Pure — all
 * state lives in the returned string.
 */
export function buildContextDownloadManifest(
	args: BuildContextDownloadManifestArgs,
): string {
	const lines: string[] = [];
	lines.push("Fabric — Project Contexts Export");
	lines.push(`Project       : ${args.project.name}`);
	lines.push(`Project ID    : ${args.project.id}`);
	lines.push(`Exported at   : ${formatIsoUtc(args.exportedAt)}`);
	lines.push(
		`Exported by   : ${args.exportedBy.id} (${args.exportedBy.email})`,
	);
	lines.push(`Tenant        : ${renderTenantLine(args.tenant)}`);
	lines.push(
		`Context count : ${args.included.length} included, ${args.skipped.length} skipped`,
	);
	lines.push(`Total size    : ${humanReadableBytes(args.totalBytes)}`);
	lines.push("");

	lines.push(`--- INCLUDED (${args.included.length}) ---`);
	lines.push(
		"#   TYPE           TITLE                                   FILE IN ZIP",
	);
	args.included.forEach((row, i) => {
		lines.push(renderIncludedRow(row, i + 1));
	});

	if (args.skipped.length > 0) {
		lines.push("");
		lines.push(`--- SKIPPED (${args.skipped.length}) ---`);
		lines.push(
			"#   TYPE           TITLE                                   REASON",
		);
		args.skipped.forEach((row, i) => {
			lines.push(renderSkippedRow(row, i + 1));
		});
	}

	// Trailing newline for POSIX friendliness.
	return `${lines.join("\n")}\n`;
}
