"use client";

/**
 * Notion Resource Browser Dialog (MCP-based)
 *
 * Thin wrapper around NotionPageSelector for multi-page selection.
 * Fetches page content and creates project contexts on confirm.
 * Used by project context upload flows.
 */

import { orpcClient } from "@shared/lib/orpc-client";
import { useCallback, useState } from "react";
import { toast } from "sonner";
import { fetchNotionPageContent } from "../lib/notion-content-fetcher";
import {
	NotionPageSelector,
	type NotionPageSelectorResult,
} from "./NotionPageSelector";

type Props = {
	open: boolean;
	onOpenChange: (open: boolean) => void;
	mcpConfigId: string | null;
	projectId: string;
	organizationId: string | null;
	syncedPageIds?: string[];
	onResourcesAdded?: () => void;
};

export function NotionResourceBrowser({
	open,
	onOpenChange,
	mcpConfigId,
	projectId,
	organizationId,
	syncedPageIds = [],
	onResourcesAdded,
}: Props) {
	const [confirmLoading, setConfirmLoading] = useState(false);

	const handleConfirm = useCallback(
		(pages: NotionPageSelectorResult[]) => {
			if (!mcpConfigId || pages.length === 0) {
				return;
			}

			setConfirmLoading(true);

			(async () => {
				let addedCount = 0;

				try {
					for (const page of pages) {
						const { content, title, contentFetchFailed } =
							await fetchNotionPageContent({
								pageId: page.pageId,
								mcpConfigId,
								organizationId,
								fallbackTitle: page.title,
							});

						if (contentFetchFailed) {
							console.warn(
								`[NotionResourceBrowser] Failed to fetch content for "${page.title}"`,
							);
						}

						await orpcClient.projects.contexts.create({
							projectId,
							organizationId: organizationId ?? undefined,
							type: "INTEGRATION",
							content: content || "",
							metadata: {
								notionPageId: page.pageId,
								notionType: "page",
								mcpConfigId,
								provider: "notion",
								sourceTitle: title,
								sourceUrl: page.url || null,
							},
						});
						addedCount++;
					}

					toast.success(`Added ${addedCount} page(s) to project`);
					onResourcesAdded?.();
					onOpenChange(false);
				} catch (err) {
					toast.error("Failed to add pages", {
						description:
							err instanceof Error
								? err.message
								: "Unknown error",
					});
				} finally {
					setConfirmLoading(false);
				}
			})();
		},
		[
			mcpConfigId,
			projectId,
			organizationId,
			onResourcesAdded,
			onOpenChange,
		],
	);

	return (
		<NotionPageSelector
			open={open}
			onOpenChange={onOpenChange}
			mcpConfigId={mcpConfigId}
			organizationId={organizationId}
			onConfirm={handleConfirm}
			syncedPageIds={syncedPageIds}
			confirmLoading={confirmLoading}
		/>
	);
}
