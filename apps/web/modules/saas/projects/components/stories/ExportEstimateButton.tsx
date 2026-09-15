"use client";

import { useOrganizationContext } from "@saas/organizations/hooks/use-organization-context";
import { useMutation } from "@tanstack/react-query";
import { Button } from "@ui/components/button";
import {
	DropdownMenu,
	DropdownMenuContent,
	DropdownMenuItem,
	DropdownMenuTrigger,
} from "@ui/components/dropdown-menu";
import { DownloadIcon, Loader2Icon } from "lucide-react";
import { useTranslations } from "next-intl";
import { toast } from "sonner";
import { orpcClient } from "../../../../shared/lib/orpc-client";

type ExportFormat = "markdown" | "csv";

/**
 * Trigger a browser download for text content. Exported so the download
 * mechanics can be unit-tested without rendering the menu.
 */
function downloadTextFile(
	content: string,
	filename: string,
	mimeType: string,
): void {
	const blob = new Blob([content], { type: mimeType });
	const url = URL.createObjectURL(blob);
	const anchor = document.createElement("a");
	anchor.href = url;
	anchor.download = filename;
	anchor.rel = "noopener";
	document.body.appendChild(anchor);
	anchor.click();
	anchor.remove();
	URL.revokeObjectURL(url);
}

const MIME: Record<ExportFormat, string> = {
	markdown: "text/markdown;charset=utf-8",
	csv: "text/csv;charset=utf-8",
};

interface Props {
	projectId: string;
	className?: string;
}

/**
 * "Export estimate" menu for the roadmap (plan Slice 7): calls
 * `projects.stories.exportScopeEstimate` and downloads the returned content
 * as markdown or CSV.
 */
export function ExportEstimateButton({ projectId, className }: Props) {
	const t = useTranslations("projects.stories.scopeEstimate");
	const { organizationId } = useOrganizationContext();

	const mutation = useMutation({
		mutationFn: async (format: ExportFormat) => {
			const result =
				await orpcClient.projects.stories.exportScopeEstimate({
					projectId,
					organizationId: organizationId ?? null,
					format,
				});
			downloadTextFile(result.content, result.filename, MIME[format]);
			return result;
		},
		onSuccess: (result) => {
			toast.success(t("exported", { count: result.rowCount }));
		},
		onError: (error) => {
			toast.error(
				error instanceof Error ? error.message : t("exportFailed"),
			);
		},
	});

	return (
		<DropdownMenu>
			<DropdownMenuTrigger asChild>
				<Button
					variant="outline"
					size="sm"
					className={className ?? "gap-2"}
					disabled={mutation.isPending}
					aria-label={t("export")}
				>
					{mutation.isPending ? (
						<Loader2Icon
							className="size-4 motion-safe:animate-spin"
							aria-hidden="true"
						/>
					) : (
						<DownloadIcon className="size-4" aria-hidden="true" />
					)}
					{t("export")}
				</Button>
			</DropdownMenuTrigger>
			<DropdownMenuContent align="end">
				<DropdownMenuItem onSelect={() => mutation.mutate("markdown")}>
					{t("markdown")}
				</DropdownMenuItem>
				<DropdownMenuItem onSelect={() => mutation.mutate("csv")}>
					{t("csv")}
				</DropdownMenuItem>
			</DropdownMenuContent>
		</DropdownMenu>
	);
}
