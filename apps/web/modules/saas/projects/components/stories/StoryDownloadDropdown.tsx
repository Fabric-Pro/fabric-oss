"use client";

/**
 * Reusable Download dropdown for a single feature.
 *
 * Mirrors `DocumentDownloadDropdown.tsx` visually and behaviourally — a
 * Markdown / PDF / Word menu rendered from a `Button` trigger with a leading
 * `DownloadIcon`. Used in three places (workspace header, editor sheet
 * header, kebab submenu) per spec §3.1 / §5.1.
 *
 * Key behaviours:
 *   - Stub features keep the menu items enabled but fail at click time with
 *     a warning toast (`projects.stories.download.stubBlocked`). This is
 *     intentional — a disabled item gives no feedback about why.
 *   - PDF / DOCX renderers are dynamically imported from
 *     `markdown-to-document.ts` so they stay out of the initial bundle.
 *   - The Markdown variant builds a plain `text/markdown` Blob directly.
 *   - The icon variant carries an `aria-label` and a `<Tooltip>` per
 *     `fabric/standards/frontend/tooltips.md`.
 */

import { Button } from "@ui/components/button";
import {
	DropdownMenu,
	DropdownMenuContent,
	DropdownMenuItem,
	DropdownMenuTrigger,
} from "@ui/components/dropdown-menu";
import {
	Tooltip,
	TooltipContent,
	TooltipTrigger,
} from "@ui/components/tooltip";
import {
	DownloadIcon,
	FileCodeIcon,
	FileTextIcon,
	Loader2Icon,
} from "lucide-react";
import { useTranslations } from "next-intl";
import { useState } from "react";
import { toast } from "sonner";
import {
	isStoryStub,
	serializeStoryToMarkdown,
} from "../../lib/stories/story-to-markdown";
import type { UserStory } from "../../lib/stories/types";

export interface StoryDownloadProjectRef {
	id: string;
	name: string;
}

type StoryDownloadVariant = "icon" | "button";

export interface StoryDownloadDropdownProps {
	story: UserStory;
	project: StoryDownloadProjectRef;
	/** Visual variant — `"icon"` for kebab/sheet header, `"button"` for workspace header. Defaults to `"button"`. */
	variant?: StoryDownloadVariant;
	/** Optional override for the trigger label when `variant === "button"`. */
	triggerLabel?: string;
}

/**
 * Per-format click handlers extracted from `StoryDownloadDropdown`. Group 6's
 * `StoryCard` kebab reuses this hook so the dynamic-import / blob plumbing
 * lives in exactly one place.
 */
export function useStoryDownloadActions(
	story: UserStory,
	project: StoryDownloadProjectRef,
) {
	const t = useTranslations("projects.stories.download");
	const [isPending, setIsPending] = useState(false);

	const buildMarkdown = (): string =>
		serializeStoryToMarkdown(
			story,
			{ name: project.name },
			{ generatedAt: new Date().toISOString() },
		);

	const safeFilename = (ext: string): string => {
		// Avoid a hard runtime dep on `markdown-to-document.ts` from this hook
		// signature (the Group 4 i18n tests run without DOM); replicate the
		// existing `toSlug` semantics inline so downloads stay on parity with
		// `DocumentDownloadDropdown`.
		const stem =
			`${story.identifier}-${story.title}`
				.toLowerCase()
				.replace(/[^a-z0-9]+/g, "-")
				.replace(/^-+|-+$/g, "")
				.slice(0, 80) || "feature";
		return `${stem}.${ext}`;
	};

	const guardStub = (): boolean => {
		if (isStoryStub(story)) {
			toast.warning(t("stubBlocked"));
			return true;
		}
		return false;
	};

	const downloadMarkdown = async () => {
		if (guardStub()) {
			return;
		}
		try {
			const markdown = buildMarkdown();
			const blob = new Blob([markdown], {
				type: "text/markdown;charset=utf-8",
			});
			const { triggerBlobDownload } = await import(
				"../../lib/markdown-to-document"
			);
			triggerBlobDownload(blob, safeFilename("md"));
		} catch (err) {
			console.error("[StoryDownload] markdown failed", err);
			toast.error(t("failed"));
		}
	};

	const downloadPdf = async () => {
		if (guardStub()) {
			return;
		}
		setIsPending(true);
		try {
			const markdown = buildMarkdown();
			const { renderMarkdownToPdf, triggerBlobDownload } = await import(
				"../../lib/markdown-to-document"
			);
			const blob = await renderMarkdownToPdf(markdown);
			triggerBlobDownload(blob, safeFilename("pdf"));
		} catch (err) {
			console.error("[StoryDownload] pdf failed", err);
			toast.error(t("failed"));
		} finally {
			setIsPending(false);
		}
	};

	const downloadDocx = async () => {
		if (guardStub()) {
			return;
		}
		setIsPending(true);
		try {
			const markdown = buildMarkdown();
			const { renderMarkdownToDocx, triggerBlobDownload } = await import(
				"../../lib/markdown-to-document"
			);
			const blob = await renderMarkdownToDocx(markdown, story.title);
			triggerBlobDownload(blob, safeFilename("docx"));
		} catch (err) {
			console.error("[StoryDownload] docx failed", err);
			toast.error(t("failed"));
		} finally {
			setIsPending(false);
		}
	};

	return { downloadMarkdown, downloadPdf, downloadDocx, isPending };
}

export function StoryDownloadDropdown({
	story,
	project,
	variant = "button",
	triggerLabel,
}: StoryDownloadDropdownProps) {
	const t = useTranslations("projects.stories.download");
	const tTooltips = useTranslations("tooltips.stories");
	const { downloadMarkdown, downloadPdf, downloadDocx, isPending } =
		useStoryDownloadActions(story, project);

	const trigger =
		variant === "icon" ? (
			<Tooltip>
				<TooltipTrigger asChild>
					<DropdownMenuTrigger asChild>
						<Button
							variant="ghost"
							size="icon"
							className="size-8"
							aria-label={tTooltips("storyDownload")}
							disabled={isPending}
							onClick={(e) => e.stopPropagation()}
						>
							{isPending ? (
								<Loader2Icon className="size-4 motion-safe:animate-spin" />
							) : (
								<DownloadIcon className="size-4" />
							)}
						</Button>
					</DropdownMenuTrigger>
				</TooltipTrigger>
				<TooltipContent>{tTooltips("storyDownload")}</TooltipContent>
			</Tooltip>
		) : (
			<DropdownMenuTrigger asChild>
				<Button
					variant="outline"
					size="sm"
					disabled={isPending}
					onClick={(e) => e.stopPropagation()}
				>
					{isPending ? (
						<Loader2Icon className="mr-2 size-4 motion-safe:animate-spin" />
					) : (
						<DownloadIcon className="mr-2 size-4" />
					)}
					<span>{triggerLabel ?? t("action")}</span>
				</Button>
			</DropdownMenuTrigger>
		);

	return (
		<DropdownMenu>
			{trigger}
			<DropdownMenuContent align="end" className="w-44">
				<DropdownMenuItem
					onClick={(e) => {
						e.stopPropagation();
						void downloadMarkdown();
					}}
				>
					<FileCodeIcon className="mr-2 size-4" />
					{t("format.markdown")}
				</DropdownMenuItem>
				<DropdownMenuItem
					onClick={(e) => {
						e.stopPropagation();
						void downloadPdf();
					}}
				>
					<FileTextIcon className="mr-2 size-4" />
					{t("format.pdf")}
				</DropdownMenuItem>
				<DropdownMenuItem
					onClick={(e) => {
						e.stopPropagation();
						void downloadDocx();
					}}
				>
					<FileTextIcon className="mr-2 size-4" />
					{t("format.docx")}
				</DropdownMenuItem>
			</DropdownMenuContent>
		</DropdownMenu>
	);
}
