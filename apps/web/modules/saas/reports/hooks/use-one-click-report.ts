"use client";

import { routeGenerateOutcome } from "@saas/reports/lib/report-generate-outcome";
import { orpc } from "@shared/lib/orpc-query-utils";
import { useMutation, useQueryClient } from "@tanstack/react-query";
import { useRouter } from "next/navigation";
import { useCallback, useRef, useState } from "react";
import { toast } from "sonner";

/**
 * "Generate report" on a template card: the server creates the report and starts
 * its run when nothing is missing. When something is, the dialog opens. When the
 * report exists and its run is refused, its page opens with the reason.
 */
export function useOneClickReport<T extends { id: string }>({
	projectId,
	organizationId,
	reportTemplatesPath,
	onNeedsSetup,
}: {
	projectId: string;
	organizationId: string | null;
	reportTemplatesPath: string;
	onNeedsSetup: (template: T) => void;
}) {
	const router = useRouter();
	const queryClient = useQueryClient();
	const [generating, setGenerating] = useState<T | null>(null);
	// The state reaches the button a render later; a second click must not.
	const inFlightRef = useRef(false);
	const { mutate } = useMutation(
		orpc.reports.instances.generateFromTemplate.mutationOptions(),
	);

	const generate = useCallback(
		(template: T) => {
			if (inFlightRef.current) {
				return;
			}
			inFlightRef.current = true;
			setGenerating(template);
			const release = () => {
				inFlightRef.current = false;
				setGenerating(null);
			};
			mutate(
				{ templateId: template.id, projectId, organizationId },
				{
					onSuccess: (result) => {
						if (result.outcome === "needs-setup") {
							release();
							onNeedsSetup(template);
							return;
						}
						// Stays pending until the route changes, so a click
						// meanwhile cannot start a second report.
						queryClient.invalidateQueries({
							queryKey: orpc.reports.instances.list.key(),
						});
						routeGenerateOutcome(
							result,
							reportTemplatesPath,
							router.push,
						);
					},
					onError: (error) => {
						release();
						toast.error(
							error.message || "Failed to generate the report",
						);
					},
				},
			);
		},
		[
			mutate,
			projectId,
			organizationId,
			onNeedsSetup,
			queryClient,
			reportTemplatesPath,
			router,
		],
	);

	return { generate, generatingTemplateId: generating?.id ?? null };
}
