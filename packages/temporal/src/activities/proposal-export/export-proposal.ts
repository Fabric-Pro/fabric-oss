/**
 * The Proposal export activity (Fizzy #2946): one client-document Proposal
 * to one PDF or Word file, uploaded, its key returned.
 *
 * Everything happens inside this one activity, because the stages hand each
 * other more than workflow history carries: the document, its images and
 * logos as bytes, the rendered diagrams, the print page with its embedded
 * font and the finished file. In order:
 *   1. access, checked again for the starter, and the guest-safe inputs;
 *   2. Main scrubbed of citation markers and any Source Index, and parsed;
 *   3. logos and uploaded images read, checked and re-encoded, against one
 *      byte budget;
 *   4. diagrams rendered with the live page's engine and cleaned;
 *   5. the theme page printed twice for the contents page's numbers, or the
 *      Word file written from the same tree;
 *   6. the file uploaded under the project's export prefix.
 *
 * The whole run has a time budget: past it the browser closes and the export
 * fails for good. A heartbeat ticks throughout, and the browser, when one is
 * needed, is this run's alone.
 */

import { logger } from "@repo/logs";
import { resolveThemePaint } from "@repo/utils/proposal-artifact/theme-tokens";
import {
	type ExportBrowser,
	withExportBrowser,
} from "../../lib/proposal-export/browser";
import { buildProposalDocx } from "../../lib/proposal-export/build-docx";
import { buildThemeHtml } from "../../lib/proposal-export/build-theme-html";
import {
	createExportImageBudget,
	extractDocumentImages,
} from "../../lib/proposal-export/extract-document-images";
import { exportFailure } from "../../lib/proposal-export/failures";
import { prepareExportMarkdown } from "../../lib/proposal-export/markdown";
import {
	PROPOSAL_EXPORT_LIMITS,
	type ProposalExportFormat,
	type ProposalExportResult,
	type ProposalExportWarning,
	type ProposalExportWorkflowInput,
} from "../../lib/proposal-export/types";
import { ExportWarningTally } from "../../lib/proposal-export/warnings";
import { withHeartbeatTicker } from "../lib/activity-liveness";
import { exportDateLabel, loadExportInput } from "./load-export-input";
import { loadThemeAssets } from "./load-theme-assets";
import { printProposalPdf } from "./print-pdf";
import { renderExportDiagrams } from "./render-diagrams";
import { uploadProposalExport } from "./upload-export";

/** The file name a download is saved under: the title, slugged. */
export function exportFileName(
	title: string,
	format: ProposalExportFormat,
): string {
	const slug = title
		.normalize("NFKD")
		.replace(/[̀-ͯ]/g, "")
		.toLowerCase()
		.replace(/[^a-z0-9]+/g, "-")
		.replace(/^-+|-+$/g, "")
		.slice(0, 80)
		.replace(/-+$/g, "");
	return `${slug || "proposal"}.${format}`;
}

/** One warning per code, counts summed, in the codes' declared order. */
export function mergeExportWarnings(
	warnings: readonly ProposalExportWarning[],
): ProposalExportWarning[] {
	const tally = new ExportWarningTally();
	for (const warning of warnings) {
		tally.add(warning.code, warning.count);
	}
	return tally.warnings();
}

export async function exportProposalDocumentActivity(
	input: ProposalExportWorkflowInput,
): Promise<ProposalExportResult> {
	const deadline = Date.now() + PROPOSAL_EXPORT_LIMITS.totalTimeMs;
	return await withHeartbeatTicker(
		async () => {
			const loaded = await loadExportInput(input);
			const dateLabel = exportDateLabel(new Date());
			const prepared = prepareExportMarkdown(loaded.content);

			const budget = createExportImageBudget();
			const assets = await loadThemeAssets({
				tokens: loaded.tokens,
				organizationId: input.organizationId,
				projectId: input.projectId,
				budget,
			});
			const images = await extractDocumentImages({
				root: prepared.root,
				projectId: input.projectId,
				documentId: input.documentId,
				budget,
			});
			const paint = resolveThemePaint(assets.tokens);
			const shared = {
				prepared,
				images: images.images,
				tokens: assets.tokens,
				projectId: input.projectId,
				documentId: input.documentId,
				title: loaded.title,
				dateLabel,
			};

			const render = async (browser: ExportBrowser | null) => {
				const diagrams = await renderExportDiagrams({
					sources: prepared.diagramSources,
					paint,
					browser,
					withPng: input.format === "docx",
					deadline:
						deadline - PROPOSAL_EXPORT_LIMITS.afterLayoutReserveMs,
				});
				if (input.format === "docx") {
					const docx = await buildProposalDocx({
						...shared,
						diagrams: diagrams.diagrams,
					});
					return {
						bytes: docx.buffer,
						warnings: [...diagrams.warnings, ...docx.warnings],
					};
				}
				if (!browser) {
					throw exportFailure("EXPORT_FAILED");
				}
				let pageWarnings: ProposalExportWarning[] = [];
				const printed = await printProposalPdf({
					browser,
					buildHtml: (pass) => {
						const page = buildThemeHtml({
							...shared,
							diagrams: diagrams.diagrams,
							pass,
						});
						pageWarnings = page.warnings;
						return page;
					},
				});
				return {
					bytes: printed.pdf,
					warnings: [
						...diagrams.warnings,
						...pageWarnings,
						...printed.warnings,
					],
				};
			};

			// The writers walk the tree recursively; a document nested deeper
			// than they can walk is too deep to export, not worth a retry.
			const renderWithin = async (browser: ExportBrowser | null) => {
				try {
					return await render(browser);
				} catch (error) {
					if (error instanceof RangeError) {
						throw exportFailure("DOCUMENT_TOO_LARGE");
					}
					throw error;
				}
			};
			// Word needs the browser only to screenshot diagrams.
			const needsBrowser =
				input.format === "pdf" || prepared.diagramSources.length > 0;
			const rendered = needsBrowser
				? await withExportBrowser(deadline, renderWithin)
				: await renderWithin(null);
			if (Date.now() > deadline) {
				throw exportFailure("EXPORT_TIMED_OUT");
			}

			const upload = await uploadProposalExport({
				exportId: input.exportId,
				projectId: input.projectId,
				format: input.format,
				bytes: rendered.bytes,
			});
			const warnings = mergeExportWarnings([
				...assets.warnings,
				...images.warnings,
				...rendered.warnings,
			]);
			logger.info(
				{
					event: "proposal_export.completed",
					organizationId: input.organizationId,
					projectId: input.projectId,
					documentId: input.documentId,
					exportId: input.exportId,
					format: input.format,
					byteSize: rendered.bytes.byteLength,
					diagrams: prepared.diagramSources.length,
					images: images.images.size,
					warnings: warnings.map((warning) => warning.code),
				},
				"[ProposalExport] Export uploaded",
			);
			return {
				key: upload.key,
				fileName: exportFileName(loaded.title, input.format),
				contentType: upload.contentType,
				byteSize: rendered.bytes.byteLength,
				warnings,
			};
		},
		{ details: { exportId: input.exportId } },
	);
}
