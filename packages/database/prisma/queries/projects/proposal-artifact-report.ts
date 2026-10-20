/**
 * Proposal artifact (Fizzy #2946) — the analysis report a run stores beside
 * its findings: a versioned object of structured fields in `report`, and the
 * report text in `reportText`.
 *
 * `report` decides whether a run has a report, and `reportText` is never set
 * without it. Both are written only by the run's completion
 * (`completeAnalysisRun`, which normalises the report here so no caller can
 * skip it) and read only by {@link getAnalysisReport}. No other select names
 * them, so they never reach the settled-decisions builder, a re-run's prompt,
 * the activity result, an SSE payload, audit metadata or a log line.
 */

import { cutAtCodeUnits } from "@repo/utils/cut-at-code-units";
import {
	cutReportText,
	REPORT_TEXT_MAX_CODE_UNITS,
	reportTextNeedsPlainText,
} from "@repo/utils/proposal-artifact/report-text";
import { z } from "zod";
import { db, type Prisma } from "../../client";
import { sanitizeContent } from "./documents";
import { MAX_SOURCE_NUMBER } from "./proposal-artifact-source-manifest";

export type ProposalReportPriority = "MUST" | "SHOULD" | "COULD";
export const PROPOSAL_REPORT_PRIORITIES = [
	"MUST",
	"SHOULD",
	"COULD",
] as const satisfies readonly ProposalReportPriority[];

/** Longest assessment kept; stored as written, never as an enum. */
export const PROPOSAL_REPORT_ASSESSMENT_MAX_LENGTH = 120;
export const PROPOSAL_REPORT_SUMMARY_MAX_LENGTH = 2000;
/** Most scope items kept; later ones are dropped. */
export const PROPOSAL_REPORT_SCOPE_MAX_ITEMS = 40;
export const PROPOSAL_REPORT_SCOPE_ITEM_MAX_LENGTH = 300;
export const PROPOSAL_REPORT_SCOPE_IN_PROPOSAL_MAX_LENGTH = 40;
export const PROPOSAL_REPORT_SCOPE_NOTE_MAX_LENGTH = 600;
/** Most entries kept in each of the before-sending and discovery lists. */
export const PROPOSAL_REPORT_LIST_MAX_ENTRIES = 30;
export const PROPOSAL_REPORT_LIST_ENTRY_MAX_LENGTH = 500;
/** Most cited source numbers kept: the lowest ones. */
export const PROPOSAL_REPORT_MAX_SOURCES = 50;
/** Longest report text kept, in UTF-16 code units. */
export const PROPOSAL_REPORT_TEXT_MAX_CODE_UNITS = REPORT_TEXT_MAX_CODE_UNITS;

export interface ProposalAnalysisReportScopeItem {
	item: string;
	priority: ProposalReportPriority | null;
	inProposal: string;
	note: string;
}

/** A report as the analysis worker hands it to the completion. */
export interface ProposalAnalysisReportInput {
	assessment: string;
	summary: string;
	scope: ProposalAnalysisReportScopeItem[];
	beforeSending: string[];
	duringDiscovery: string[];
	/** Cited source numbers, already filtered to the run's citable ones. */
	sources: number[];
	/**
	 * The report text as written; the worker may already have cut it, and the
	 * normaliser cuts it again to the stored cap either way.
	 */
	text: string;
	/** The worker cut the text, or the report call stopped on its output limit. */
	textTruncated: boolean;
	/**
	 * The worker's Markdown citation scan failed on this text, so it must
	 * render as plain text. Anything but `true` reads as unset.
	 */
	plainText?: boolean;
}

/** A stored report, as the analysis read returns it. */
export interface ProposalAnalysisReport {
	assessment: string;
	summary: string;
	scope: ProposalAnalysisReportScopeItem[];
	beforeSending: string[];
	duringDiscovery: string[];
	sources: number[];
	/** The text was cut to the cap, or the report call ran out of output. */
	textTruncated: boolean;
	/**
	 * Show the text as escaped plain text: the worker said so, or its
	 * structure is past the renderer's limits. Stored with the report and
	 * checked against the text again on every read.
	 */
	plainText: boolean;
	/** Null when the report has structured fields but no text. */
	text: string | null;
}

const listSchema = z
	.array(z.string().min(1).max(PROPOSAL_REPORT_LIST_ENTRY_MAX_LENGTH))
	.max(PROPOSAL_REPORT_LIST_MAX_ENTRIES);

/**
 * The stored object, version 1. Unknown keys are stripped on read; any other
 * version, or a value past the caps, reads as no report. A future version
 * deploys its reader before any writer stores it.
 */
const storedReportSchema = z.object({
	v: z.literal(1),
	assessment: z.string().max(PROPOSAL_REPORT_ASSESSMENT_MAX_LENGTH),
	summary: z.string().max(PROPOSAL_REPORT_SUMMARY_MAX_LENGTH),
	scope: z
		.array(
			z.object({
				item: z
					.string()
					.min(1)
					.max(PROPOSAL_REPORT_SCOPE_ITEM_MAX_LENGTH),
				priority: z.enum(PROPOSAL_REPORT_PRIORITIES).nullable(),
				inProposal: z
					.string()
					.max(PROPOSAL_REPORT_SCOPE_IN_PROPOSAL_MAX_LENGTH),
				note: z.string().max(PROPOSAL_REPORT_SCOPE_NOTE_MAX_LENGTH),
			}),
		)
		.max(PROPOSAL_REPORT_SCOPE_MAX_ITEMS),
	beforeSending: listSchema,
	duringDiscovery: listSchema,
	sources: z
		.array(z.number().int().min(1).max(MAX_SOURCE_NUMBER))
		.max(PROPOSAL_REPORT_MAX_SOURCES),
	textTruncated: z.boolean(),
	plainText: z.boolean(),
});

/** The `report` column's value, version 1. */
export type StoredProposalAnalysisReport = z.infer<typeof storedReportSchema>;

/** What the completion writes: the object, and the text or null. */
export interface NormalizedProposalAnalysisReport {
	report: StoredProposalAnalysisReport;
	reportText: string | null;
}

// A high surrogate not followed by a low one, or a low one not preceded by a
// high one. Matched per code unit (no `u` flag), so a valid pair never is.
const LONE_SURROGATE =
	/[\uD800-\uDBFF](?![\uDC00-\uDFFF])|(?<![\uD800-\uDBFF])[\uDC00-\uDFFF]/g;

/**
 * `text` with every unpaired surrogate replaced by U+FFFD, as
 * `String.prototype.toWellFormed` does. Postgres refuses a lone surrogate in
 * JSON, and the report is written in the same statement that completes the
 * run, so one would cost the run its findings too.
 */
function wellFormed(text: string): string {
	return text.replace(LONE_SURROGATE, "�");
}

/** NUL removed, surrogates paired, trimmed, then cut to `max` code units. */
function cleanString(value: unknown, max: number): string {
	if (typeof value !== "string") {
		return "";
	}
	const text = wellFormed(sanitizeContent(value)).trim();
	return cutAtCodeUnits(text, max).trimEnd();
}

function asArray(value: unknown): readonly unknown[] {
	return Array.isArray(value) ? value : [];
}

function cleanList(value: unknown): string[] {
	const entries: string[] = [];
	for (const entry of asArray(value)) {
		if (entries.length >= PROPOSAL_REPORT_LIST_MAX_ENTRIES) {
			break;
		}
		const text = cleanString(entry, PROPOSAL_REPORT_LIST_ENTRY_MAX_LENGTH);
		if (text) {
			entries.push(text);
		}
	}
	return entries;
}

function cleanPriority(value: unknown): ProposalReportPriority | null {
	return (
		PROPOSAL_REPORT_PRIORITIES.find((priority) => priority === value) ??
		null
	);
}

function cleanScope(value: unknown): ProposalAnalysisReportScopeItem[] {
	const items: ProposalAnalysisReportScopeItem[] = [];
	for (const entry of asArray(value)) {
		if (items.length >= PROPOSAL_REPORT_SCOPE_MAX_ITEMS) {
			break;
		}
		if (typeof entry !== "object" || entry === null) {
			continue;
		}
		const raw = entry as Record<string, unknown>;
		const item = cleanString(
			raw.item,
			PROPOSAL_REPORT_SCOPE_ITEM_MAX_LENGTH,
		);
		if (!item) {
			continue;
		}
		items.push({
			item,
			priority: cleanPriority(raw.priority),
			inProposal: cleanString(
				raw.inProposal,
				PROPOSAL_REPORT_SCOPE_IN_PROPOSAL_MAX_LENGTH,
			),
			note: cleanString(raw.note, PROPOSAL_REPORT_SCOPE_NOTE_MAX_LENGTH),
		});
	}
	return items;
}

/**
 * Integers from 1 to {@link MAX_SOURCE_NUMBER}, without duplicates, in
 * ascending order; past {@link PROPOSAL_REPORT_MAX_SOURCES} the lowest are
 * kept.
 */
function cleanSources(value: unknown): number[] {
	const sources = new Set<number>();
	for (const entry of asArray(value)) {
		if (
			typeof entry === "number" &&
			Number.isInteger(entry) &&
			entry >= 1 &&
			entry <= MAX_SOURCE_NUMBER
		) {
			sources.add(entry);
		}
	}
	return [...sources]
		.sort((a, b) => a - b)
		.slice(0, PROPOSAL_REPORT_MAX_SOURCES);
}

/**
 * The text as stored: cleaned like every other string, then cut to the cap
 * outside any fenced block (`cutReportText`). The cut is checked for paired
 * surrogates again, so the stored text is well formed whatever the cut did.
 */
function cleanText(value: unknown): { text: string; truncated: boolean } {
	if (typeof value !== "string") {
		return { text: "", truncated: false };
	}
	const cut = cutReportText(wellFormed(sanitizeContent(value)).trim());
	return { text: wellFormed(cut.text).trimEnd(), truncated: cut.truncated };
}

/**
 * Bound a report before it is stored. Total: any input, of any shape, gives a
 * value or null, never a throw.
 *
 * Every string loses its NUL characters (Postgres refuses them), has each
 * unpaired surrogate replaced with U+FFFD, is trimmed and is cut to its cap
 * without splitting a surrogate pair. Empty list entries and scope items
 * without text are dropped, a priority other than the three reads null, and
 * source numbers keep only integers in range. The object is built field by
 * field, so nothing else the input carries is stored.
 *
 * `plainText` is the caller's flag or the plain-text guard's verdict on the
 * stored text, and `textTruncated` records the cut as well as the caller's
 * flag.
 *
 * Null — store no report — unless the text, the assessment, the summary or
 * the before-sending list has content.
 */
export function normalizeAnalysisReport(
	input: ProposalAnalysisReportInput | null | undefined,
): NormalizedProposalAnalysisReport | null {
	if (typeof input !== "object" || input === null || Array.isArray(input)) {
		return null;
	}
	const raw = input as unknown as Record<string, unknown>;
	const text = cleanText(raw.text);
	const assessment = cleanString(
		raw.assessment,
		PROPOSAL_REPORT_ASSESSMENT_MAX_LENGTH,
	);
	const summary = cleanString(
		raw.summary,
		PROPOSAL_REPORT_SUMMARY_MAX_LENGTH,
	);
	const beforeSending = cleanList(raw.beforeSending);
	if (!text.text && !assessment && !summary && beforeSending.length === 0) {
		return null;
	}
	return {
		report: {
			v: 1,
			assessment,
			summary,
			scope: cleanScope(raw.scope),
			beforeSending,
			duringDiscovery: cleanList(raw.duringDiscovery),
			sources: cleanSources(raw.sources),
			textTruncated: raw.textTruncated === true || text.truncated,
			plainText:
				raw.plainText === true || reportTextNeedsPlainText(text.text),
		},
		reportText: text.text || null,
	};
}

/** A normalised report as the JSON column takes it. */
export function reportToJson(
	report: StoredProposalAnalysisReport,
): Prisma.InputJsonValue {
	return report as unknown as Prisma.InputJsonValue;
}

/**
 * A stored report, parsed. Null for a run without one, for an object the
 * version-1 schema refuses (another version, a value past the caps), and for
 * text stored without an object, so an old or damaged row reads as "no
 * report", never as an error. An object without text gives its fields with
 * `text` null.
 *
 * `plainText` is the stored flag or the plain-text guard's verdict on the
 * text now, so a stricter guard also covers rows stored before it. The guard
 * is one linear pass over text already bounded by the cap.
 */
export function parseStoredAnalysisReport(
	report: unknown,
	reportText: string | null | undefined,
): ProposalAnalysisReport | null {
	if (report === null || report === undefined) {
		return null;
	}
	const parsed = storedReportSchema.safeParse(report);
	if (!parsed.success) {
		return null;
	}
	let text: string | null = null;
	if (reportText !== null && reportText !== undefined) {
		if (
			typeof reportText !== "string" ||
			reportText.length > PROPOSAL_REPORT_TEXT_MAX_CODE_UNITS
		) {
			return null;
		}
		text = reportText || null;
	}
	const stored = parsed.data;
	return {
		assessment: stored.assessment,
		summary: stored.summary,
		scope: stored.scope,
		beforeSending: stored.beforeSending,
		duringDiscovery: stored.duringDiscovery,
		sources: stored.sources,
		textTruncated: stored.textTruncated,
		plainText:
			stored.plainText ||
			(text !== null && reportTextNeedsPlainText(text)),
		text,
	};
}

/**
 * The report of one COMPLETE run of the document, in the owning
 * organization; null when the run is another document's or organization's,
 * is not COMPLETE, or has no readable report.
 *
 * The only reader of the report columns, called only by the member-only
 * analysis read for the run it shows; never a procedure of its own.
 *
 * @param input.organizationId the project's owning organization, resolved
 *   from the project row by the caller.
 */
export async function getAnalysisReport(input: {
	organizationId: string;
	documentId: string;
	analysisId: string;
}): Promise<ProposalAnalysisReport | null> {
	const run = await db.projectDocumentAnalysis.findFirst({
		where: {
			id: input.analysisId,
			documentId: input.documentId,
			organizationId: input.organizationId,
			status: "COMPLETE",
		},
		select: { report: true, reportText: true },
	});
	return run ? parseStoredAnalysisReport(run.report, run.reportText) : null;
}
