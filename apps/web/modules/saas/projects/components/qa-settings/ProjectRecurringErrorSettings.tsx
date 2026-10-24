"use client";

/**
 * Recurring-error detection toggle — whether a scheduled scan reads this
 * project's application logs (and its open bug reports) and proposes a bug
 * for each problem that keeps recurring.
 *
 * Instant-save like the test-case generation toggles above it: one column on
 * `Project`, written through `projects.update`. The last scan's outcome is
 * shown beneath, so a scan that cannot reach its log source is visible here
 * rather than looking like a quiet project. The log source the scan reads is
 * set below the toggle (`ProjectLogSourceSettings`).
 */

import { orpcClient } from "@shared/lib/orpc-client";
import { orpc } from "@shared/lib/orpc-query-utils";
import { useMutation, useQueryClient } from "@tanstack/react-query";
import { Card } from "@ui/components/card";
import { Label } from "@ui/components/label";
import { Switch } from "@ui/components/switch";
import { useFormatter, useTranslations } from "next-intl";
import { useEffect, useState } from "react";
import { toast } from "sonner";
import { ProjectLogSourceSettings } from "./ProjectLogSourceSettings";
import { ProjectRecurringErrorTuning } from "./ProjectRecurringErrorTuning";

export function ProjectRecurringErrorSettings({
	project,
	canEdit,
}: {
	project: {
		id: string;
		organizationId?: string | null;
		autoDetectRecurringErrors?: boolean | null;
		recurringErrorThreshold?: number | null;
		recurringErrorWindowHours?: number | null;
		recurringErrorSimilarityThreshold?: number | null;
		recurringErrorLastScanAt?: Date | string | null;
		recurringErrorLastScanError?: string | null;
		logSourceProvider?: string | null;
		logSourceConfig?: unknown;
	};
	canEdit: boolean;
}) {
	const t = useTranslations("projects.recurringErrors");
	const format = useFormatter();
	const queryClient = useQueryClient();
	const projectId = project.id;
	const organizationId = project.organizationId ?? null;
	const enabledOnServer = project.autoDetectRecurringErrors ?? false;
	const [enabled, setEnabled] = useState(enabledOnServer);

	// Re-seed from the server whenever the project reloads, so a save made in
	// another tab is not overwritten by stale local state.
	useEffect(() => {
		setEnabled(enabledOnServer);
	}, [enabledOnServer]);

	const mutation = useMutation({
		mutationFn: async (next: boolean) =>
			orpcClient.projects.update({
				id: projectId,
				organizationId,
				autoDetectRecurringErrors: next,
			}),
		onSuccess: () => {
			toast.success(t("updated"));
			queryClient.invalidateQueries({
				queryKey: orpc.projects.get.queryKey({
					input: { id: projectId, organizationId },
				}),
			});
		},
		onError: (error) =>
			toast.error(
				error instanceof Error ? error.message : t("updateFailed"),
			),
	});

	const lastScanAt = project.recurringErrorLastScanAt
		? new Date(project.recurringErrorLastScanAt)
		: null;
	const lastError = project.recurringErrorLastScanError ?? null;

	return (
		<Card className="p-6">
			<div className="max-w-xl space-y-3">
				<div className="flex items-start justify-between gap-4">
					<div className="space-y-1">
						<Label htmlFor="qa-recurring-errors">
							{t("toggleLabel")}
						</Label>
						<p
							id="qa-recurring-errors-desc"
							className="text-muted-foreground text-xs"
						>
							{t("toggleDescription", {
								threshold: project.recurringErrorThreshold ?? 5,
								windowHours:
									project.recurringErrorWindowHours ?? 24,
							})}
						</p>
					</div>
					<Switch
						id="qa-recurring-errors"
						checked={enabled}
						onCheckedChange={(next) => {
							const previous = enabled;
							setEnabled(next);
							mutation.mutate(next, {
								onError: () => setEnabled(previous),
							});
						}}
						disabled={!canEdit || mutation.isPending}
						aria-label={t("toggleLabel")}
						aria-describedby="qa-recurring-errors-desc"
					/>
				</div>

				{enabled && (
					<p className="text-muted-foreground text-xs">
						{lastScanAt
							? t("lastScan", {
									when: format.relativeTime(lastScanAt),
								})
							: t("neverScanned")}
					</p>
				)}
				{enabled && lastError && (
					<p className="text-destructive text-xs" role="alert">
						{t("lastScanFailed", { reason: lastError })}
					</p>
				)}
				{!canEdit && (
					<p className="text-muted-foreground text-xs">
						{t("adminOnly")}
					</p>
				)}

				<ProjectRecurringErrorTuning
					project={project}
					canEdit={canEdit}
				/>
				<ProjectLogSourceSettings project={project} canEdit={canEdit} />
			</div>
		</Card>
	);
}
