"use client";

import { parseOutline } from "@repo/utils/glossy/outline";
import { EditorContent, useEditor } from "@tiptap/react";
import { Button } from "@ui/components/button";
import { Skeleton } from "@ui/components/skeleton";
import { cn } from "@ui/lib";
import { Loader2Icon, RefreshCwIcon } from "lucide-react";
import { useTranslations } from "next-intl";
import { useEffect, useId, useMemo, useRef } from "react";
import { fromMarkdown } from "../../lib/diff-utils";
import { isDocumentGenerationStale } from "../../lib/document-generation-timestamp";
import { advancedExtensions } from "../../lib/tiptap-extensions-advanced";
import { DocumentGenerationProgress } from "../DocumentGenerationProgress";
import "../DocumentEditor.css";

/**
 * The wrapper class of a Proposal's rendered Main in artifact mode, worn by
 * this pane and by the editor's container. `DocumentEditor.css` scopes the
 * larger type and the readable column to it.
 */
export const PROPOSAL_ARTIFACT_TYPOGRAPHY_CLASS = "proposal-artifact";

/**
 * How many whole sections a live preview holds, by the rule the worker cuts
 * it on: `##` and `###` headings, or the shallowest heading level below a
 * leading `#` title when neither is used. Headings inside fences are code.
 */
export function countLiveSections(markdown: string): number {
	const headings = parseOutline(markdown);
	const sections = headings.filter(
		(heading) => heading.level === 2 || heading.level === 3,
	);
	if (sections.length > 0) {
		return sections.length;
	}
	const candidates = headings[0]?.level === 1 ? headings.slice(1) : headings;
	if (candidates.length === 0) {
		return 0;
	}
	const level = Math.min(...candidates.map((heading) => heading.level));
	return candidates.filter((heading) => heading.level === level).length;
}

function toEditorHtml(markdown: string): string {
	try {
		return fromMarkdown(markdown);
	} catch (error) {
		console.error("[ProposalLiveSections] fromMarkdown failed:", error);
		return "";
	}
}

/**
 * Markdown rendered the way the editor renders a saved body: the same
 * markdown conversion and the same read-only Tiptap extensions, so diagrams
 * draw as diagrams. Each live write carries the whole preview so far, and
 * replacing the content in place keeps the sections already on screen (and
 * their diagrams) instead of rebuilding the editor on every write.
 */
function ReadOnlyDocument({ markdown }: { markdown: string }) {
	const html = useMemo(() => toEditorHtml(markdown), [markdown]);
	const editor = useEditor({
		extensions: advancedExtensions,
		content: html,
		editable: false,
		immediatelyRender: false,
		editorProps: {
			attributes: { class: "p-10 tiptap" },
		},
	});
	const appliedHtmlRef = useRef(html);

	useEffect(() => {
		if (!editor || editor.isDestroyed || appliedHtmlRef.current === html) {
			return;
		}
		appliedHtmlRef.current = html;
		editor.commands.setContent(html, { emitUpdate: false });
	}, [editor, html]);

	return (
		<div className="prose prose-sm max-w-none dark:prose-invert">
			<EditorContent editor={editor} />
		</div>
	);
}

export type ProposalLiveSectionsProps = {
	/** The sections saved so far by the running generation, if any. */
	liveContent: string | null | undefined;
	/** The document's saved body, shown dimmed until the first section lands. */
	savedContent: string | null | undefined;
	/** The server status: QUEUED or GENERATING. */
	status: string;
	progress: number;
	title?: string;
	generationError?: string | null;
	generationStartedAt?: Date | string | null;
	updatedAt?: Date | string | null;
	/** Starts the generation again; absent for readers who cannot. */
	onRetry?: () => void;
	isRetrying?: boolean;
};

/**
 * A Proposal's Main tab while its generation runs (Fizzy #2801): the editor is
 * hidden, and this pane shows the sections finished so far as they are saved.
 * Before the first one it hosts the generation progress (the queued wait, and
 * a Retry once a run stalls) above the previous body, dimmed, or a skeleton
 * for a document that has none yet.
 *
 * One polite region announces how many sections are ready. Nothing here moves
 * focus.
 */
/** The generation's progress once the agent's stream has ended (Fizzy #2801). */
const FINISHING_PROGRESS = 80;

export function ProposalLiveSections({
	liveContent,
	savedContent,
	status,
	progress,
	title,
	generationError,
	generationStartedAt,
	updatedAt,
	onRetry,
	isRetrying = false,
}: ProposalLiveSectionsProps) {
	const t = useTranslations("projects.proposalArtifactPage.live");
	const previousLabelId = useId();
	const live = liveContent?.trim() ? liveContent : "";
	const saved = savedContent?.trim() ? savedContent : "";
	const sectionCount = useMemo(
		() => (live ? countLiveSections(live) : 0),
		[live],
	);
	const isStalled = isDocumentGenerationStale(
		status,
		generationStartedAt,
		updatedAt,
	);

	return (
		<div
			className={cn(
				"h-full overflow-y-auto bg-background",
				PROPOSAL_ARTIFACT_TYPOGRAPHY_CLASS,
			)}
			data-testid="proposal-live-sections"
		>
			<output aria-live="polite" className="sr-only">
				{sectionCount > 0
					? t("sectionsReady", { count: sectionCount })
					: ""}
			</output>

			{live ? (
				<>
					<ReadOnlyDocument markdown={live} />
					<div className="flex flex-col items-center gap-3 px-6 pb-10 text-muted-foreground text-sm">
						<p className="flex items-center gap-2">
							<Loader2Icon
								className="size-4 motion-safe:animate-spin"
								aria-hidden="true"
							/>
							{/* The run writes progress 80 once the agent's stream has ended;
							    visuals and the final save follow, so nothing is being written. */}
							{progress >= FINISHING_PROGRESS
								? t("finishing")
								: t("writingNext")}
						</p>
						{isStalled && (
							<div className="flex flex-wrap items-center justify-center gap-3">
								<p>{t("stalled")}</p>
								{onRetry && (
									<Button
										type="button"
										variant="outline"
										size="sm"
										onClick={onRetry}
										loading={isRetrying}
									>
										<RefreshCwIcon
											className="size-4"
											aria-hidden="true"
										/>
										{t("retry")}
									</Button>
								)}
							</div>
						)}
					</div>
				</>
			) : (
				<>
					<div className="p-6">
						<DocumentGenerationProgress
							status={status}
							progress={progress}
							title={title}
							error={generationError}
							generationStartedAt={generationStartedAt}
							updatedAt={updatedAt}
							onRetry={onRetry}
							isRetrying={isRetrying}
							isRegenerating={saved.length > 0}
						/>
					</div>
					{saved ? (
						<section aria-labelledby={previousLabelId}>
							<p
								id={previousLabelId}
								className="px-10 text-muted-foreground text-xs"
							>
								{t("previousVersion")}
							</p>
							<div className="opacity-60">
								<ReadOnlyDocument markdown={saved} />
							</div>
						</section>
					) : (
						<div className="mx-auto w-full max-w-3xl space-y-4 px-10 pb-10">
							<p className="text-muted-foreground text-sm">
								{t("newDocument")}
							</p>
							<div className="space-y-3" aria-hidden="true">
								<Skeleton className="h-8 w-2/3" />
								<Skeleton className="h-4 w-full" />
								<Skeleton className="h-4 w-full" />
								<Skeleton className="h-4 w-5/6" />
								<Skeleton className="mt-6 h-6 w-1/2" />
								<Skeleton className="h-4 w-full" />
								<Skeleton className="h-4 w-4/6" />
							</div>
						</div>
					)}
				</>
			)}
		</div>
	);
}
