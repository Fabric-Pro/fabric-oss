/**
 * The Proposal export activity as an orchestrator (Fizzy #2946): which stages
 * run for each format, what they are handed, what is uploaded and what comes
 * back through workflow history. A PDF always opens a browser; a Word file
 * opens one only to screenshot diagrams. Every stage's warnings are merged by
 * code in declared order, a diagram or logo failure never fails the export,
 * an access failure uploads nothing, and the result is the upload's key with
 * no URL in it.
 *
 * Mocked: every stage (`load-export-input` except the real `exportDateLabel`,
 * `load-theme-assets`, `render-diagrams`, `print-pdf`, `upload-export`), the
 * browser (`withExportBrowser` runs `work` on a fake), the page and DOCX
 * builders, the image reader (keeping the real `createExportImageBudget`),
 * the heartbeat ticker (runs its function directly) and the stores the real
 * modules import. `prepareExportMarkdown`, `resolveThemePaint`,
 * `exportFileName` and `mergeExportWarnings` are real.
 */

import {
	buildProposalThemeTokens,
	type ProposalThemeTokens,
} from "@repo/utils/proposal-artifact/theme-tokens";
import { ApplicationFailure } from "@temporalio/common";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const h = vi.hoisted(() => ({
	loadExportInput: vi.fn(),
	loadThemeAssets: vi.fn(),
	renderExportDiagrams: vi.fn(),
	printProposalPdf: vi.fn(),
	uploadProposalExport: vi.fn(),
	withExportBrowser: vi.fn(),
	buildThemeHtml: vi.fn(),
	buildProposalDocx: vi.fn(),
	extractDocumentImages: vi.fn(),
	withHeartbeatTicker: vi.fn(),
	loggerInfo: vi.fn(),
	fakeBrowser: { newPage: vi.fn(), blockedRequests: 0 },
}));

vi.mock("@repo/logs", () => ({
	logger: {
		info: h.loggerInfo,
		warn: vi.fn(),
		error: vi.fn(),
		debug: vi.fn(),
	},
}));
vi.mock("@repo/storage", () => ({
	downloadFile: vi.fn(async () => {
		throw new Error("storage is not read in these tests");
	}),
	uploadFile: vi.fn(async () => {
		throw new Error("storage is not written in these tests");
	}),
}));
vi.mock("@repo/database", () => ({
	db: {},
	hasProjectAccess: vi.fn(),
	isProposalClientDocument: vi.fn(),
	resolveGuestSafeProposalThemeTokens: vi.fn(),
}));
vi.mock("../load-export-input", async (importOriginal) => ({
	...(await importOriginal<typeof import("../load-export-input")>()),
	loadExportInput: h.loadExportInput,
}));
vi.mock("../load-theme-assets", () => ({
	loadThemeAssets: h.loadThemeAssets,
}));
vi.mock("../render-diagrams", () => ({
	renderExportDiagrams: h.renderExportDiagrams,
}));
vi.mock("../print-pdf", () => ({ printProposalPdf: h.printProposalPdf }));
vi.mock("../upload-export", () => ({
	uploadProposalExport: h.uploadProposalExport,
}));
vi.mock("../../../lib/proposal-export/browser", () => ({
	withExportBrowser: h.withExportBrowser,
}));
vi.mock("../../../lib/proposal-export/build-theme-html", () => ({
	buildThemeHtml: h.buildThemeHtml,
}));
vi.mock("../../../lib/proposal-export/build-docx", () => ({
	buildProposalDocx: h.buildProposalDocx,
}));
vi.mock(
	"../../../lib/proposal-export/extract-document-images",
	async (importOriginal) => ({
		...(await importOriginal<
			typeof import("../../../lib/proposal-export/extract-document-images")
		>()),
		extractDocumentImages: h.extractDocumentImages,
	}),
);
vi.mock("../../lib/activity-liveness", () => ({
	withHeartbeatTicker: h.withHeartbeatTicker,
}));

import { exportFailure } from "../../../lib/proposal-export/failures";
import {
	type ExportRaster,
	type ExportThemeTokens,
	PROPOSAL_EXPORT_LIMITS,
	type ProposalExportWarning,
	type ProposalExportWorkflowInput,
} from "../../../lib/proposal-export/types";
import {
	exportFileName,
	exportProposalDocumentActivity,
	mergeExportWarnings,
} from "../export-proposal";

const PDF_BYTES = Buffer.from("%PDF-1.7 example proposal");
const DOCX_BYTES = Buffer.from("PK example proposal docx");
const EXPORT_ID = "proposal-export-0123456789abcdef0123456789abcdef";

function input(
	format: ProposalExportWorkflowInput["format"],
): ProposalExportWorkflowInput {
	return {
		exportId: EXPORT_ID,
		userId: "user-example-1",
		organizationId: "org-example-1",
		projectId: "project-example-1",
		documentId: "document-example-1",
		format,
	};
}

const PLAIN_CONTENT = "# Example Proposal\n\n## Overview\n\nExample body.";
const DIAGRAM_SOURCE = "graph TD\n  A[Example] --> B[Pilot]";
const DIAGRAM_CONTENT = `${PLAIN_CONTENT}\n\n\`\`\`mermaid\n${DIAGRAM_SOURCE}\n\`\`\`\n`;

const STORED_TOKENS: ProposalThemeTokens = buildProposalThemeTokens({
	organization: { name: "Example Org", logoKey: null },
	style: { primaryColor: "#1f3a6b", accentColors: [] },
	brandKit: null,
	recipient: null,
});
/** No logos, so the stored tokens are already valid print tokens. */
const PRINT_TOKENS = STORED_TOKENS as unknown as ExportThemeTokens;
const IMAGES = new Map<string, ExportRaster>();

function arrange(
	options: {
		content?: string;
		title?: string;
		logoWarnings?: ProposalExportWarning[];
		imageWarnings?: ProposalExportWarning[];
		diagramWarnings?: ProposalExportWarning[];
		pageWarnings?: ProposalExportWarning[];
		printWarnings?: ProposalExportWarning[];
		docxWarnings?: ProposalExportWarning[];
	} = {},
): void {
	h.loadExportInput.mockResolvedValue({
		title: options.title ?? "Example Proposal: Q3 Pilot!",
		content: options.content ?? PLAIN_CONTENT,
		tokens: STORED_TOKENS,
	});
	h.loadThemeAssets.mockResolvedValue({
		tokens: PRINT_TOKENS,
		warnings: options.logoWarnings ?? [],
	});
	h.extractDocumentImages.mockResolvedValue({
		images: IMAGES,
		warnings: options.imageWarnings ?? [],
	});
	h.renderExportDiagrams.mockImplementation(
		async ({ sources }: { sources: string[] }) => ({
			diagrams: sources.map(() => ({
				kind: "placeholder",
				caption: "Example placeholder",
			})),
			warnings: options.diagramWarnings ?? [],
		}),
	);
	h.buildThemeHtml.mockReturnValue({
		html: "<html><body>Example</body></html>",
		sections: [],
		warnings: options.pageWarnings ?? [],
	});
	h.printProposalPdf.mockImplementation(
		async (print: { buildHtml: (pass: unknown) => unknown }) => {
			print.buildHtml({ kind: "locate" });
			print.buildHtml({ kind: "final", pageNumbers: null });
			return {
				pdf: PDF_BYTES,
				pageCount: 3,
				warnings: options.printWarnings ?? [],
			};
		},
	);
	h.buildProposalDocx.mockResolvedValue({
		buffer: DOCX_BYTES,
		warnings: options.docxWarnings ?? [],
	});
	h.uploadProposalExport.mockImplementation(
		async (upload: {
			projectId: string;
			exportId: string;
			format: string;
		}) => ({
			key: `proposal-exports/${upload.projectId}/${upload.exportId}.${upload.format}`,
			contentType:
				upload.format === "pdf"
					? "application/pdf"
					: "application/vnd.openxmlformats-officedocument.wordprocessingml.document",
		}),
	);
}

beforeEach(() => {
	for (const [name, mock] of Object.entries(h)) {
		if (name !== "fakeBrowser") {
			(mock as ReturnType<typeof vi.fn>).mockReset();
		}
	}
	h.withExportBrowser.mockImplementation(
		async (
			_deadline: number,
			work: (browser: unknown) => Promise<unknown>,
		) => await work(h.fakeBrowser),
	);
	h.withHeartbeatTicker.mockImplementation(
		async (fn: () => Promise<unknown>) => await fn(),
	);
	arrange();
});

afterEach(() => {
	vi.restoreAllMocks();
});

describe("exportProposalDocumentActivity: PDF", () => {
	it("prints in a browser and returns the upload's key, file name, type, size and warnings, with no URL", async () => {
		const before = Date.now();
		const result = await exportProposalDocumentActivity(input("pdf"));

		expect(h.withExportBrowser).toHaveBeenCalledTimes(1);
		const deadline = h.withExportBrowser.mock.calls[0]?.[0] as number;
		expect(deadline).toBeGreaterThanOrEqual(
			before + PROPOSAL_EXPORT_LIMITS.totalTimeMs,
		);
		expect(deadline).toBeLessThanOrEqual(
			Date.now() + PROPOSAL_EXPORT_LIMITS.totalTimeMs,
		);

		expect(result).toEqual({
			key: `proposal-exports/project-example-1/${EXPORT_ID}.pdf`,
			fileName: "example-proposal-q3-pilot.pdf",
			contentType: "application/pdf",
			byteSize: PDF_BYTES.byteLength,
			warnings: [],
		});
		expect(Object.keys(result).sort()).toEqual([
			"byteSize",
			"contentType",
			"fileName",
			"key",
			"warnings",
		]);
		expect(JSON.stringify(result)).not.toMatch(/url|https?:/i);
	});

	it("renders diagrams in the browser without screenshots", async () => {
		arrange({ content: DIAGRAM_CONTENT });

		await exportProposalDocumentActivity(input("pdf"));

		expect(h.renderExportDiagrams).toHaveBeenCalledTimes(1);
		expect(h.renderExportDiagrams).toHaveBeenCalledWith({
			sources: [DIAGRAM_SOURCE],
			paint: expect.any(Object),
			browser: h.fakeBrowser,
			withPng: false,
			deadline: expect.any(Number),
		});
		// Layout stops early enough to leave the print its share of the time.
		const exportDeadline = h.withExportBrowser.mock.calls[0]?.[0] as number;
		const layoutDeadline = (
			h.renderExportDiagrams.mock.calls[0]?.[0] as { deadline: number }
		).deadline;
		expect(exportDeadline - layoutDeadline).toBe(
			PROPOSAL_EXPORT_LIMITS.afterLayoutReserveMs,
		);
	});

	it("prints through printProposalPdf, whose page is built from the shared inputs for each pass", async () => {
		arrange({ content: DIAGRAM_CONTENT });

		await exportProposalDocumentActivity(input("pdf"));

		expect(h.printProposalPdf).toHaveBeenCalledWith({
			browser: h.fakeBrowser,
			buildHtml: expect.any(Function),
		});
		expect(h.buildThemeHtml).toHaveBeenCalledTimes(2);
		const shared = {
			prepared: expect.objectContaining({
				diagramSources: [DIAGRAM_SOURCE],
			}),
			images: IMAGES,
			tokens: PRINT_TOKENS,
			projectId: "project-example-1",
			documentId: "document-example-1",
			title: "Example Proposal: Q3 Pilot!",
			dateLabel: expect.any(String),
			diagrams: [{ kind: "placeholder", caption: "Example placeholder" }],
		};
		expect(h.buildThemeHtml).toHaveBeenNthCalledWith(1, {
			...shared,
			pass: { kind: "locate" },
		});
		expect(h.buildThemeHtml).toHaveBeenNthCalledWith(2, {
			...shared,
			pass: { kind: "final", pageNumbers: null },
		});
		expect(h.buildProposalDocx).not.toHaveBeenCalled();
	});

	it("uploads the printed bytes under the input's ids and format", async () => {
		await exportProposalDocumentActivity(input("pdf"));

		expect(h.uploadProposalExport).toHaveBeenCalledTimes(1);
		expect(h.uploadProposalExport).toHaveBeenCalledWith({
			exportId: EXPORT_ID,
			projectId: "project-example-1",
			format: "pdf",
			bytes: PDF_BYTES,
		});
	});

	it("loads the input, then the logos and the images against one shared budget", async () => {
		await exportProposalDocumentActivity(input("pdf"));

		expect(h.loadExportInput).toHaveBeenCalledWith(input("pdf"));
		expect(h.loadThemeAssets).toHaveBeenCalledWith({
			tokens: STORED_TOKENS,
			organizationId: "org-example-1",
			projectId: "project-example-1",
			budget: expect.any(Object),
		});
		expect(h.extractDocumentImages).toHaveBeenCalledWith({
			root: expect.objectContaining({ type: "root" }),
			projectId: "project-example-1",
			documentId: "document-example-1",
			budget: expect.any(Object),
		});
		const logoBudget = h.loadThemeAssets.mock.calls[0]?.[0].budget;
		const imageBudget = h.extractDocumentImages.mock.calls[0]?.[0].budget;
		expect(logoBudget).toBe(imageBudget);
		expect(logoBudget.remainingBytes).toBe(
			PROPOSAL_EXPORT_LIMITS.maxTotalImageBytes,
		);
	});

	it("runs inside the heartbeat ticker, naming only the export", async () => {
		await exportProposalDocumentActivity(input("pdf"));

		expect(h.withHeartbeatTicker).toHaveBeenCalledWith(
			expect.any(Function),
			{
				details: { exportId: EXPORT_ID },
			},
		);
	});
});

describe("exportProposalDocumentActivity: Word", () => {
	it("opens no browser for a document without diagrams, and writes the Word file", async () => {
		const result = await exportProposalDocumentActivity(input("docx"));

		expect(h.withExportBrowser).not.toHaveBeenCalled();
		expect(h.renderExportDiagrams).toHaveBeenCalledWith({
			sources: [],
			paint: expect.any(Object),
			browser: null,
			withPng: true,
			deadline: expect.any(Number),
		});
		expect(h.buildProposalDocx).toHaveBeenCalledWith({
			prepared: expect.objectContaining({ diagramSources: [] }),
			images: IMAGES,
			tokens: PRINT_TOKENS,
			projectId: "project-example-1",
			documentId: "document-example-1",
			title: "Example Proposal: Q3 Pilot!",
			dateLabel: expect.any(String),
			diagrams: [],
		});
		expect(h.printProposalPdf).not.toHaveBeenCalled();
		expect(h.uploadProposalExport).toHaveBeenCalledWith({
			exportId: EXPORT_ID,
			projectId: "project-example-1",
			format: "docx",
			bytes: DOCX_BYTES,
		});
		expect(result).toEqual({
			key: `proposal-exports/project-example-1/${EXPORT_ID}.docx`,
			fileName: "example-proposal-q3-pilot.docx",
			contentType:
				"application/vnd.openxmlformats-officedocument.wordprocessingml.document",
			byteSize: DOCX_BYTES.byteLength,
			warnings: [],
		});
	});

	it("opens a browser to screenshot diagrams when the document has some", async () => {
		arrange({ content: DIAGRAM_CONTENT });

		await exportProposalDocumentActivity(input("docx"));

		expect(h.withExportBrowser).toHaveBeenCalledTimes(1);
		expect(h.renderExportDiagrams).toHaveBeenCalledWith({
			sources: [DIAGRAM_SOURCE],
			paint: expect.any(Object),
			browser: h.fakeBrowser,
			withPng: true,
			deadline: expect.any(Number),
		});
		expect(h.buildProposalDocx).toHaveBeenCalledTimes(1);
		expect(h.printProposalPdf).not.toHaveBeenCalled();
	});

	it("uploads nothing when a render without a browser finishes past the time budget", async () => {
		const start = Date.now();
		h.buildProposalDocx.mockImplementation(async () => {
			vi.spyOn(Date, "now").mockReturnValue(
				start + PROPOSAL_EXPORT_LIMITS.totalTimeMs + 60_000,
			);
			return { buffer: DOCX_BYTES, warnings: [] };
		});

		await expect(
			exportProposalDocumentActivity(input("docx")),
		).rejects.toMatchObject({
			type: "EXPORT_TIMED_OUT",
			nonRetryable: true,
		});
		expect(h.uploadProposalExport).not.toHaveBeenCalled();
	});
});

describe("exportProposalDocumentActivity: warnings and failures", () => {
	it("reports every stage's warnings merged by code in declared order, and still uploads", async () => {
		arrange({
			content: DIAGRAM_CONTENT,
			logoWarnings: [{ code: "LOGO_UNAVAILABLE", count: 1 }],
			imageWarnings: [
				{ code: "IMAGE_LIMIT", count: 1 },
				{ code: "IMAGE_DROPPED", count: 2 },
			],
			diagramWarnings: [{ code: "DIAGRAM_PLACEHOLDER", count: 1 }],
			pageWarnings: [
				{ code: "EXTERNAL_IMAGE_DROPPED", count: 1 },
				{ code: "DIAGRAM_PLACEHOLDER", count: 1 },
			],
			printWarnings: [
				{ code: "CONTENTS_WITHOUT_PAGE_NUMBERS", count: 2 },
			],
		});

		const result = await exportProposalDocumentActivity(input("pdf"));

		expect(h.uploadProposalExport).toHaveBeenCalledTimes(1);
		expect(result.warnings).toEqual([
			{ code: "DIAGRAM_PLACEHOLDER", count: 2 },
			{ code: "IMAGE_DROPPED", count: 2 },
			{ code: "IMAGE_LIMIT", count: 1 },
			{ code: "EXTERNAL_IMAGE_DROPPED", count: 1 },
			{ code: "LOGO_UNAVAILABLE", count: 1 },
			{ code: "CONTENTS_WITHOUT_PAGE_NUMBERS", count: 2 },
		]);
	});

	it("reports the Word writer's warnings with the renderer's", async () => {
		arrange({
			content: DIAGRAM_CONTENT,
			diagramWarnings: [{ code: "DIAGRAM_PLACEHOLDER", count: 1 }],
			docxWarnings: [{ code: "EXTERNAL_IMAGE_DROPPED", count: 3 }],
			logoWarnings: [{ code: "LOGO_UNAVAILABLE", count: 2 }],
		});

		const result = await exportProposalDocumentActivity(input("docx"));

		expect(result.warnings).toEqual([
			{ code: "DIAGRAM_PLACEHOLDER", count: 1 },
			{ code: "EXTERNAL_IMAGE_DROPPED", count: 3 },
			{ code: "LOGO_UNAVAILABLE", count: 2 },
		]);
		expect(h.uploadProposalExport).toHaveBeenCalledTimes(1);
	});

	it("fails for good, uploading nothing, when a writer runs out of stack on a deeply nested document", async () => {
		h.buildProposalDocx.mockRejectedValue(
			new RangeError("Maximum call stack size exceeded"),
		);

		await expect(
			exportProposalDocumentActivity(input("docx")),
		).rejects.toMatchObject({
			type: "DOCUMENT_TOO_LARGE",
			nonRetryable: true,
		});
		expect(h.uploadProposalExport).not.toHaveBeenCalled();
	});

	it("propagates an access failure and uploads nothing", async () => {
		h.loadExportInput.mockRejectedValue(
			exportFailure("EXPORT_ACCESS_DENIED"),
		);

		const error = await exportProposalDocumentActivity(input("pdf")).catch(
			(caught: unknown) => caught,
		);

		expect(error).toBeInstanceOf(ApplicationFailure);
		expect(error).toMatchObject({
			type: "EXPORT_ACCESS_DENIED",
			nonRetryable: true,
		});
		expect(h.loadThemeAssets).not.toHaveBeenCalled();
		expect(h.withExportBrowser).not.toHaveBeenCalled();
		expect(h.uploadProposalExport).not.toHaveBeenCalled();
	});

	it("propagates a browser failure and uploads nothing", async () => {
		h.withExportBrowser.mockRejectedValue(
			exportFailure("EXPORT_TIMED_OUT"),
		);

		await expect(
			exportProposalDocumentActivity(input("pdf")),
		).rejects.toMatchObject({ type: "EXPORT_TIMED_OUT" });
		expect(h.uploadProposalExport).not.toHaveBeenCalled();
	});
});

describe("mergeExportWarnings", () => {
	it("sums counts per code, drops empty ones and orders by declared code", () => {
		expect(
			mergeExportWarnings([
				{ code: "CONTENTS_WITHOUT_PAGE_NUMBERS", count: 1 },
				{ code: "LOGO_UNAVAILABLE", count: 0 },
				{ code: "DIAGRAM_LIMIT", count: 2 },
				{ code: "DIAGRAM_LIMIT", count: 3 },
			]),
		).toEqual([
			{ code: "DIAGRAM_LIMIT", count: 5 },
			{ code: "CONTENTS_WITHOUT_PAGE_NUMBERS", count: 1 },
		]);
		expect(mergeExportWarnings([])).toEqual([]);
	});
});

describe("exportFileName", () => {
	it("slugs the title", () => {
		expect(exportFileName("Example Proposal: Q3 Pilot!", "pdf")).toBe(
			"example-proposal-q3-pilot.pdf",
		);
	});

	it("falls back to 'proposal' for an empty or symbol-only title", () => {
		expect(exportFileName("", "docx")).toBe("proposal.docx");
		expect(exportFileName("!!! — ???", "docx")).toBe("proposal.docx");
	});

	it("strips accents rather than dropping the letters", () => {
		expect(exportFileName("Café Résumé Ångström", "pdf")).toBe(
			"cafe-resume-angstrom.pdf",
		);
	});

	it("caps the slug at 80 characters, with no hyphen left at the cut", () => {
		expect(exportFileName("a".repeat(100), "pdf")).toBe(
			`${"a".repeat(80)}.pdf`,
		);
		// The 80th character is the hyphen between the words.
		expect(
			exportFileName(`${"a".repeat(79)} ${"b".repeat(30)}`, "pdf"),
		).toBe(`${"a".repeat(79)}.pdf`);
	});
});
