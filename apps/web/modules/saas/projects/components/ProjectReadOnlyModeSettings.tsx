"use client";

/**
 * ProjectReadOnlyModeSettings — the project-level Read-only mode toggle.
 * While enabled, Fabric blocks outbound writes to connected
 * external sources (PM tools, docs, chat integrations, diagram sync, code
 * repositories via coding runs) for this project — including writes from the
 * AI Assistant, automated agents, and project-bound agent replies. Reading
 * and syncing data IN continues to work. Automations with no project binding
 * (org-level agents, Weave workflows not linked to a project) are outside a
 * per-project toggle's reach — see the gate call sites for the boundary list.
 *
 * Visible to every project member (the state must always be readable);
 * toggleable only by project admins/owners. The `projects.update` procedure
 * enforces the admin/owner rule server-side regardless.
 */

import { orpcClient } from "@shared/lib/orpc-client";
import { orpc } from "@shared/lib/orpc-query-utils";
import { useMutation, useQueryClient } from "@tanstack/react-query";
import { Card } from "@ui/components/card";
import { Label } from "@ui/components/label";
import { Switch } from "@ui/components/switch";
import {
	Tooltip,
	TooltipContent,
	TooltipTrigger,
} from "@ui/components/tooltip";
import { EyeIcon } from "lucide-react";
import { useEffect, useState } from "react";
import { toast } from "sonner";

type Props = {
	project: {
		id: string;
		organizationId?: string | null;
		readOnlyMode?: boolean | null;
	};
	canEdit: boolean;
};

export function ProjectReadOnlyModeSettings({ project, canEdit }: Props) {
	const queryClient = useQueryClient();

	// Optimistic override so the switch flips instantly; the prop catches up
	// after the refetch and clears the override (same pattern as the
	// auto-push toggle in ProjectManagementSettings).
	const [override, setOverride] = useState<boolean | null>(null);
	const checked = override ?? project.readOnlyMode ?? false;

	useEffect(() => {
		if (override !== null && (project.readOnlyMode ?? false) === override) {
			setOverride(null);
		}
	}, [project.readOnlyMode, override]);

	const updateMutation = useMutation({
		mutationFn: async (readOnlyMode: boolean) => {
			return await orpcClient.projects.update({
				id: project.id,
				organizationId: project.organizationId,
				readOnlyMode,
			});
		},
		onSuccess: (_data, readOnlyMode) => {
			toast.success(
				readOnlyMode
					? "Read-only mode enabled — Fabric will not write to connected sources."
					: "Read-only mode disabled — writes to connected sources resume.",
			);
			// Invalidate the exact namespaced key that feeds the project prop
			// (orpc.projects.get). A bare ["projects", id] partial key does NOT
			// match it — mirror the auto-push toggle's invalidation.
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
					: "Failed to update Read-only mode",
			);
		},
	});

	// For non-admins the Switch uses aria-disabled (not `disabled`) so it stays
	// keyboard-focusable — a natively-disabled <button> takes neither focus nor
	// pointer events, which would make the tooltip and its reason unreachable by
	// keyboard/AT. The onCheckedChange guard below is what actually blocks the
	// change; aria-disabled + the dimmed style convey "not operable".
	const toggle = (
		<Switch
			id="project-read-only-mode"
			checked={checked}
			aria-disabled={!canEdit}
			aria-label="Read-only mode"
			aria-describedby={
				canEdit ? undefined : "project-read-only-mode-disabled-reason"
			}
			className={canEdit ? undefined : "cursor-not-allowed opacity-50"}
			onCheckedChange={(next) => {
				// Non-admins can't change it (server enforces too), and a write
				// in flight is ignored so concurrent PATCHes can't resolve out
				// of order.
				if (!canEdit || updateMutation.isPending) {
					return;
				}
				setOverride(next);
				updateMutation.mutate(next);
			}}
		/>
	);

	return (
		<Card className="p-6">
			<div className="space-y-3">
				<div className="flex items-center justify-between">
					<div className="flex-1 pr-4">
						<Label htmlFor="project-read-only-mode">
							Read-only mode
						</Label>
						<p className="text-sm text-muted-foreground mt-1">
							While enabled, Fabric — including the AI Assistant,
							automated agents, and coding runs — will not create,
							update, or delete anything in this project&apos;s
							connected sources (Jira, Azure DevOps, GitLab,
							Confluence, Teams/Slack, Google Docs, Notion, code
							repositories, and others). Reading and syncing data
							in continues to work. Automations not linked to this
							project are not affected. Useful while onboarding a
							project and validating integrations.
						</p>
					</div>
					{canEdit ? (
						toggle
					) : (
						<Tooltip>
							<TooltipTrigger asChild>{toggle}</TooltipTrigger>
							<TooltipContent
								id="project-read-only-mode-disabled-reason"
								role="note"
							>
								Only project admins or owners can change
								Read-only mode.
							</TooltipContent>
						</Tooltip>
					)}
				</div>
				{checked && (
					<div
						data-testid="read-only-mode-active"
						className="flex items-center gap-2 rounded-lg border border-highlight/40 bg-highlight/10 px-3 py-2 text-sm"
					>
						<EyeIcon
							aria-hidden="true"
							className="size-4 shrink-0 text-highlight"
						/>
						<span>
							Read-only mode is on — outbound writes to connected
							sources are blocked for this project.
						</span>
					</div>
				)}
			</div>
		</Card>
	);
}
