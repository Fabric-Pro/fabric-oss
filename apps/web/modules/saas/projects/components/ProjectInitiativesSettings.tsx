"use client";

import { orpcClient } from "@shared/lib/orpc-client";
import { orpc } from "@shared/lib/orpc-query-utils";
import { useMutation, useQueryClient } from "@tanstack/react-query";
import {
	AlertDialog,
	AlertDialogAction,
	AlertDialogCancel,
	AlertDialogContent,
	AlertDialogDescription,
	AlertDialogFooter,
	AlertDialogHeader,
	AlertDialogTitle,
} from "@ui/components/alert-dialog";
import { Card } from "@ui/components/card";
import { Label } from "@ui/components/label";
import { Switch } from "@ui/components/switch";
import { cn } from "@ui/lib";
import { Loader2Icon, LockIcon } from "lucide-react";
import { useEffect, useState } from "react";
import { toast } from "sonner";

const DISABLED_REASON_ID = "project-initiatives-disabled-reason";

type Props = {
	project: {
		id: string;
		organizationId?: string | null;
		initiativesEnabled?: boolean | null;
		initiativeCount?: number;
	};
	canEdit: boolean;
};

export function ProjectInitiativesSettings({ project, canEdit }: Props) {
	const queryClient = useQueryClient();

	const [override, setOverride] = useState<boolean | null>(null);
	const [pendingCount, setPendingCount] = useState<number | null>(null);
	const [checking, setChecking] = useState(false);

	const checked = override ?? project.initiativesEnabled ?? false;

	useEffect(() => {
		if (
			override !== null &&
			(project.initiativesEnabled ?? false) === override
		) {
			setOverride(null);
		}
	}, [project.initiativesEnabled, override]);

	const updateMutation = useMutation({
		mutationFn: async (initiativesEnabled: boolean) => {
			return await orpcClient.projects.update({
				id: project.id,
				organizationId: project.organizationId,
				initiativesEnabled,
			});
		},
		onSuccess: (_data, initiativesEnabled) => {
			toast.success(
				initiativesEnabled
					? "Initiatives enabled"
					: "Initiatives disabled",
			);
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
			setOverride(null);
			toast.error(
				error instanceof Error
					? error.message
					: "Failed to update Initiatives setting",
			);
		},
	});

	const handleToggle = async (next: boolean) => {
		if (!canEdit || updateMutation.isPending || checking) {
			return;
		}

		if (!next) {
			// The cached count can be stale; re-read it before deciding to warn.
			setChecking(true);
			try {
				const fresh = await queryClient.fetchQuery({
					...orpc.projects.get.queryOptions({
						input: {
							id: project.id,
							organizationId: project.organizationId ?? null,
						},
					}),
					staleTime: 0,
				});
				if ((fresh.project.initiativeCount ?? 0) > 0) {
					setPendingCount(fresh.project.initiativeCount);
					return;
				}
			} catch {
				toast.error(
					"Couldn't check for Initiatives. Please try again.",
				);
				return;
			} finally {
				setChecking(false);
			}
		}

		setOverride(next);
		updateMutation.mutate(next);
	};

	const confirmSwitchOff = () => {
		setPendingCount(null);
		setOverride(false);
		updateMutation.mutate(false);
	};

	return (
		<Card className="p-6">
			<div className="space-y-4">
				<div className="flex items-center justify-between">
					<h3 className="font-semibold text-foreground text-base">
						Work item types
					</h3>
					{(updateMutation.isPending || checking) && (
						<Loader2Icon className="size-4 animate-spin text-muted-foreground" />
					)}
				</div>

				<div className="flex items-center justify-between gap-4">
					<div className="space-y-0.5">
						<Label htmlFor="project-initiatives-switch">
							Initiatives
						</Label>
						<p className="text-muted-foreground text-sm">
							Group related Features under an Initiative.
						</p>
					</div>
					<Switch
						id="project-initiatives-switch"
						checked={checked}
						aria-disabled={!canEdit}
						aria-label="Initiatives"
						aria-describedby={
							canEdit ? undefined : DISABLED_REASON_ID
						}
						className={cn(
							!canEdit && "cursor-not-allowed opacity-50",
						)}
						onCheckedChange={handleToggle}
					/>
				</div>

				{!canEdit && (
					<p
						id={DISABLED_REASON_ID}
						className="flex items-center gap-1.5 text-muted-foreground text-xs"
					>
						<LockIcon aria-hidden="true" className="size-3" />
						Only project admins or owners can turn Initiatives on or
						off.
					</p>
				)}
			</div>

			<AlertDialog
				open={pendingCount !== null}
				onOpenChange={(open) => !open && setPendingCount(null)}
			>
				<AlertDialogContent>
					<AlertDialogHeader>
						<AlertDialogTitle>
							Turn off Initiatives?
						</AlertDialogTitle>
						<AlertDialogDescription>
							{pendingCount}{" "}
							{pendingCount === 1 ? "Initiative" : "Initiatives"}{" "}
							will be hidden from this project. They aren&apos;t
							deleted, and they come back when you turn
							Initiatives on again.
						</AlertDialogDescription>
					</AlertDialogHeader>
					<AlertDialogFooter>
						<AlertDialogCancel>Cancel</AlertDialogCancel>
						<AlertDialogAction onClick={confirmSwitchOff}>
							Turn off
						</AlertDialogAction>
					</AlertDialogFooter>
				</AlertDialogContent>
			</AlertDialog>
		</Card>
	);
}
