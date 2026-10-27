"use client";

import { useOrganizationContext } from "@saas/organizations/hooks/use-organization-context";
import { useMutation } from "@tanstack/react-query";
import { useTranslations } from "next-intl";
import { toast } from "sonner";
import { orpcClient } from "../../../../shared/lib/orpc-client";

type ExportFormat = "markdown" | "csv";

/**
 * Trigger a browser download for text content.
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
}

/**
 * Page-mounted export controller: calls
 * `projects.stories.exportScopeEstimate` and downloads the returned content
 * as markdown or CSV.
 */
export function useExportEstimate({ projectId }: Props) {
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

	return {
		exporting: mutation.isPending,
		exportEstimate: (format: ExportFormat) => mutation.mutate(format),
	};
}
