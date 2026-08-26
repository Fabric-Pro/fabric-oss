"use client";

import { Button } from "@ui/components/button";
import {
	DropdownMenu,
	DropdownMenuContent,
	DropdownMenuItem,
	DropdownMenuTrigger,
} from "@ui/components/dropdown-menu";
import {
	DownloadIcon,
	FileCodeIcon,
	FileTextIcon,
	Loader2Icon,
} from "lucide-react";
import { useState } from "react";
import { toast } from "sonner";
import { orpcClient } from "../../../shared/lib/orpc-client";
import {
	parseImgTag,
	renderMarkdownToDocx,
	renderMarkdownToPdf,
	renderMermaidToPng,
	toSlug,
	triggerBlobDownload,
} from "../lib/markdown-to-document";

interface Props {
	documentId: string;
	title: string;
	projectId: string;
	className?: string;
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

export function DocumentDownloadDropdown({
	documentId,
	title,
	projectId,
	className,
}: Props) {
	const [isLoading, setIsLoading] = useState(false);

	const fetchContent = async (): Promise<string> => {
		const res = await orpcClient.projects.documents.get({
			projectId,
			id: documentId,
		});
		let content = res.document?.content ?? "";
		// Re-resolve S3 signed URLs so they're fresh for export
		content = await resolveS3Urls(content, projectId, documentId);
		return content;
	};

	const handleDownloadMd = async (e: React.MouseEvent) => {
		e.stopPropagation();
		setIsLoading(true);
		try {
			let content = await fetchContent();

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

	const handleDownloadPdf = async (e: React.MouseEvent) => {
		e.stopPropagation();
		setIsLoading(true);
		try {
			const content = await fetchContent();
			const blob = await renderMarkdownToPdf(content);
			triggerBlobDownload(blob, `${toSlug(title)}.pdf`);
		} catch (err: unknown) {
			toast.error(
				`Failed to generate PDF: ${err instanceof Error ? err.message : "Unknown error"}`,
			);
		} finally {
			setIsLoading(false);
		}
	};

	const handleDownloadDocx = async (e: React.MouseEvent) => {
		e.stopPropagation();
		setIsLoading(true);
		try {
			const content = await fetchContent();
			const blob = await renderMarkdownToDocx(content, title);
			triggerBlobDownload(blob, `${toSlug(title)}.docx`);
		} catch (err: unknown) {
			toast.error(
				`Failed to generate DOCX: ${err instanceof Error ? err.message : "Unknown error"}`,
			);
		} finally {
			setIsLoading(false);
		}
	};

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
			<DropdownMenuContent align="end" className="w-44">
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
			</DropdownMenuContent>
		</DropdownMenu>
	);
}
