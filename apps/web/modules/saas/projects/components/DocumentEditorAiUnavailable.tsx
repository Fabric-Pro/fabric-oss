"use client";

import { Button } from "@ui/components/button";
import { AlertTriangleIcon, RefreshCwIcon } from "lucide-react";
import ReactMarkdown from "react-markdown";
import remarkGfm from "remark-gfm";

type Props = {
	/** The document's saved markdown, rendered read-only. */
	content: string;
	/** The error the boundary caught; its message is shown for support. */
	error: Error | null;
	/** Defaults to a full page reload. Injectable for tests. */
	onReload?: () => void;
};

function reloadPage() {
	window.location.reload();
}

/**
 * AI-free fallback for the document editor (Fizzy #2393).
 *
 * `<DocumentEditorPage>` mounts `<DocumentEditor>` inside `<CopilotKit>` and
 * wraps both in an error boundary. `<DocumentEditor>` calls `useCopilotChat`,
 * `useCoAgent` and friends unconditionally and renders `<CopilotSidebar>`, and
 * on CopilotKit 1.70 every one of those throws when no provider is mounted
 * above it — so the boundary's fallback cannot be `<DocumentEditor>` itself
 * (that was the previous fallback, and it threw the moment it rendered).
 *
 * This panel touches no CopilotKit hook. It keeps the document readable from
 * the markdown the page already fetched and offers a reload, which is the
 * only recovery that re-runs the initialization that just failed.
 */
export function DocumentEditorAiUnavailable({
	content,
	error,
	onReload = reloadPage,
}: Props) {
	return (
		<div
			className="h-full overflow-y-auto"
			data-testid="document-editor-ai-unavailable"
		>
			<div className="mx-auto w-full max-w-4xl space-y-6 p-6">
				<div
					role="alert"
					className="flex flex-col gap-3 rounded-lg border border-border bg-muted p-4 sm:flex-row sm:items-start"
				>
					<AlertTriangleIcon
						className="size-5 shrink-0 text-highlight"
						aria-hidden="true"
					/>
					<div className="min-w-0 flex-1 space-y-1">
						<p className="font-medium text-sm">
							The document assistant could not start
						</p>
						<p className="text-muted-foreground text-sm">
							Your document is shown read-only below. Editing and
							AI features return once the assistant loads. Reload
							the page to try again.
						</p>
						{error?.message ? (
							<p className="break-words font-mono text-muted-foreground text-xs">
								{error.message}
							</p>
						) : null}
					</div>
					<Button
						type="button"
						variant="outline"
						size="sm"
						className="shrink-0"
						onClick={onReload}
					>
						<RefreshCwIcon className="size-4" aria-hidden="true" />
						Reload page
					</Button>
				</div>
				<article className="prose prose-stone dark:prose-invert max-w-none rounded-xl border border-border bg-card p-8 prose-pre:overflow-auto prose-pre:bg-muted prose-pre:border prose-pre:border-border prose-headings:font-serif prose-headings:font-normal">
					{content.trim() ? (
						<ReactMarkdown remarkPlugins={[remarkGfm]}>
							{content}
						</ReactMarkdown>
					) : (
						<p className="text-muted-foreground">
							This document has no content yet.
						</p>
					)}
				</article>
			</div>
		</div>
	);
}
