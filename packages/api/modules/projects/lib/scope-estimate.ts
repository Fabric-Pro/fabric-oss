/**
 * Scope estimate roll-up (plan Slice 7).
 *
 * Pure aggregation over the project's features: one row per story, grouped
 * by phase (`phase:N` label, else "unassigned") and by delivery track, with
 * point totals per group. A group that contains any LOW-confidence row is
 * reported as a range `min–max` where `min` is the sum of the non-LOW points
 * and `max` the sum of all points; SPIKE lines default to LOW until a spike
 * run is accepted, so a phase with an open spike always shows as a range.
 *
 * No database access here — `exportScopeEstimate` loads the rows and calls
 * `buildScopeEstimate` + one of the renderers.
 */

const PHASE_LABEL_PREFIX = "phase:";
const UNASSIGNED_PHASE = "unassigned";

type EstimateConfidenceValue = "LOW" | "MEDIUM" | "HIGH";

export interface ScopeEstimateStoryInput {
	identifier: string;
	title: string;
	sourceRef?: string | null;
	labels?: readonly string[] | null;
	deliveryTrack?: string | null;
	priority?: string | null;
	size?: string | null;
	storyPoints?: number | null;
	estimateConfidence?: EstimateConfidenceValue | null;
	dependsOnPhases?: readonly string[] | null;
	dependsOnRefs?: readonly string[] | null;
}

interface ScopeEstimateRow {
	sourceRef: string;
	identifier: string;
	title: string;
	phase: string;
	track: string;
	priority: string;
	size: string;
	points: number | null;
	confidence: EstimateConfidenceValue | "";
	dependsOnPhases: string[];
	dependsOnRefs: string[];
}

export interface PointTotals {
	/** Sum of every row's points. */
	points: number;
	/** Sum of the non-LOW rows' points (the floor of the range). */
	confidentPoints: number;
	/** True when at least one row is LOW confidence. */
	hasLowConfidence: boolean;
	rowCount: number;
	/** Rows that carry no points at all (never counted). */
	unestimatedCount: number;
}

interface ScopeEstimateGroup {
	key: string;
	rows: ScopeEstimateRow[];
	totals: PointTotals;
}

export interface ScopeEstimate {
	rows: ScopeEstimateRow[];
	/** Ordered: quoted phases first (in the project's order), then the rest, then "unassigned". */
	byPhase: ScopeEstimateGroup[];
	/** Ordered by `TRACK_ORDER`; empty tracks are omitted. */
	byTrack: ScopeEstimateGroup[];
	totals: PointTotals;
}

const TRACK_ORDER = [
	"SPIKE",
	"DISCOVERY",
	"SPECIFY",
	"UNCLASSIFIED",
	"DEFER",
] as const;

/** Read the phase from a `phase:N` label. Returns `null` when none is set. */
export function phaseFromLabels(
	labels: readonly string[] | null | undefined,
): string | null {
	for (const label of labels ?? []) {
		if (label.startsWith(PHASE_LABEL_PREFIX)) {
			const phase = label.slice(PHASE_LABEL_PREFIX.length).trim();
			if (phase.length > 0) {
				return phase;
			}
		}
	}
	return null;
}

/**
 * Stable phase ordering: the project's quoted phases first (in their
 * configured order), then any other phase numerically / lexically, and
 * `unassigned` always last.
 */
export function orderPhases(
	phases: Iterable<string>,
	quotedPhases: readonly string[] = [],
): string[] {
	const seen = new Set<string>();
	const ordered: string[] = [];
	for (const phase of quotedPhases) {
		if (!seen.has(phase)) {
			seen.add(phase);
			ordered.push(phase);
		}
	}
	const rest: string[] = [];
	let hasUnassigned = false;
	for (const phase of phases) {
		if (phase === UNASSIGNED_PHASE) {
			hasUnassigned = true;
			continue;
		}
		if (!seen.has(phase)) {
			seen.add(phase);
			rest.push(phase);
		}
	}
	rest.sort(comparePhaseKeys);
	ordered.push(...rest);
	if (hasUnassigned) {
		ordered.push(UNASSIGNED_PHASE);
	}
	return ordered;
}

function comparePhaseKeys(a: string, b: string): number {
	const na = Number(a);
	const nb = Number(b);
	const aNum = Number.isFinite(na);
	const bNum = Number.isFinite(nb);
	if (aNum && bNum) {
		return na - nb;
	}
	if (aNum) {
		return -1;
	}
	if (bNum) {
		return 1;
	}
	return a.localeCompare(b);
}

function emptyTotals(): PointTotals {
	return {
		points: 0,
		confidentPoints: 0,
		hasLowConfidence: false,
		rowCount: 0,
		unestimatedCount: 0,
	};
}

function accumulateTotals(
	totals: PointTotals,
	row: Pick<ScopeEstimateRow, "points" | "confidence">,
): PointTotals {
	totals.rowCount += 1;
	if (row.confidence === "LOW") {
		totals.hasLowConfidence = true;
	}
	if (row.points == null) {
		totals.unestimatedCount += 1;
		return totals;
	}
	totals.points += row.points;
	if (row.confidence !== "LOW") {
		totals.confidentPoints += row.points;
	}
	return totals;
}

/** `12` for a confident group, `8–12` when any LOW row is present. */
export function formatPointTotals(totals: PointTotals): string {
	if (totals.hasLowConfidence && totals.confidentPoints !== totals.points) {
		return `${totals.confidentPoints}–${totals.points}`;
	}
	if (totals.hasLowConfidence) {
		// Every point sits on a LOW row (or the LOW rows are unestimated):
		// still a range, floor is what we are sure of.
		return `${totals.confidentPoints}–${totals.points}`;
	}
	return String(totals.points);
}

function toScopeEstimateRow(story: ScopeEstimateStoryInput): ScopeEstimateRow {
	return {
		sourceRef: story.sourceRef ?? "",
		identifier: story.identifier,
		title: story.title,
		phase: phaseFromLabels(story.labels) ?? UNASSIGNED_PHASE,
		track: story.deliveryTrack ?? "UNCLASSIFIED",
		priority: story.priority ?? "",
		size: story.size ?? "",
		points:
			typeof story.storyPoints === "number" ? story.storyPoints : null,
		// A SPIKE row that was never estimated is LOW by definition, so the
		// phase total becomes a range (review sprint3 #5).
		confidence:
			story.estimateConfidence ??
			(story.deliveryTrack === "SPIKE" ? "LOW" : ""),
		dependsOnPhases: [...(story.dependsOnPhases ?? [])],
		dependsOnRefs: [...(story.dependsOnRefs ?? [])],
	};
}

function compareRows(
	a: ScopeEstimateRow,
	b: ScopeEstimateRow,
	phaseIndex: ReadonlyMap<string, number>,
): number {
	const pa = phaseIndex.get(a.phase) ?? Number.MAX_SAFE_INTEGER;
	const pb = phaseIndex.get(b.phase) ?? Number.MAX_SAFE_INTEGER;
	if (pa !== pb) {
		return pa - pb;
	}
	// Rows with a sourceRef sort before rows without one, then by ref.
	if (a.sourceRef !== b.sourceRef) {
		if (!a.sourceRef) {
			return 1;
		}
		if (!b.sourceRef) {
			return -1;
		}
		return a.sourceRef.localeCompare(b.sourceRef, undefined, {
			numeric: true,
		});
	}
	return a.identifier.localeCompare(b.identifier, undefined, {
		numeric: true,
	});
}

export function buildScopeEstimate(
	stories: readonly ScopeEstimateStoryInput[],
	quotedPhases: readonly string[] = [],
): ScopeEstimate {
	const rows = stories.map(toScopeEstimateRow);
	const phases = orderPhases(
		rows.map((r) => r.phase),
		quotedPhases,
	);
	const phaseIndex = new Map(phases.map((p, i) => [p, i] as const));
	rows.sort((a, b) => compareRows(a, b, phaseIndex));

	const byPhaseMap = new Map<string, ScopeEstimateGroup>();
	const byTrackMap = new Map<string, ScopeEstimateGroup>();
	const totals = emptyTotals();

	for (const row of rows) {
		accumulateTotals(totals, row);
		let phaseGroup = byPhaseMap.get(row.phase);
		if (!phaseGroup) {
			phaseGroup = { key: row.phase, rows: [], totals: emptyTotals() };
			byPhaseMap.set(row.phase, phaseGroup);
		}
		phaseGroup.rows.push(row);
		accumulateTotals(phaseGroup.totals, row);

		let trackGroup = byTrackMap.get(row.track);
		if (!trackGroup) {
			trackGroup = { key: row.track, rows: [], totals: emptyTotals() };
			byTrackMap.set(row.track, trackGroup);
		}
		trackGroup.rows.push(row);
		accumulateTotals(trackGroup.totals, row);
	}

	const byPhase = phases
		.map((p) => byPhaseMap.get(p))
		.filter((g): g is ScopeEstimateGroup => g !== undefined);
	const trackRank = new Map(TRACK_ORDER.map((t, i) => [t, i] as const));
	const byTrack = [...byTrackMap.values()].sort(
		(a, b) =>
			(trackRank.get(a.key as (typeof TRACK_ORDER)[number]) ?? 99) -
			(trackRank.get(b.key as (typeof TRACK_ORDER)[number]) ?? 99),
	);

	return { rows, byPhase, byTrack, totals };
}

// ---------------------------------------------------------------------------
// Renderers
// ---------------------------------------------------------------------------

const SCOPE_ESTIMATE_COLUMNS = [
	"sourceRef",
	"identifier",
	"title",
	"phase",
	"track",
	"priority",
	"size",
	"points",
	"confidence",
	"dependsOnPhases",
	"dependsOnRefs",
] as const;

function phaseHeading(phase: string): string {
	return phase === UNASSIGNED_PHASE ? "Unassigned" : `Phase ${phase}`;
}

function trackHeading(track: string): string {
	return track.charAt(0) + track.slice(1).toLowerCase();
}

function cellValue(
	row: ScopeEstimateRow,
	column: (typeof SCOPE_ESTIMATE_COLUMNS)[number],
): string {
	const value = row[column];
	if (Array.isArray(value)) {
		return value.join(" ");
	}
	if (value == null) {
		return "";
	}
	return String(value);
}

/** RFC 4180: quote when the value contains a comma, quote, CR or LF; double inner quotes. */
export function escapeCsvCell(value: string): string {
	if (/[",\r\n]/.test(value)) {
		return `"${value.replaceAll('"', '""')}"`;
	}
	return value;
}

export function renderScopeEstimateCsv(estimate: ScopeEstimate): string {
	const lines: string[] = [SCOPE_ESTIMATE_COLUMNS.join(",")];
	for (const row of estimate.rows) {
		lines.push(
			SCOPE_ESTIMATE_COLUMNS.map((c) =>
				escapeCsvCell(cellValue(row, c)),
			).join(","),
		);
	}
	// Totals block at the end so the row section stays machine-readable.
	lines.push("");
	lines.push("group,key,rows,points,confidentPoints,range");
	for (const group of estimate.byPhase) {
		lines.push(
			[
				"phase",
				escapeCsvCell(group.key),
				String(group.totals.rowCount),
				String(group.totals.points),
				String(group.totals.confidentPoints),
				escapeCsvCell(formatPointTotals(group.totals)),
			].join(","),
		);
	}
	for (const group of estimate.byTrack) {
		lines.push(
			[
				"track",
				escapeCsvCell(group.key),
				String(group.totals.rowCount),
				String(group.totals.points),
				String(group.totals.confidentPoints),
				escapeCsvCell(formatPointTotals(group.totals)),
			].join(","),
		);
	}
	lines.push(
		[
			"total",
			"",
			String(estimate.totals.rowCount),
			String(estimate.totals.points),
			String(estimate.totals.confidentPoints),
			escapeCsvCell(formatPointTotals(estimate.totals)),
		].join(","),
	);
	return `${lines.join("\n")}\n`;
}

function mdCell(value: string): string {
	return value.replaceAll("|", "\\|").replaceAll(/\r?\n/g, " ");
}

export function renderScopeEstimateMarkdown(
	estimate: ScopeEstimate,
	options: { projectName?: string; generatedAt?: Date } = {},
): string {
	const out: string[] = [];
	const title = options.projectName
		? `# Scope estimate — ${options.projectName}`
		: "# Scope estimate";
	out.push(title, "");
	if (options.generatedAt) {
		out.push(`_Generated ${options.generatedAt.toISOString()}_`, "");
	}
	out.push(
		`**${estimate.totals.rowCount} items · ${formatPointTotals(estimate.totals)} points**${
			estimate.totals.hasLowConfidence
				? " (range: low-confidence items counted only in the upper bound)"
				: ""
		}`,
		"",
	);

	out.push("## Totals by phase", "");
	out.push("| Phase | Items | Points | Low confidence |");
	out.push("| --- | ---: | ---: | :---: |");
	for (const group of estimate.byPhase) {
		out.push(
			`| ${phaseHeading(group.key)} | ${group.totals.rowCount} | ${formatPointTotals(group.totals)} | ${group.totals.hasLowConfidence ? "yes" : "no"} |`,
		);
	}
	out.push("");

	out.push("## Totals by track", "");
	out.push("| Track | Items | Points | Low confidence |");
	out.push("| --- | ---: | ---: | :---: |");
	for (const group of estimate.byTrack) {
		out.push(
			`| ${trackHeading(group.key)} | ${group.totals.rowCount} | ${formatPointTotals(group.totals)} | ${group.totals.hasLowConfidence ? "yes" : "no"} |`,
		);
	}
	out.push("");

	for (const group of estimate.byPhase) {
		out.push(
			`## ${phaseHeading(group.key)} — ${formatPointTotals(group.totals)} points across ${group.totals.rowCount} items`,
			"",
		);
		out.push(
			"| Ref | ID | Title | Track | Priority | Size | Points | Confidence | Depends on phases | Depends on refs |",
		);
		out.push(
			"| --- | --- | --- | --- | --- | --- | ---: | --- | --- | --- |",
		);
		for (const row of group.rows) {
			out.push(
				`| ${mdCell(row.sourceRef)} | ${mdCell(row.identifier)} | ${mdCell(row.title)} | ${mdCell(row.track)} | ${mdCell(row.priority)} | ${mdCell(row.size)} | ${row.points ?? ""} | ${row.confidence} | ${mdCell(row.dependsOnPhases.join(" "))} | ${mdCell(row.dependsOnRefs.join(" "))} |`,
			);
		}
		out.push("");
	}

	return `${out.join("\n").trimEnd()}\n`;
}

export function scopeEstimateFilename(
	projectName: string | null | undefined,
	format: "markdown" | "csv",
	now: Date = new Date(),
): string {
	const slug =
		(projectName ?? "project")
			.toLowerCase()
			.replace(/[^a-z0-9]+/g, "-")
			.replace(/^-+|-+$/g, "")
			.slice(0, 40) || "project";
	const date = now.toISOString().slice(0, 10);
	return `scope-estimate-${slug}-${date}.${format === "csv" ? "csv" : "md"}`;
}
