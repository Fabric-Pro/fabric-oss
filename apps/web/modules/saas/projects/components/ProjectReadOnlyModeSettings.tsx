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
import { Badge } from "@ui/components/badge";
import { Card } from "@ui/components/card";
import { Label } from "@ui/components/label";
import { Switch } from "@ui/components/switch";
import { cn } from "@ui/lib";
import { EyeIcon, LockIcon } from "lucide-react";
import { useEffect, useState } from "react";
import { toast } from "sonner";

/** Where the gate stops writes. Kept in step with the gate call sites. */
const BLOCKED_DESTINATIONS = [
	"Jira",
	"Azure DevOps",
	"GitLab",
	"Confluence",
	"Teams/Slack",
	"Google Docs",
	"Notion",
	"Code repositories",
] as const;

const DISABLED_REASON_ID = "project-read-only-mode-disabled-reason";

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

	return (
		<Card
			className={cn(
				"space-y-3.5 px-4 py-5 sm:px-6",
				checked && "border-highlight/40",
			)}
		>
			<div className="flex items-start justify-between gap-4">
				<div className="flex min-w-0 gap-3.5">
					<div
						aria-hidden="true"
						className={cn(
							"flex size-9 shrink-0 items-center justify-center rounded-lg border bg-background",
							checked
								? "text-highlight"
								: "text-muted-foreground",
						)}
					>
						<EyeIcon className="size-[18px]" />
					</div>
					<div className="min-w-0">
						<div className="flex flex-wrap items-center gap-2">
							<Label htmlFor="project-read-only-mode">
								Read-only mode
							</Label>
							<Badge
								variant={checked ? "warning" : "info"}
								className="bg-transparent"
							>
								{checked ? "On" : "Off"}
							</Badge>
						</div>
						<p className="mt-1 max-w-2xl text-pretty text-muted-foreground text-sm">
							Fabric won&apos;t create, update, or delete anything
							in this project&apos;s connected sources. Reading
							and syncing data in continues to work.
						</p>
					</div>
				</div>
				{/* For non-admins the Switch uses aria-disabled (not `disabled`)
				    so it stays keyboard-focusable and its reason stays
				    reachable. The onCheckedChange guard is what actually blocks
				    the change; aria-disabled + the dimmed style convey "not
				    operable". */}
				<Switch
					id="project-read-only-mode"
					checked={checked}
					aria-disabled={!canEdit}
					aria-label="Read-only mode"
					aria-describedby={canEdit ? undefined : DISABLED_REASON_ID}
					className={cn(
						"mt-1.5",
						!canEdit && "cursor-not-allowed opacity-50",
					)}
					onCheckedChange={(next) => {
						// Non-admins can't change it (server enforces too), and a
						// write in flight is ignored so concurrent PATCHes can't
						// resolve out of order.
						if (!canEdit || updateMutation.isPending) {
							return;
						}
						setOverride(next);
						updateMutation.mutate(next);
					}}
				/>
			</div>

			<div className="flex flex-wrap items-center gap-1.5 sm:pl-[50px]">
				<span className="mr-0.5 text-muted-foreground text-xs">
					Blocks writes to
				</span>
				{BLOCKED_DESTINATIONS.map((name) => (
					<span
						key={name}
						className="inline-flex items-center whitespace-nowrap rounded-full border bg-background px-2.5 py-0.5 text-foreground text-xs"
					>
						{name}
					</span>
				))}
				<span className="text-muted-foreground text-xs">
					and others
				</span>
			</div>
			<p className="text-pretty text-muted-foreground text-xs sm:pl-[50px]">
				Applies to the AI Assistant, automated agents, and coding runs.
				Automations not linked to this project are not affected. Useful
				while onboarding a project and validating integrations.
			</p>

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
			{!canEdit && (
				<p
					id={DISABLED_REASON_ID}
					className="flex items-center gap-1.5 text-muted-foreground text-xs sm:pl-[50px]"
				>
					<LockIcon aria-hidden="true" className="size-3" />
					Only project admins or owners can change Read-only mode.
				</p>
			)}
		</Card>
	);
}
