"use client";

/**
 * Confluence Resource Browser Dialog (MCP-based)
 *
 * Thin wrapper around ConfluencePageSelector for multi-page selection.
 * Fetches page content via MCP, normalizes it, and creates project contexts on
 * confirm. Mirrors NotionResourceBrowser. Used by project context upload flows.
 */

import { orpcClient } from "@shared/lib/orpc-client";
import { useCallback, useState } from "react";
import { toast } from "sonner";
import { fetchConfluencePageContent } from "../lib/confluence-content-fetcher";
import { ConfluencePageSelector } from "./ConfluencePageSelector";

type ConfluencePageResult = {
	pageId: string;
	title: string;
	spaceKey: string;
	url?: string;
	mcpConfigId: string;
};

type Props = {
	open: boolean;
	onOpenChange: (open: boolean) => void;
	mcpConfigId: string | null;
	projectId: string;
	organizationId: string | null;
	syncedPageIds?: string[];
	onResourcesAdded?: () => void;
};

export function ConfluenceResourceBrowser({
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
		(pages: ConfluencePageResult[]) => {
			if (!mcpConfigId || pages.length === 0) {
				return;
			}

			setConfirmLoading(true);

			(async () => {
				let addedCount = 0;

				try {
					for (const page of pages) {
						const { content, title, contentFetchFailed } =
							await fetchConfluencePageContent({
								pageId: page.pageId,
								mcpConfigId,
								organizationId,
								fallbackTitle: page.title,
							});

						if (contentFetchFailed) {
							console.warn(
								`[ConfluenceResourceBrowser] Failed to fetch content for "${page.title}"`,
							);
						}

						await orpcClient.projects.contexts.create({
							projectId,
							organizationId: organizationId ?? undefined,
							type: "INTEGRATION",
							content: content || "",
							metadata: {
								confluencePageId: page.pageId,
								spaceKey: page.spaceKey,
								mcpConfigId,
								provider: "confluence",
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
		<ConfluencePageSelector
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
