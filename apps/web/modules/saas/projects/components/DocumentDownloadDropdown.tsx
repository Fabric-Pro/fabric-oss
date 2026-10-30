"use client";

import type {
	ProposalExportFailureCode,
	ProposalExportFormat,
	ProposalExportWarningCode,
} from "@repo/temporal/proposal-export-types";
import { isGlossyEligible } from "@repo/utils/glossy/eligibility";
import { stripVisualSlots } from "@repo/utils/glossy/visual-slots";
import { scrubProposalExport } from "@repo/utils/proposal-artifact/export-scrub";
import { useFeatureFlag } from "@saas/shared/components/FeatureFlagProvider";
import { Button } from "@ui/components/button";
import {
	DropdownMenu,
	DropdownMenuContent,
	DropdownMenuItem,
	DropdownMenuSeparator,
	DropdownMenuTrigger,
} from "@ui/components/dropdown-menu";
import {
	DownloadIcon,
	FileCodeIcon,
	FileDownIcon,
	FileTextIcon,
	Loader2Icon,
	SparklesIcon,
} from "lucide-react";
import Link from "next/link";
import { useTranslations } from "next-intl";
import { useState } from "react";
import { toast } from "sonner";
import { orpcClient } from "../../../shared/lib/orpc-client";
import {
	needsLegacyGlossyEdition,
	useLegacyGlossyEdition,
} from "../hooks/use-legacy-glossy-edition";
import {
	parseImgTag,
	renderMarkdownToDocx,
	renderMarkdownToPdf,
	renderMermaidToPng,
	toSlug,
	triggerBlobDownload,
	triggerUrlDownload,
} from "../lib/markdown-to-document";
import {
	exportsOnServer,
	type ProposalExportWarning,
	runProposalExport,
} from "../lib/proposal-export-client";
import { getOrpcCode } from "./field-mapping/orpc-error";

interface Props {
	documentId: string;
	title: string;
	projectId: string;
	/** The document's type; only a Glossy-eligible type offers the Glossy item. */
	documentType: string;
	/**
	 * The route's organization, handed to the content fetch so it resolves
	 * the same tenant as the page rather than the session's active one.
	 */
	organizationId: string | null;
	/**
	 * Where the document's Glossy page lives (Fizzy #2589, R1). The parent
	 * passes it only when the `GLOSSY_EDITION` rollout gate is on for the
	 * organization. Absent, no Glossy item renders. Handed one for a Proposal
	 * under the `PROPOSAL_ARTIFACT` gate, the menu still offers the item only
	 * once a published legacy edition is confirmed (Fizzy #2801).
	 */
	glossyHref?: string;
	/**
	 * The file an imported document was converted from, when it was an upload
	 * whose original is still stored (Fizzy #2280). The list resolves it on the
	 * server; present, the menu offers that file as uploaded ahead of the
	 * Markdown, PDF and Word exports of the converted text.
	 */
	sourceFile?: { contextId: string; filename: string | null } | null;
	className?: string;
}

/** The extension the original file was uploaded with, without the dot. */
function fileExtension(filename: string | null): string | null {
	const dot = filename?.lastIndexOf(".") ?? -1;
	if (!filename || dot <= 0 || dot === filename.length - 1) {
		return null;
	}
	return filename.slice(dot + 1).toLowerCase();
}

/** The source was deleted, or its stored object is gone, since the list loaded. */
function isOriginalGone(err: unknown): boolean {
	if (getOrpcCode(err) === "NOT_FOUND") {
		return true;
	}
	const data = (err as { data?: { code?: unknown } } | null)?.data;
	return data?.code === "CONTENT_UNAVAILABLE";
}

/** The Glossy item, below a separator from the downloads. */
function GlossyMenuItem({ href }: { href: string }) {
	const t = useTranslations("projects.glossyEntry");
	return (
		<>
			<DropdownMenuSeparator />
			<DropdownMenuItem asChild>
				<Link href={href} onClick={(e) => e.stopPropagation()}>
					<SparklesIcon className="mr-2 size-4" aria-hidden="true" />
					{t("menuItem")}
				</Link>
			</DropdownMenuItem>
		</>
	);
}

/**
 * The Glossy item of a Proposal under the Proposal artifact gate
 * (Fizzy #2801): such a Proposal needs no Glossy edition, so the item stays
 * only to reach one already published. Its own component so the edition read
 * happens only here, and only while the menu is open; the list asks the same
 * question through the same cache.
 */
function LegacyGlossyMenuItem({
	projectId,
	documentId,
	href,
}: {
	projectId: string;
	documentId: string;
	href: string;
}) {
	const published = useLegacyGlossyEdition(projectId, documentId, true);
	return published ? <GlossyMenuItem href={href} /> : null;
}

/**
 * Re-resolve S3 image URLs in markdown content.
 * Signed URLs expire after 1 hour. Before export, we need to get fresh URLs.
 * Extracts S3 keys from both data-s3-key attributes AND src URL paths.
 */
async function resolveS3Urls(
	content: string,
	projectId: string,
	documentId: string,
): Promise<string> {
	// Extract S3 keys from data-s3-key attributes
	const attrKeys = [...content.matchAll(/data-s3-key="([^"]+)"/g)].map(
		(m) => m[1],
	);

	// Also extract S3 keys from src URLs that point to document-media/
	// URL pattern: http://.../{bucket}/document-media/{projectId}/{docId}/{file}?X-Amz-...
	const srcKeys = [
		...content.matchAll(/src="[^"]*\/(document-media\/[^?"]+)\?[^"]*"/g),
	].map((m) => m[1]);

	const keys = [...new Set([...attrKeys, ...srcKeys])].filter((k) =>
		k.startsWith("document-media/"),
	);
	if (keys.length === 0) {
		return content;
	}

	try {
		const { urls } = await orpcClient.projects.documents.resolveMediaUrls({
			projectId,
			documentId,
			s3Keys: keys,
		});

		let resolved = content;
		for (const key of keys) {
			const freshUrl = urls[key];
			if (!freshUrl) {
				continue;
			}

			// Replace any src URL that contains this S3 key path with the fresh URL
			const escapedKey = key.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
			const srcRe = new RegExp(`src="[^"]*${escapedKey}[^"]*"`, "g");
			resolved = resolved.replace(srcRe, `src="${freshUrl}"`);
		}
		return resolved;
	} catch {
		return content;
	}
}

/** How long a click keeps the browser's user activation, near enough. */
const ACTIVATION_WINDOW_MS = 4_000;

/**
 * Whether a download started now still counts as the reader's click. Where
 * the browser cannot say, the time since the click stands in for it.
 */
function stillActivated(clickedAt: number): boolean {
	const activation = (
		navigator as Navigator & { userActivation?: { isActive: boolean } }
	).userActivation;
	return activation
		? activation.isActive
		: Date.now() - clickedAt < ACTIVATION_WINDOW_MS;
}

/** The words for each warning an export can carry; any other goes unnamed. */
const EXPORT_WARNING_KEYS = {
	DIAGRAM_PLACEHOLDER: "exportWarningDiagramPlaceholder",
	DIAGRAM_NOT_PRINTABLE: "exportWarningDiagramNotPrintable",
	DIAGRAM_LIMIT: "exportWarningDiagramLimit",
	DIAGRAM_BELOW_PRINT_FLOOR: "exportWarningDiagramBelowPrintFloor",
	IMAGE_DROPPED: "exportWarningImageDropped",
	IMAGE_LIMIT: "exportWarningImageLimit",
	EXTERNAL_IMAGE_DROPPED: "exportWarningExternalImageDropped",
	LOGO_UNAVAILABLE: "exportWarningLogoUnavailable",
	CONTENTS_WITHOUT_PAGE_NUMBERS: "exportWarningContentsWithoutPageNumbers",
} as const satisfies Readonly<Record<ProposalExportWarningCode, string>>;

/** Failures the menu explains; any other reads as a plain failure. */
const EXPORT_FAILURE_KEYS = {
	DOCUMENT_TOO_LARGE: "exportFailureTooLarge",
	TOO_MANY_PAGES: "exportFailureTooManyPages",
} as const satisfies Readonly<
	Partial<Record<ProposalExportFailureCode, string>>
>;

function keyFor<T extends Record<string, string>>(
	keys: T,
	code: string,
): T[keyof T] | null {
	return Object.hasOwn(keys, code) ? keys[code as keyof T] : null;
}

export function DocumentDownloadDropdown({
	documentId,
	title,
	projectId,
	documentType,
	organizationId,
	glossyHref,
	sourceFile,
	className,
}: Props) {
	const t = useTranslations("projects.documentDownload");
	const [isLoading, setIsLoading] = useState(false);
	const proposalArtifactEnabled = useFeatureFlag("PROPOSAL_ARTIFACT");
	// A client-document Proposal (Fizzy #2946) is exported by the server from
	// the theme its page wears; everything else keeps the browser export.
	const serverExport = exportsOnServer(documentType, proposalArtifactEnabled);
	// The href carries the gate; the type check keeps an ineligible
	// document from offering the item whatever the parent passes (R2).
	const glossyItemHref =
		glossyHref && isGlossyEligible(documentType) ? glossyHref : null;

	// Every download reads the document's own content and nothing else: under
	// the Proposal artifact gate (Fizzy #2801) that is the client-ready Main
	// document, and the Internal Analysis lives apart from it, so no export
	// can carry it.
	const fetchContent = async (): Promise<string> => {
		const res = await orpcClient.projects.documents.get({
			projectId,
			id: documentId,
			organizationId,
		});
		let content = res.document?.content ?? "";
		// Re-resolve S3 signed URLs so they're fresh for export
		content = await resolveS3Urls(content, projectId, documentId);
		return content;
	};

	const handleDownloadOriginal = async (e: React.MouseEvent) => {
		e.stopPropagation();
		if (!sourceFile) {
			return;
		}
		setIsLoading(true);
		try {
			const res = await orpcClient.projects.contexts.createDownloadUrl({
				contextId: sourceFile.contextId,
				projectId,
				organizationId,
			});
			// Only an uploaded file (Class A) is signed as stored. Any other class
			// is Markdown built from extracted text, which must not be saved
			// under the original's name.
			if (res.contextClass !== "A") {
				toast.error(t("originalUnavailable"));
				return;
			}
			triggerUrlDownload(res.url, res.filename);
		} catch (err: unknown) {
			toast.error(
				isOriginalGone(err)
					? t("originalUnavailable")
					: t("originalFailed"),
			);
		} finally {
			setIsLoading(false);
		}
	};

	const handleDownloadMd = async (e: React.MouseEvent) => {
		e.stopPropagation();
		setIsLoading(true);
		try {
			// Visual slots are Glossy layout, not content (R38). The PDF and
			// DOCX renderers leave them out themselves; the Markdown file is
			// written from the raw body, so it strips them here.
			let content = stripVisualSlots(await fetchContent());
			// The client document leaves the app without citation markers or a
			// Source Index, as its PDF and Word files do (Fizzy #2946).
			if (serverExport) {
				content = scrubProposalExport(content).markdown;
			}

			// 1. Replace mermaid code blocks with rendered diagram images
			const mermaidBlockRe = /```mermaid\n([\s\S]*?)```/g;
			const mermaidMatches = [...content.matchAll(mermaidBlockRe)];
			for (const match of mermaidMatches) {
				const code = match[1];
				const rendered = await renderMermaidToPng(code);
				if (rendered) {
					content = content.replace(
						match[0],
						`![Diagram](${rendered.dataUrl})`,
					);
				}
			}

			// 2. Embed S3/HTTP images as base64 data URLs.
			// Keep <img> HTML tags (not ![]) to preserve width/sizing in markdown viewers.
			const lines = content.split("\n");
			const newLines: string[] = [];
			for (const line of lines) {
				const parsed = parseImgTag(line);
				if (parsed?.src.startsWith("http")) {
					try {
						const resp = await fetch(parsed.src);
						if (resp.ok) {
							const blob = await resp.blob();
							const dataUrl = await new Promise<string>(
								(resolve, reject) => {
									const reader = new FileReader();
									reader.onloadend = () =>
										resolve(reader.result as string);
									reader.onerror = reject;
									reader.readAsDataURL(blob);
								},
							);
							// Build <img> tag with embedded base64, preserving width
							const attrs = [
								`src="${dataUrl}"`,
								`alt="${parsed.alt}"`,
							];
							if (parsed.width) {
								attrs.push(`width="${parsed.width}"`);
							}
							const imgTag = `<img ${attrs.join(" ")} />`;
							const captionLine = parsed.caption
								? `\n\n*${parsed.caption}*`
								: "";
							newLines.push(`${imgTag}${captionLine}`);
							continue;
						}
					} catch {
						// Fall through to original line
					}
				}
				// For <img> tags with captions but no HTTP src (or fetch failed)
				if (parsed?.caption) {
					newLines.push(line);
					newLines.push("");
					newLines.push(`*${parsed.caption}*`);
					continue;
				}
				newLines.push(line);
			}
			content = newLines.join("\n");

			const blob = new Blob([content], {
				type: "text/markdown;charset=utf-8",
			});
			triggerBlobDownload(blob, `${toSlug(title)}.md`);
		} catch (err: unknown) {
			toast.error(
				`Failed to download: ${err instanceof Error ? err.message : "Unknown error"}`,
			);
		} finally {
			setIsLoading(false);
		}
	};

	const downloadPdfInBrowser = async () => {
		try {
			const content = await fetchContent();
			const blob = await renderMarkdownToPdf(content);
			triggerBlobDownload(blob, `${toSlug(title)}.pdf`);
		} catch (err: unknown) {
			toast.error(
				`Failed to generate PDF: ${err instanceof Error ? err.message : "Unknown error"}`,
			);
		}
	};

	const downloadDocxInBrowser = async () => {
		try {
			const content = await fetchContent();
			const blob = await renderMarkdownToDocx(content, title);
			triggerBlobDownload(blob, `${toSlug(title)}.docx`);
		} catch (err: unknown) {
			toast.error(
				`Failed to generate DOCX: ${err instanceof Error ? err.message : "Unknown error"}`,
			);
		}
	};

	const downloadInBrowser = (exportFormat: ProposalExportFormat) =>
		exportFormat === "pdf"
			? downloadPdfInBrowser()
			: downloadDocxInBrowser();

	/** What an export left out, in one note, so the reader is not surprised. */
	const announceWarnings = (
		format: string,
		warnings: ProposalExportWarning[],
	) => {
		const lines = warnings.flatMap((warning) => {
			const key = keyFor(EXPORT_WARNING_KEYS, warning.code);
			return key && warning.count > 0
				? [t(key, { count: warning.count })]
				: [];
		});
		if (lines.length > 0) {
			toast.info(t("exportLeftOut", { format }), {
				description: lines.join(" "),
			});
		}
	};

	/**
	 * Export on the server, wait for it, and hand the file over. A document
	 * the server says it does not cover goes to the browser export instead;
	 * a client document whose export fails never does, so the reader never
	 * receives an unthemed copy in its place.
	 */
	const exportOnServer = async (exportFormat: ProposalExportFormat) => {
		const format = t(exportFormat === "pdf" ? "formatPdf" : "formatDocx");
		const retry = {
			label: t("exportRetry"),
			onClick: () => {
				void runExport(exportFormat);
			},
		};
		const clickedAt = Date.now();
		try {
			const outcome = await runProposalExport({
				projectId,
				documentId,
				format: exportFormat,
			});
			switch (outcome.kind) {
				case "unsupported":
					await downloadInBrowser(exportFormat);
					return;
				case "ready": {
					const download = () =>
						triggerUrlDownload(outcome.url, outcome.fileName);
					if (stillActivated(clickedAt)) {
						download();
					} else {
						toast.success(t("exportReady", { format }), {
							duration: 60_000,
							action: {
								label: t("exportDownload"),
								onClick: download,
							},
						});
					}
					announceWarnings(format, outcome.warnings);
					return;
				}
				case "rate-limited":
					toast.error(
						outcome.retryAfterSeconds === null
							? t("exportRateLimitedSoon")
							: t("exportRateLimited", {
									seconds: outcome.retryAfterSeconds,
								}),
						{ action: retry },
					);
					return;
				case "deadline":
					toast.error(t("exportStillRunning", { format }), {
						action: retry,
					});
					return;
				case "failed": {
					const key = keyFor(EXPORT_FAILURE_KEYS, outcome.code);
					toast.error(
						key
							? t(key, { format })
							: t("exportFailed", { format }),
						{ action: retry },
					);
					return;
				}
			}
		} catch {
			toast.error(t("exportFailed", { format }), { action: retry });
		}
	};

	const runExport = async (format: ProposalExportFormat) => {
		setIsLoading(true);
		try {
			if (serverExport) {
				await exportOnServer(format);
			} else {
				await downloadInBrowser(format);
			}
		} finally {
			setIsLoading(false);
		}
	};

	const handleDownloadPdf = (e: React.MouseEvent) => {
		e.stopPropagation();
		void runExport("pdf");
	};

	const handleDownloadDocx = (e: React.MouseEvent) => {
		e.stopPropagation();
		void runExport("docx");
	};

	const originalExtension = fileExtension(sourceFile?.filename ?? null);

	return (
		<DropdownMenu>
			<DropdownMenuTrigger asChild>
				<Button
					variant="ghost"
					size="icon"
					title="Download"
					className={className}
					disabled={isLoading}
					onClick={(e) => e.stopPropagation()}
				>
					{isLoading ? (
						<Loader2Icon className="size-4 animate-spin" />
					) : (
						<DownloadIcon className="size-4" />
					)}
				</Button>
			</DropdownMenuTrigger>
			<DropdownMenuContent
				align="end"
				className={sourceFile ? "w-52" : "w-44"}
			>
				{sourceFile && (
					<>
						<DropdownMenuItem
							onClick={handleDownloadOriginal}
							title={
								sourceFile.filename
									? t("originalFileTitle", {
											filename: sourceFile.filename,
										})
									: undefined
							}
						>
							<FileDownIcon className="mr-2 size-4" />
							{originalExtension
								? t("originalFile", {
										extension: originalExtension,
									})
								: t("originalFileNoExtension")}
						</DropdownMenuItem>
						<DropdownMenuSeparator />
					</>
				)}
				<DropdownMenuItem onClick={handleDownloadMd}>
					<FileCodeIcon className="mr-2 size-4" />
					Markdown (.md)
				</DropdownMenuItem>
				<DropdownMenuItem onClick={handleDownloadPdf}>
					<FileTextIcon className="mr-2 size-4" />
					PDF (.pdf)
				</DropdownMenuItem>
				<DropdownMenuItem onClick={handleDownloadDocx}>
					<FileTextIcon className="mr-2 size-4" />
					Word (.docx)
				</DropdownMenuItem>
				{glossyItemHref &&
					(needsLegacyGlossyEdition(
						documentType,
						proposalArtifactEnabled,
					) ? (
						<LegacyGlossyMenuItem
							projectId={projectId}
							documentId={documentId}
							href={glossyItemHref}
						/>
					) : (
						<GlossyMenuItem href={glossyItemHref} />
					))}
			</DropdownMenuContent>
		</DropdownMenu>
	);
}
