"use client";

import {
	MATURATION_STATUS_META,
	MATURATION_STATUS_OPTIONS,
	type MaturationStatus,
} from "@saas/projects/lib/stories/types";
import { orpcClient } from "@shared/lib/orpc-client";
import { orpc } from "@shared/lib/orpc-query-utils";
import { useMutation, useQueryClient } from "@tanstack/react-query";
import { Card } from "@ui/components/card";
import { Label } from "@ui/components/label";
import { Switch } from "@ui/components/switch";
import { Loader2Icon } from "lucide-react";
import { useCallback, useEffect, useState } from "react";
import { toast } from "sonner";

type Project = {
	id: string;
	organizationId?: string | null;
	hiddenMaturationStatuses?: string[] | null;
};

type Props = {
	project: Project;
	canEdit?: boolean;
};

const normalizeHiddenStatuses = (
	raw: string[] | null | undefined,
): MaturationStatus[] => {
	if (!raw) {
		return [];
	}
	return raw.filter((s): s is MaturationStatus =>
		MATURATION_STATUS_OPTIONS.includes(s as MaturationStatus),
	);
};

export function ProjectStageVisibilitySettings({
	project,
	canEdit = true,
}: Props) {
	const queryClient = useQueryClient();

	const [hiddenStatuses, setHiddenStatuses] = useState<MaturationStatus[]>(
		normalizeHiddenStatuses(project.hiddenMaturationStatuses),
	);

	useEffect(() => {
		setHiddenStatuses(
			normalizeHiddenStatuses(project.hiddenMaturationStatuses),
		);
	}, [project.hiddenMaturationStatuses]);

	const updateMutation = useMutation({
		mutationFn: async (nextHidden: MaturationStatus[]) => {
			return await orpcClient.projects.update({
				id: project.id,
				organizationId: project.organizationId,
				hiddenMaturationStatuses: nextHidden,
			});
		},
		onSuccess: (_, nextHidden) => {
			setHiddenStatuses(nextHidden);
			toast.success("Stage visibility updated");
			queryClient.invalidateQueries({
				queryKey: orpc.projects.get.queryKey({
					input: {
						id: project.id,
						organizationId: project.organizationId ?? null,
					},
				}),
			});
		},
		onError: (error) => {
			toast.error(
				error instanceof Error
					? error.message
					: "Failed to update stage visibility",
			);
		},
	});

	const toggleStatus = useCallback(
		(statusKey: MaturationStatus, hide: boolean) => {
			const nextHidden = hide
				? Array.from(new Set([...hiddenStatuses, statusKey]))
				: hiddenStatuses.filter((s) => s !== statusKey);
			updateMutation.mutate(nextHidden);
		},
		[hiddenStatuses, updateMutation],
	);

	const visibleCount = MATURATION_STATUS_OPTIONS.filter(
		(statusKey) => !hiddenStatuses.includes(statusKey),
	).length;

	return (
		<Card className="p-6">
			<div className="space-y-4">
				<div>
					<div className="flex items-center justify-between">
						<h3 className="text-base font-semibold text-foreground">
							Feature Maturation V2 Stage Visibility
						</h3>
						{updateMutation.isPending && (
							<Loader2Icon className="size-4 animate-spin text-muted-foreground" />
						)}
					</div>
					<p className="text-sm text-muted-foreground mt-1">
						Choose which stage options appear in the Feature
						Maturation V2 dropdown menu for team members in this
						project. At least one stage must remain visible.
					</p>
				</div>

				<div className="space-y-3 divide-y divide-border/60">
					{MATURATION_STATUS_OPTIONS.map((statusKey) => {
						const meta = MATURATION_STATUS_META[statusKey];
						const isHidden = hiddenStatuses.includes(statusKey);
						const isLastVisible = !isHidden && visibleCount <= 1;

						return (
							<div
								key={statusKey}
								className="flex items-center justify-between pt-3 first:pt-0"
							>
								<div className="flex items-center gap-2.5">
									<span
										className="size-2.5 rounded-full shrink-0"
										style={{ backgroundColor: meta.color }}
									/>
									<div>
										<Label className="font-medium text-sm text-foreground">
											{meta.label}
										</Label>
										<p className="text-xs text-muted-foreground">
											{isHidden
												? "Hidden from dropdown"
												: isLastVisible
													? "Visible (At least one stage required)"
													: "Visible in dropdown"}
										</p>
									</div>
								</div>
								<Switch
									checked={!isHidden}
									disabled={
										!canEdit ||
										updateMutation.isPending ||
										isLastVisible
									}
									onCheckedChange={(visible) =>
										toggleStatus(statusKey, !visible)
									}
									aria-label={`Toggle visibility for ${meta.label} stage`}
								/>
							</div>
						);
					})}
				</div>
			</div>
		</Card>
	);
}
