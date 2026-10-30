/**
 * Shared shapes of the Proposal export (Fizzy #2946): what the image reader,
 * the diagram renderer, the print page builder and the DOCX writer hand each
 * other inside one export activity. Nothing here crosses workflow history;
 * the workflow carries only ids and the upload's key.
 *
 * Types and constants only, so the workflow bundle may import it.
 */

import type { ProposalThemeTokens } from "@repo/utils/proposal-artifact/theme-tokens";

/** The files an export can produce. */
export const PROPOSAL_EXPORT_FORMATS = ["pdf", "docx"] as const;
export type ProposalExportFormat = (typeof PROPOSAL_EXPORT_FORMATS)[number];

/**
 * A raster image both writers can place as it is: decoded, re-encoded as PNG
 * or JPEG with its metadata dropped, and measured in pixels.
 */
export interface ExportRaster {
	mimeType: "image/png" | "image/jpeg";
	bytes: Buffer;
	width: number;
	height: number;
	/**
	 * Relative luminance (0 to 1) of a measured brand asset, weighted by
	 * alpha: a logo's mean over its opaque pixels, which picks its plate,
	 * and the hero's bright end (its 90th percentile), which sets the veil.
	 * Absent when not measured or when no pixel is opaque at all.
	 */
	luminance?: number;
	/** A measured logo with no transparent pixel: its own edge is its box. */
	opaque?: boolean;
	/**
	 * The hero again at a section opener graphic's size. Print writes a
	 * separate crop of the image for each opener, so the openers crop this
	 * small copy rather than the full hero. Absent on anything else.
	 */
	openerCopy?: ExportRaster;
}

/**
 * Below this mean luminance a logo is drawn for a light background, so the
 * dark cover sets it on a light plate.
 */
export const COVER_LOGO_DARK_LUMINANCE = 0.45;

/**
 * Brand tokens as print reads them: every asset is already re-encoded bytes,
 * never a storage key or a URL, so nothing on the page can load anything.
 */
export type ExportThemeTokens = ProposalThemeTokens<ExportRaster>;

/** One uploaded image of the document, by the storage key Main names it by. */
export type ExportDocumentImages = ReadonlyMap<string, ExportRaster>;

/**
 * A diagram fence as it prints, in document order. Nothing about a diagram
 * fails the export; one that does not draw is either left out or kept as a
 * captioned placeholder, by cause:
 *
 * - `svg`: drawn, from a figure template or by the engine; when its DOCX
 *   screenshot fails, `png` stays null and the DOCX prints a placeholder
 *   in its place, under the same number;
 * - `placeholder`: a kind only the live page draws (gantt, pie, mindmap, a
 *   mermaid `timeline`, frontmatter), or a fence past the export's diagram
 *   limit; it holds its place in print;
 * - `omitted`: a source the export can draw that failed to draw (a syntax
 *   error, a layout that failed or ran out of time, a refused SVG); it
 *   prints nothing.
 *
 * `numbered` says whether it takes a "Figure n." number: every figure that
 * prints does, a left-out one does not. Numbers count in document order.
 */
export type ExportDiagram =
	| {
			kind: "svg";
			/** Allowlisted SVG markup, safe to inline in the print page. */
			svg: string;
			/** Intrinsic size in CSS pixels, from the SVG's viewBox. */
			width: number;
			height: number;
			/** A 2x screenshot of the cleaned SVG, rendered only for DOCX. */
			png: ExportRaster | null;
			numbered: true;
	  }
	| { kind: "placeholder"; caption: string; numbered: true }
	| { kind: "omitted"; numbered: false };

/**
 * Each diagram's "Figure n." number, in document order, or null for one
 * that is left out and takes none.
 */
export function diagramFigureNumbers(
	diagrams: readonly (ExportDiagram | undefined)[],
): (number | null)[] {
	let next = 0;
	return diagrams.map((diagram) => (diagram?.numbered ? ++next : null));
}

/**
 * What an export left out or could not do, reported to whoever started it.
 * Codes only: never a source, a key or a piece of content.
 */
export const PROPOSAL_EXPORT_WARNING_CODES = [
	/**
	 * A diagram whose source could not be drawn and was left out, or a drawn
	 * one whose DOCX picture failed and prints a placeholder there. The code
	 * keeps its older name, from when every such diagram printed as a
	 * placeholder.
	 */
	"DIAGRAM_PLACEHOLDER",
	/**
	 * A diagram the live page draws and the export could not: a kind only
	 * the live page draws, or a layout the export gave up on (out of time, a
	 * failed thread, past a size limit). Printed as its captioned placeholder.
	 */
	"DIAGRAM_NOT_PRINTABLE",
	/** More diagrams than one export renders; the rest are placeholders. */
	"DIAGRAM_LIMIT",
	/** A diagram whose labels print below the legible size, even top-down. */
	"DIAGRAM_BELOW_PRINT_FLOOR",
	/** An uploaded image was missing, unreadable, too large or not allowed. */
	"IMAGE_DROPPED",
	/** More uploaded images than one export carries; the rest were left out. */
	"IMAGE_LIMIT",
	/** An image with no stored upload (a remote or inline URL) was left out. */
	"EXTERNAL_IMAGE_DROPPED",
	/** A brand logo could not be read and the cover was laid out without it. */
	"LOGO_UNAVAILABLE",
	/** The contents page lists its sections without page numbers. */
	"CONTENTS_WITHOUT_PAGE_NUMBERS",
] as const;
export type ProposalExportWarningCode =
	(typeof PROPOSAL_EXPORT_WARNING_CODES)[number];

export interface ProposalExportWarning {
	code: ProposalExportWarningCode;
	/** How many things the warning covers. */
	count: number;
}

/**
 * Why an export failed, as the status read reports it. Budget and access
 * failures are final; anything else may have been retried first.
 */
export const PROPOSAL_EXPORT_FAILURE_CODES = [
	/** The starter can no longer read the document, or it is not a client document. */
	"EXPORT_ACCESS_DENIED",
	/** Main is larger than one export reads. */
	"DOCUMENT_TOO_LARGE",
	/** The printed document is longer than one export prints. */
	"TOO_MANY_PAGES",
	/** The render did not finish inside the export's time budget. */
	"EXPORT_TIMED_OUT",
	/** Anything else. */
	"EXPORT_FAILED",
] as const;
export type ProposalExportFailureCode =
	(typeof PROPOSAL_EXPORT_FAILURE_CODES)[number];

/**
 * The failure codes no retry can fix, for the workflow's
 * `nonRetryableErrorTypes`.
 */
export const PROPOSAL_EXPORT_NON_RETRYABLE_CODES: readonly ProposalExportFailureCode[] =
	[
		"EXPORT_ACCESS_DENIED",
		"DOCUMENT_TOO_LARGE",
		"TOO_MANY_PAGES",
		"EXPORT_TIMED_OUT",
	];

/** Budgets one export runs within; exceeding one is never retried. */
export const PROPOSAL_EXPORT_LIMITS = {
	/** Main's size, in UTF-16 code units, before anything is parsed. */
	maxMarkdownLength: 1_000_000,
	/** Diagrams rendered; later fences print as placeholders. */
	maxDiagrams: 40,
	/** One diagram's source, in characters. */
	maxDiagramSourceLength: 20_000,
	/** One rendered SVG, in characters, before it is cleaned. */
	maxSvgLength: 512_000,
	/** Uploaded images carried; later ones are left out. */
	maxImages: 30,
	/** One stored image, in bytes, before it is decoded. */
	maxImageBytes: 10 * 1024 * 1024,
	/** Every image an export reads, logos included, in bytes. */
	maxTotalImageBytes: 40 * 1024 * 1024,
	/** Pixels one image may declare before it is decoded. */
	maxImagePixels: 6000 * 6000,
	/** The longest edge an image is re-encoded at. */
	maxImageEdge: 2400,
	/**
	 * One re-encoded image, in bytes. Print inlines each image as a `data:`
	 * URL, and Chromium draws nothing for a URL longer than 2 MiB; base64
	 * makes this 2,000,000 characters, with room for the URL's prefix.
	 */
	maxEncodedImageBytes: 1_500_000,
	/**
	 * Image bytes the Word file places in all (cover assets, uploads and
	 * diagrams), each repeat of an image counted again, as the writer handles
	 * the bytes per placement: the read budget once over, with room to spare.
	 */
	maxPlacedImageBytes: 60 * 1024 * 1024,
	/** Printed pages. */
	maxPages: 150,
	/** The whole render, load to upload, in milliseconds. */
	totalTimeMs: 150_000,
	/**
	 * What diagram layout leaves of that for the stages after it (the
	 * screenshots, the print passes or the Word writer, the upload): a
	 * document of slow diagrams prints placeholders for the rest rather
	 * than time the whole export out.
	 */
	afterLayoutReserveMs: 50_000,
} as const;

/** The workflow type the export procedure starts. */
export const PROPOSAL_EXPORT_WORKFLOW_TYPE = "proposalExportWorkflow";

/**
 * An export id is the export workflow's id: this prefix and 32 random hex
 * digits. The status read checks the shape before it asks Temporal about an
 * id, so a caller cannot use it to describe any other workflow.
 */
export const PROPOSAL_EXPORT_ID_PREFIX = "proposal-export-";
export const PROPOSAL_EXPORT_ID_PATTERN = /^proposal-export-[0-9a-f]{32}$/;

/** What the export procedure starts the workflow with: ids only. */
export interface ProposalExportWorkflowInput {
	exportId: string;
	/** Who started it; the activity re-checks this user's access. */
	userId: string;
	/** The project's owning organization, resolved by the procedure. */
	organizationId: string;
	projectId: string;
	documentId: string;
	format: ProposalExportFormat;
}

/**
 * Who an export belongs to, in the workflow's memo under
 * {@link PROPOSAL_EXPORT_MEMO_KEY}. The status read answers only the user who
 * started it, for the project and document it names.
 */
export interface ProposalExportMemo {
	userId: string;
	organizationId: string;
	projectId: string;
	documentId: string;
	format: ProposalExportFormat;
}
export const PROPOSAL_EXPORT_MEMO_KEY = "proposalExport";

/**
 * What a finished export hands back through workflow history: where the
 * file is, never a URL to it. The status read signs a short-lived download
 * URL on each call.
 */
export interface ProposalExportResult {
	key: string;
	fileName: string;
	contentType: string;
	byteSize: number;
	warnings: ProposalExportWarning[];
}

/** Exports live under this prefix in the project contexts bucket. */
export const PROPOSAL_EXPORT_STORAGE_PREFIX = "proposal-exports/";

/** One project's exports, swept with the project when it is deleted. */
export function proposalExportProjectPrefix(projectId: string): string {
	return `${PROPOSAL_EXPORT_STORAGE_PREFIX}${projectId}/`;
}

/**
 * How long an export's file is kept. The cleanup schedule deletes older
 * objects, and the status read stops handing out URLs for older exports.
 */
export const PROPOSAL_EXPORT_RETENTION_MS = 24 * 60 * 60 * 1000;

/** The file type of each format, for the upload and the download. */
export const PROPOSAL_EXPORT_CONTENT_TYPES: Readonly<
	Record<ProposalExportFormat, string>
> = {
	pdf: "application/pdf",
	docx: "application/vnd.openxmlformats-officedocument.wordprocessingml.document",
};

/**
 * The export procedure's answer (BAD_REQUEST, in `data.code`) for a document
 * it does not cover: anything but a client-document Proposal. The download
 * menu then exports that document in the browser, as it always has.
 */
export const PROPOSAL_EXPORT_UNSUPPORTED_CODE = "PROPOSAL_EXPORT_UNSUPPORTED";
