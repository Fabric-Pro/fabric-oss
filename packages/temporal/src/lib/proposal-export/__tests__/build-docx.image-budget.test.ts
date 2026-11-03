/**
 * The Word writer's image placement budget (Fizzy #2946): every placement
 * of an image (an upload, a diagram, a cover asset) hands its bytes to the
 * writer again, so all of them share one byte budget, repeats included, and
 * placements past it are left out with `IMAGE_LIMIT`.
 * The budget is lowered here so a few small stand-in images reach it.
 */

import { buildProposalThemeTokens } from "@repo/utils/proposal-artifact/theme-tokens";
import JSZip from "jszip";
import { describe, expect, it, vi } from "vitest";

vi.mock("../types", async (importOriginal) => {
	const actual = await importOriginal<typeof import("../types")>();
	return {
		...actual,
		PROPOSAL_EXPORT_LIMITS: {
			...actual.PROPOSAL_EXPORT_LIMITS,
			maxPlacedImageBytes: 1_000,
		},
	};
});

import { buildProposalDocx } from "../build-docx";
import { prepareExportMarkdown } from "../markdown";
import type { ExportRaster, ExportThemeTokens } from "../types";

const PROJECT_ID = "project-example";
const DOCUMENT_ID = "document-example";
const KEY = `document-media/${PROJECT_ID}/${DOCUMENT_ID}/chart.png`;

/** Neutral tokens without logos, as the writer reads them. */
function exportTokens(): ExportThemeTokens {
	const base = buildProposalThemeTokens({
		organization: { name: "Example Org", logoKey: null },
		style: null,
		brandKit: null,
		recipient: null,
	});
	const none = { value: null, source: "DEFAULT" as const };
	return {
		proposer: { ...base.proposer, logo: none, hero: none },
		recipient: { ...base.recipient, logo: none },
	};
}

const RASTER: ExportRaster = {
	mimeType: "image/png",
	bytes: Buffer.alloc(400, 1),
	width: 40,
	height: 20,
};

async function drawings(buffer: Buffer): Promise<number> {
	const documentXml = await (await JSZip.loadAsync(buffer))
		.file("word/document.xml")
		?.async("string");
	return documentXml?.match(/<w:drawing>/g)?.length ?? 0;
}

describe("buildProposalDocx image placement budget", () => {
	it("charges diagrams too, printing a diagram past the budget as its caption", async () => {
		const fence = "```mermaid\nflowchart LR\n  A --> B\n```";
		const diagram = {
			kind: "svg" as const,
			svg: "<svg></svg>",
			width: 40,
			height: 20,
			png: RASTER,
		};
		const result = await buildProposalDocx({
			prepared: prepareExportMarkdown([fence, fence, fence].join("\n\n")),
			diagrams: [diagram, diagram, diagram],
			images: new Map(),
			tokens: exportTokens(),
			projectId: PROJECT_ID,
			documentId: DOCUMENT_ID,
			title: "Example Proposal",
			dateLabel: "October 15, 2026",
		});

		expect(await drawings(result.buffer)).toBe(2);
		expect(result.warnings).toEqual([{ code: "IMAGE_LIMIT", count: 1 }]);
	});

	it("places an image until the budget is spent, then leaves the rest out with IMAGE_LIMIT", async () => {
		const tag = `<img src="x" alt="Chart" data-s3-key="${KEY}" />`;
		const result = await buildProposalDocx({
			prepared: prepareExportMarkdown(
				Array.from({ length: 5 }, () => tag).join("\n\n"),
			),
			diagrams: [],
			images: new Map([[KEY, RASTER]]),
			tokens: exportTokens(),
			projectId: PROJECT_ID,
			documentId: DOCUMENT_ID,
			title: "Example Proposal",
			dateLabel: "October 15, 2026",
		});

		// 2 × 400 bytes fit under 1,000; the other 3 placements do not.
		expect(await drawings(result.buffer)).toBe(2);
		expect(result.warnings).toEqual([{ code: "IMAGE_LIMIT", count: 3 }]);
	});
});
