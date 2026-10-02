"use client";

import { Button } from "@ui/components/button";
import { DialogFooter } from "@ui/components/dialog";
import {
	Tooltip,
	TooltipContent,
	TooltipTrigger,
} from "@ui/components/tooltip";
import { LoaderIcon, SparklesIcon } from "lucide-react";
import { useTranslations } from "next-intl";
import type { FileSourceForm } from "../hooks/use-file-source-form";
import type { TextSourceForm } from "../hooks/use-text-source-form";
import type { UrlSourceForm } from "../hooks/use-url-source-form";
import { parseBulkUrlLines, URL_BULK_MAX_LINES } from "../lib/url-source";

type ContextSourceSubmitFooterProps = {
	/** The form tab showing; it decides what submits and why it may not. */
	tab: "file" | "link" | "text";
	file: FileSourceForm;
	link: UrlSourceForm;
	text: TextSourceForm;
	isLoading: boolean;
	onCancel: () => void;
};

/**
 * Cancel and submit for the File, Link and Text tabs. The submit button says
 * what it will do ("Upload 3 files", "Add 2 URLs") and, while it cannot, says
 * why in its tooltip.
 */
export function ContextSourceSubmitFooter({
	tab,
	file,
	link,
	text,
	isLoading,
	onCancel,
}: ContextSourceSubmitFooterProps) {
	const t = useTranslations("tooltips.contextSources");

	const handleSubmit = () => {
		switch (tab) {
			case "file":
				file.upload();
				break;
			case "link":
				link.submit();
				break;
			case "text":
				text.submit();
				break;
		}
	};

	// When the Link tab is active and no scrape-capable
	// provider is configured (commit 3 of 3: widened from
	// "no Firecrawl" to "no provider at all"), disable
	// submit and switch the tooltip to the configuration
	// hint. PATH_PREFIX additionally requires
	// a crawl-capable provider — we disable submit too
	// when that's selected and only non-crawl providers
	// are enabled (matches the server pre-flight).
	const linkTabUnconfigured = tab === "link" && !link.hasAnyScrapeCapable;
	const linkTabPathPrefixNeedsCrawl =
		tab === "link" &&
		link.hasAnyScrapeCapable &&
		!link.hasCrawlCapable &&
		link.values.scope === "PATH_PREFIX";

	// Bulk-mode submit-disabled: parse the textarea on
	// every render so the button enabled state stays in
	// lock-step with the live preview the user sees.
	// Cap enforcement is identical to the inline note —
	// the message + the disable share one source of truth.
	const bulkParsed =
		tab === "link" && link.bulkMode === "MULTI"
			? parseBulkUrlLines(link.bulkRaw)
			: null;
	const bulkValidCount =
		bulkParsed?.filter((l) => l.url !== null).length ?? 0;
	const bulkInvalidCount =
		bulkParsed?.filter((l) => l.url === null).length ?? 0;
	const bulkOverLimit = bulkValidCount > URL_BULK_MAX_LINES;
	const linkTabBulkBlocked =
		tab === "link" &&
		link.bulkMode === "MULTI" &&
		(bulkValidCount === 0 || bulkOverLimit || bulkInvalidCount > 0);

	// File tab — submit disabled when no queueable file is
	// present (only `failed` rows, or zero rows). Spec §7.5.
	const queueableFileCount = tab === "file" ? file.queueableCount : 0;
	const fileTabBlocked = tab === "file" && queueableFileCount === 0;

	const linkTabBlocked =
		linkTabUnconfigured ||
		linkTabPathPrefixNeedsCrawl ||
		linkTabBulkBlocked;
	const submitDisabled = isLoading || linkTabBlocked || fileTabBlocked;
	const submitTooltip = linkTabUnconfigured
		? "Configure a search provider in Settings → Search Providers to add URL sources."
		: linkTabPathPrefixNeedsCrawl
			? "Path-prefix crawls require Firecrawl. Configure Firecrawl in Settings → Search Providers, or pick Single page."
			: linkTabBulkBlocked && bulkOverLimit
				? `Batches are limited to ${URL_BULK_MAX_LINES} URLs at a time.`
				: linkTabBulkBlocked && bulkInvalidCount > 0
					? "Fix or remove the invalid lines listed below the textarea."
					: linkTabBulkBlocked
						? "Paste at least one valid URL to enable submit."
						: fileTabBlocked
							? "Drop or pick at least one file to upload."
							: t("submitContext");

	// Button copy: in bulk mode + idle state, surface the
	// live count so users see what they're about to fire.
	const isBulk = tab === "link" && link.bulkMode === "MULTI";
	const showBulkCountCopy = isBulk && !isLoading && bulkValidCount > 0;
	// File tab — switch to "Upload" / "Upload N files" copy
	// per spec §7.5 once at least one file is queued. The
	// generic "Add Context" copy still renders when the
	// queue is empty so the disabled button reads naturally.
	const showFileUploadCopy =
		tab === "file" && !isLoading && queueableFileCount > 0;

	return (
		<DialogFooter className="mt-4">
			<Button variant="outline" onClick={onCancel} disabled={isLoading}>
				Cancel
			</Button>
			<Tooltip>
				<TooltipTrigger asChild>
					{/*
					 * Wrapper span keeps the tooltip
					 * reachable when the button is
					 * disabled — Radix Tooltip skips
					 * pointer events on disabled
					 * children. The button retains
					 * aria-disabled so screen readers
					 * still announce the state.
					 */}
					<span
						className="inline-flex"
						tabIndex={submitDisabled ? 0 : undefined}
					>
						<Button
							onClick={handleSubmit}
							disabled={submitDisabled}
							aria-disabled={submitDisabled}
							className="gap-2"
						>
							{isLoading ? (
								<>
									<LoaderIcon className="size-4 motion-safe:animate-spin" />
									Processing...
								</>
							) : showBulkCountCopy ? (
								<>
									<SparklesIcon className="size-4" />
									Add {bulkValidCount} URL
									{bulkValidCount === 1 ? "" : "s"}
								</>
							) : showFileUploadCopy ? (
								<>
									<SparklesIcon className="size-4" />
									{queueableFileCount === 1
										? "Upload"
										: `Upload ${queueableFileCount} files`}
								</>
							) : (
								<>
									<SparklesIcon className="size-4" />
									Add Context
								</>
							)}
						</Button>
					</span>
				</TooltipTrigger>
				<TooltipContent>{submitTooltip}</TooltipContent>
			</Tooltip>
		</DialogFooter>
	);
}
