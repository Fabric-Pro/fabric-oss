import {
	BriefcaseIcon,
	FileIcon,
	FileTextIcon,
	ListChecksIcon,
	LockIcon,
	type LucideIcon,
	PaletteIcon,
	RocketIcon,
	ShieldCheckIcon,
	SwatchBookIcon,
	WrenchIcon,
	ZapIcon,
} from "lucide-react";

import { resolveGenerationClock } from "./document-generation-timestamp";

/**
 * Derives the Document Pipeline section on the Project Overview tab from the
 * project's actual documents instead of a hard-coded preset. Presentation-
 * agnostic view-model (carries type labels, icons, and design-token classes)
 * so it can be unit-tested without rendering the (large) ProjectOverview
 * component.
 */

export type PipelineDocument = {
	id: string;
	type: string;
	title: string;
	status: string;
	isActive?: boolean;
};

export type DocumentTypeMeta = {
	/** Human-readable document type name shown as the card's secondary line. */
	label: string;
	icon: LucideIcon;
	/** Accent tile classes, applied when the document is complete. */
	tileColor: string;
	/** Accent icon color, applied when the document is complete. */
	iconColor: string;
};

const NEUTRAL_TILE = "bg-muted border-border";
const NEUTRAL_ICON = "text-muted-foreground";

const DEFAULT_DOCUMENT_META: DocumentTypeMeta = {
	label: "Document",
	icon: FileIcon,
	tileColor: NEUTRAL_TILE,
	iconColor: NEUTRAL_ICON,
};

/**
 * Metadata for every ProjectDocumentType enum value. Keyed by the raw enum
 * string; unknown/future types fall back to DEFAULT_DOCUMENT_META. Labels are
 * the correct human names — this replaces the previous preset whose labels were
 * mismatched (e.g. PROPOSAL shown as "Frontend Design").
 */
const DOCUMENT_TYPE_META: Record<string, DocumentTypeMeta> = {
	BUSINESS_CASE: {
		label: "Business Case",
		icon: BriefcaseIcon,
		tileColor: "bg-highlight/10 border-highlight/20",
		iconColor: "text-highlight",
	},
	DESIGN_SYSTEM: {
		label: "Design System",
		icon: SwatchBookIcon,
		tileColor: "bg-highlight/10 border-highlight/20",
		iconColor: "text-highlight",
	},
	PRD: {
		label: "Requirements Document",
		icon: FileTextIcon,
		tileColor: "bg-primary/10 border-primary/20",
		iconColor: "text-primary",
	},
	SRS: {
		label: "Software Requirements Specification",
		icon: ListChecksIcon,
		tileColor: "bg-primary/10 border-primary/20",
		iconColor: "text-primary",
	},
	PROPOSAL: {
		label: "Proposal",
		icon: PaletteIcon,
		tileColor: "bg-highlight/10 border-highlight/20",
		iconColor: "text-highlight",
	},
	ARCHITECTURE: {
		label: "Architecture",
		icon: ZapIcon,
		tileColor: NEUTRAL_TILE,
		iconColor: NEUTRAL_ICON,
	},
	TECHNICAL_SPEC: {
		label: "Technical Specification",
		icon: WrenchIcon,
		tileColor: "bg-secondary/10 border-secondary/20",
		iconColor: "text-secondary",
	},
	API_SPEC: {
		label: "API Specification",
		icon: LockIcon,
		// Neutral accent — reserve the destructive/red token for genuine error
		// states, not a decorative tile beside a green "Ready" badge.
		tileColor: NEUTRAL_TILE,
		iconColor: NEUTRAL_ICON,
	},
	USER_STORY: {
		label: "User Stories",
		icon: RocketIcon,
		tileColor: "bg-success/10 border-success/20",
		iconColor: "text-success",
	},
	QA_STRATEGY: {
		label: "Testing Strategy",
		icon: ShieldCheckIcon,
		tileColor: "bg-secondary/10 border-secondary/20",
		iconColor: "text-secondary",
	},
	TEST_PLAN: {
		label: "Test Plan",
		icon: ShieldCheckIcon,
		tileColor: "bg-secondary/10 border-secondary/20",
		iconColor: "text-secondary",
	},
	TEST_REPORT: {
		label: "Test Report",
		icon: ShieldCheckIcon,
		tileColor: "bg-secondary/10 border-secondary/20",
		iconColor: "text-secondary",
	},
	TRACEABILITY_MATRIX: {
		label: "Traceability Matrix",
		icon: ShieldCheckIcon,
		tileColor: "bg-secondary/10 border-secondary/20",
		iconColor: "text-secondary",
	},
	GENERAL: {
		label: "General Document",
		icon: FileIcon,
		tileColor: NEUTRAL_TILE,
		iconColor: NEUTRAL_ICON,
	},
};

export function getDocumentMeta(type: string): DocumentTypeMeta {
	return DOCUMENT_TYPE_META[type] ?? DEFAULT_DOCUMENT_META;
}

/**
 * Stable pipeline order for the Document Pipeline section. Documents render in
 * this order so the visible (possibly truncated) set stays predictable across
 * renders. Unknown types sort last.
 */
const PIPELINE_ORDER: string[] = [
	"BUSINESS_CASE",
	"DESIGN_SYSTEM",
	"PRD",
	"SRS",
	"PROPOSAL",
	"ARCHITECTURE",
	"TECHNICAL_SPEC",
	"API_SPEC",
	"USER_STORY",
	"QA_STRATEGY",
	"TEST_PLAN",
	"TEST_REPORT",
	"TRACEABILITY_MATRIX",
	"GENERAL",
];

/** Max document cards shown before the "View More" control appears. */
export const DOCUMENT_PIPELINE_LIMIT = 6;

function pipelineIndex(type: string): number {
	const index = PIPELINE_ORDER.indexOf(type);
	return index === -1 ? PIPELINE_ORDER.length : index;
}

type DocumentStatusTone = "complete" | "active" | "pending";

export type DocumentStatusView = {
	label: "Ready" | "Active" | "Pending";
	tone: DocumentStatusTone;
};

/**
 * Whether a generation run has been accepted and has not finished.
 *
 * QUEUED belongs here alongside GENERATING: the request was taken, a workflow
 * is alive, and the only thing between it and the model call is the project's
 * own context work clearing. Reading QUEUED as "not started" is how a document
 * that is doing exactly what it was asked to do ends up presented as idle.
 *
 * Deliberately narrower than `isDocumentInFlight` — this one drives polling,
 * and IN_PROGRESS is a human editing a draft, which no amount of polling will
 * advance.
 */
export function isDocumentGenerationRunning(status: string): boolean {
	return status === "QUEUED" || status === "GENERATING";
}

/**
 * Whether a document counts as work in motion on a roll-up or badge — a
 * generation run under way, or a draft someone is actively working through.
 */
export function isDocumentInFlight(status: string): boolean {
	return isDocumentGenerationRunning(status) || status === "IN_PROGRESS";
}

/** Opening cadence: fast enough that a state change reads as immediate. */
export const DOCUMENT_POLL_BASE_MS = 3000;

/**
 * Widest cadence for a document that is still legitimately waiting. Half a
 * minute, not the server's five: the row this poll paints changes at most once
 * more, so the delay a reader can perceive is bounded by this number alone.
 */
const DOCUMENT_POLL_MAX_MS = 30_000;

/**
 * How long a GENERATING document may go SILENT before polling stops. The
 * ceiling exists to stop hammering the API for a run that died mid-flight and
 * will never report again, so it is measured from the run's last server write,
 * not from when its request was accepted — see `resolveGenerationClock`. QUEUED
 * is deliberately exempt: it is waiting on the project's own context work — an
 * index, a crawl, a sibling document — which can legitimately run for an hour,
 * and ageing it out would freeze the card on "Queued" for the rest of the
 * session.
 */
const DOCUMENT_POLL_CEILING_MS = 10 * 60 * 1000;

export type PollableDocument = {
	status: string;
	generationStartedAt?: Date | string | null;
	updatedAt?: Date | string | null;
};

/**
 * How long to wait before asking about this document again, or `false` to stop
 * asking. Mirrors the shape of the server's own dependency probe
 * (`DEPENDENCY_PROBE_INITIAL_DELAY_MS` doubling toward
 * `DEPENDENCY_PROBE_MAX_DELAY_MS` in `project-document-generation.ts`), and for
 * the same reason.
 *
 * The client is a VIEWER of a wait the server owns, not the mechanism that ends
 * it. The workflow's own backoff is what governs when the work actually
 * resumes; nothing here makes that happen sooner. So a queued document opens at
 * the base cadence — a wait that clears in seconds still looks instant — and
 * widens toward `DOCUMENT_POLL_MAX_MS` as the wait proves to be a long one. An
 * hour-long index wait costs a hundred-odd requests instead of the twelve
 * hundred a flat 3s poll issued, for a row that changes exactly once.
 *
 * GENERATING keeps the flat base cadence: that run is writing content the
 * viewer is watching arrive, and it is bounded by the ten-minute silence
 * ceiling.
 *
 * `since` is whichever clock the status is judged by — the accepted-at stamp
 * for a QUEUED wait, the last server write for a run under way. Callers get it
 * from `resolveGenerationClock`, which is where that choice is explained.
 */
export function getDocumentPollInterval(
	status: string,
	since: number,
	now: number = Date.now(),
): number | false {
	if (status === "QUEUED") {
		// Doubling on the elapsed wait, so the schedule matches what a
		// doubling-per-poll backoff would have produced: 3s, 6s, 12s, 24s,
		// then the ceiling from roughly the first minute onward.
		const elapsed = Math.max(0, now - since);
		const doublings = Math.floor(
			Math.log2(elapsed / DOCUMENT_POLL_BASE_MS + 1),
		);
		return Math.min(
			DOCUMENT_POLL_BASE_MS * 2 ** doublings,
			DOCUMENT_POLL_MAX_MS,
		);
	}
	if (status === "GENERATING") {
		return now - since > DOCUMENT_POLL_CEILING_MS
			? false
			: DOCUMENT_POLL_BASE_MS;
	}
	return false;
}

/**
 * The cadence for a LIST of documents: the shortest interval any one of them
 * asks for, or `false` when none of them is still worth polling. The list is
 * one request, so the most impatient document sets the pace.
 */
export function getDocumentsPollInterval(
	documents: PollableDocument[] | undefined | null,
	now: number = Date.now(),
): number | false {
	let interval: number | false = false;
	for (const doc of documents ?? []) {
		const next = getDocumentPollInterval(
			doc.status,
			resolveGenerationClock(
				doc.status,
				doc.generationStartedAt,
				doc.updatedAt,
			),
			now,
		);
		if (next !== false && (interval === false || next < interval)) {
			interval = next;
		}
	}
	return interval;
}

/**
 * Maps a ProjectDocumentStatus to the badge shown on the card: COMPLETE ->
 * Ready, QUEUED/GENERATING/IN_PROGRESS -> Active, everything else
 * (DRAFT/REVIEW/FAILED/missing) -> Pending.
 */
export function getDocumentStatusView(status: string): DocumentStatusView {
	if (status === "COMPLETE") {
		return { label: "Ready", tone: "complete" };
	}
	if (isDocumentInFlight(status)) {
		return { label: "Active", tone: "active" };
	}
	return { label: "Pending", tone: "pending" };
}

export type PipelineDocumentsResult = {
	/** Documents to render, capped at `limit`, in stable pipeline order. */
	visible: PipelineDocument[];
	/** Count of active documents (the whole list, not just the visible slice). */
	total: number;
	/** Whether the active count exceeds `limit` (drives the "View More" control). */
	hasMore: boolean;
};

/** A document is active unless explicitly flagged `isActive: false`. */
export function isActiveDocument(
	doc: Pick<PipelineDocument, "isActive">,
): boolean {
	return doc.isActive !== false;
}

/**
 * Filters to active documents, orders them by the stable pipeline sequence
 * (ties keep incoming order — the query already returns createdAt desc), and
 * caps the visible set at `limit`. One entry per document row; multiple
 * documents of the same type each get their own card.
 */
export function getPipelineDocuments(
	documents: PipelineDocument[] | undefined | null,
	limit: number = DOCUMENT_PIPELINE_LIMIT,
): PipelineDocumentsResult {
	const active = (documents ?? []).filter(isActiveDocument);
	const sorted = [...active].sort(
		(a, b) => pipelineIndex(a.type) - pipelineIndex(b.type),
	);
	return {
		visible: sorted.slice(0, limit),
		total: active.length,
		hasMore: active.length > limit,
	};
}
