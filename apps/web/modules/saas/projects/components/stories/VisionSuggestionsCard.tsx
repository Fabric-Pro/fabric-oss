"use client";

import { useMutation, useQueryClient } from "@tanstack/react-query";
import { Button } from "@ui/components/button";
import { CheckIcon, CompassIcon, Loader2Icon } from "lucide-react";
import { useState } from "react";
import { toast } from "sonner";
import { orpcClient } from "../../../../shared/lib/orpc-client";

/**
 * Explore intake (plan Slice 6): the purpose / core actions / cycle the
 * analysis inferred from the conversation. Mirrors `visionSuggestions` on
 * `ChangeProposalSchema` (packages/temporal … analyze-context.ts).
 */
export type VisionSuggestions = {
	purpose?: string | null;
	coreActions?: string[] | null;
	cycle?: string | null;
};

export function hasVisionSuggestions(
	suggestions: VisionSuggestions | null | undefined,
): suggestions is VisionSuggestions {
	if (!suggestions) {
		return false;
	}
	return Boolean(
		suggestions.purpose?.trim() ||
			(suggestions.coreActions?.length ?? 0) > 0 ||
			suggestions.cycle?.trim(),
	);
}

type Props = {
	suggestions: VisionSuggestions;
	projectId: string;
	organizationId?: string | null;
};

/**
 * Renders the inferred vision next to a proposal and lets an editor apply
 * it to the project's vision fields via `projects.update` (PROJECT_UPDATE).
 */
export function VisionSuggestionsCard({
	suggestions,
	projectId,
	organizationId,
}: Props) {
	const queryClient = useQueryClient();
	const [applied, setApplied] = useState(false);

	const applyMutation = useMutation({
		mutationFn: async () => {
			return await orpcClient.projects.update({
				id: projectId,
				organizationId: organizationId ?? null,
				visionPurpose: suggestions.purpose?.trim() || null,
				visionCoreActions: (suggestions.coreActions ?? [])
					.map((a) => a.trim())
					.filter((a) => a.length > 0),
				visionCycle: suggestions.cycle?.trim() || null,
			});
		},
		onSuccess: () => {
			setApplied(true);
			void queryClient.invalidateQueries({ queryKey: ["projects"] });
			toast.success("Project vision updated");
		},
		onError: (error) => {
			toast.error(
				error instanceof Error
					? error.message
					: "Could not update the project vision",
			);
		},
	});

	const coreActions = (suggestions.coreActions ?? []).filter(
		(a) => a.trim().length > 0,
	);

	return (
		<div
			className="rounded-md border border-border/60 bg-muted/30 p-3 space-y-2"
			data-testid="vision-suggestions"
		>
			<div className="flex items-center gap-2">
				<CompassIcon
					className="size-4 text-muted-foreground"
					aria-hidden="true"
				/>
				<p className="text-xs font-medium uppercase tracking-[0.18em] text-muted-foreground">
					Inferred vision
				</p>
			</div>
			<dl className="space-y-1.5 text-xs">
				{suggestions.purpose?.trim() && (
					<div>
						<dt className="font-medium text-foreground">Purpose</dt>
						<dd className="text-muted-foreground">
							{suggestions.purpose}
						</dd>
					</div>
				)}
				{coreActions.length > 0 && (
					<div>
						<dt className="font-medium text-foreground">
							Core actions
						</dt>
						<dd className="text-muted-foreground">
							{coreActions.join(" · ")}
						</dd>
					</div>
				)}
				{suggestions.cycle?.trim() && (
					<div>
						<dt className="font-medium text-foreground">Cycle</dt>
						<dd className="text-muted-foreground">
							{suggestions.cycle}
						</dd>
					</div>
				)}
			</dl>
			<Button
				type="button"
				size="sm"
				variant="outline"
				className="gap-2"
				onClick={() => applyMutation.mutate()}
				disabled={applied || applyMutation.isPending}
			>
				{applyMutation.isPending ? (
					<Loader2Icon
						className="size-3.5 motion-safe:animate-spin"
						aria-hidden="true"
					/>
				) : applied ? (
					<CheckIcon className="size-3.5" aria-hidden="true" />
				) : null}
				{applied
					? "Applied to project vision"
					: "Apply to project vision"}
			</Button>
		</div>
	);
}
