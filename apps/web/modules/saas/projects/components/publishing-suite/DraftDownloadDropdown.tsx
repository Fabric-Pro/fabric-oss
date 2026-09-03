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
import {
	renderMarkdownToDocx,
	renderMarkdownToPdf,
	toSlug,
	triggerBlobDownload,
} from "../../lib/markdown-to-document";

/**
 * Markdown / PDF / DOCX download for a publishing WORKING DRAFT (Fizzy #1854,
 * Phase 2C-1).
 *
 * A sibling of `DocumentDownloadDropdown`, not a reuse of it, and the split is
 * about inputs rather than styling. That component takes a `documentId`, fetches
 * the project document through oRPC and re-signs its S3 image URLs before
 * exporting. A publishing draft has neither: its text is already in the page —
 * the panel is rendering it in a textarea — and it carries no media. Passing a
 * draft through the document path would mean inventing a document id for a row
 * that has none, and re-fetching text the reader can see would export something
 * other than what is on screen.
 *
 * So this takes `(markdown, filename)`. The caller owns the string, which is
 * also what lets the Case Study panel prefix its caveat block: the safety
 * fields live OUTSIDE the editable body, and an export that dropped them would
 * hand someone a clean-looking PDF of a draft that is a scaffold with an
 * approval-needed customer identity. See `composeExportMarkdown` in
 * `CaseStudyPanel.tsx`, which also documents why `CopyDraftButton` beside this
 * control is handed the bare body instead.
 */
export function DraftDownloadDropdown({
	markdown,
	filename,
	disabled = false,
}: {
	/** Exactly what should land in the file, caveats included. */
	markdown: string;
	/** Base name, slugified here. The extension is added per format. */
	filename: string;
	disabled?: boolean;
}) {
	const [isBusy, setIsBusy] = useState(false);
	const slug = toSlug(filename);

	/**
	 * One wrapper for all three formats.
	 *
	 * `renderMarkdownToPdf`/`Docx` dynamically import jspdf and docx, so both
	 * can fail on a slow or offline client long after the click. A rejected
	 * promise with no catch is an unhandled rejection and a button that just
	 * stops responding — the reader clicks again, and again.
	 */
	const run = async (label: string, produce: () => Promise<void>) => {
		setIsBusy(true);
		try {
			await produce();
		} catch (error: unknown) {
			toast.error(
				`Could not build the ${label} file: ${
					error instanceof Error ? error.message : "unknown error"
				}`,
			);
		} finally {
			setIsBusy(false);
		}
	};

	const downloadMarkdown = () =>
		run("Markdown", async () => {
			const blob = new Blob([markdown], {
				type: "text/markdown;charset=utf-8",
			});
			triggerBlobDownload(blob, `${slug}.md`);
		});

	const downloadPdf = () =>
		run("PDF", async () => {
			triggerBlobDownload(
				await renderMarkdownToPdf(markdown),
				`${slug}.pdf`,
			);
		});

	const downloadDocx = () =>
		run("Word", async () => {
			triggerBlobDownload(
				await renderMarkdownToDocx(markdown, filename),
				`${slug}.docx`,
			);
		});

	return (
		<DropdownMenu>
			<DropdownMenuTrigger asChild>
				<Button
					type="button"
					variant="outline"
					size="sm"
					aria-label="Download draft"
					disabled={disabled || isBusy}
				>
					{isBusy ? (
						<Loader2Icon
							className="mr-2 size-4 motion-safe:animate-spin"
							aria-hidden="true"
						/>
					) : (
						<DownloadIcon
							className="mr-2 size-4"
							aria-hidden="true"
						/>
					)}
					Download
				</Button>
			</DropdownMenuTrigger>
			<DropdownMenuContent align="start" className="w-44">
				<DropdownMenuItem
					onClick={() => {
						void downloadMarkdown();
					}}
				>
					<FileCodeIcon className="mr-2 size-4" aria-hidden="true" />
					Markdown (.md)
				</DropdownMenuItem>
				<DropdownMenuItem
					onClick={() => {
						void downloadPdf();
					}}
				>
					<FileTextIcon className="mr-2 size-4" aria-hidden="true" />
					PDF (.pdf)
				</DropdownMenuItem>
				<DropdownMenuItem
					onClick={() => {
						void downloadDocx();
					}}
				>
					<FileTextIcon className="mr-2 size-4" aria-hidden="true" />
					Word (.docx)
				</DropdownMenuItem>
			</DropdownMenuContent>
		</DropdownMenu>
	);
}
