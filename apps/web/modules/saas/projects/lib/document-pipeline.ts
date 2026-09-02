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
 * Maps a ProjectDocumentStatus to the badge shown on the card. Unchanged from
 * the previous per-card logic: COMPLETE -> Ready, GENERATING/IN_PROGRESS ->
 * Active, everything else (DRAFT/REVIEW/FAILED/missing) -> Pending.
 */
export function getDocumentStatusView(status: string): DocumentStatusView {
	if (status === "COMPLETE") {
		return { label: "Ready", tone: "complete" };
	}
	if (status === "GENERATING" || status === "IN_PROGRESS") {
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
