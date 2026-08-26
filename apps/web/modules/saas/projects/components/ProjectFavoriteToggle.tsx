"use client";

import { useOrganizationId } from "@saas/organizations/hooks/use-organization-context";
import { PROJECT_SHORTCUTS_BASE_KEY } from "@saas/projects/hooks/use-project-shortcuts";
import { useFeatureFlag } from "@saas/shared/components/FeatureFlagProvider";
import { createTenantQueryKey } from "@shared/hooks/use-tenant-query";
import { orpcClient } from "@shared/lib/orpc-client";
import { orpc } from "@shared/lib/orpc-query-utils";
import { useMutation, useQueryClient } from "@tanstack/react-query";
import { Button } from "@ui/components/button";
import {
	Tooltip,
	TooltipContent,
	TooltipTrigger,
} from "@ui/components/tooltip";
import { cn } from "@ui/lib";
import { StarIcon } from "lucide-react";
import { useState } from "react";
import { toast } from "sonner";

interface Props {
	projectId: string;
	projectName: string;
	isFavorite: boolean;
	/**
	 * `row` reveals on hover the way the decisions-list pin does — for list and
	 * card surfaces where a persistent star would be visual noise. `inline`
	 * stays visible, for the project header's action cluster.
	 */
	variant?: "row" | "inline";
	className?: string;
}

/**
 * Star control for a project (#1694), shared by the projects list (both
 * renderings) and the project header.
 *
 * Two details are easy to lose and both are real defects if lost:
 *
 * - **The hover reveal is scoped to fine pointers.** A coarse pointer never
 *   fires hover, so an unscoped `opacity-0` leaves an invisible but still
 *   hit-testable control sitting on a card whose own tap navigates away —
 *   nobody could favorite from a phone, and some would navigate by accident.
 *
 * - **Propagation stops here.** Every host surface is itself clickable.
 */
export function ProjectFavoriteToggle({
	projectId,
	projectName,
	isFavorite,
	variant = "row",
	className,
}: Props) {
	const enabled = useFeatureFlag("PROJECT_FAVORITES");
	const queryClient = useQueryClient();
	const organizationId = useOrganizationId();
	// Optimistic state lives here rather than in a cache patch: three different
	// list shapes host this control, and patching all of them would couple the
	// control to each one's row type.
	const [optimistic, setOptimistic] = useState<boolean | null>(null);

	const current = optimistic ?? isFavorite;

	const toggle = useMutation({
		mutationFn: (next: boolean) =>
			orpcClient.projects.setFavorite({
				projectId,
				favorited: next,
				organizationId: organizationId ?? null,
			}),
		onMutate: (next: boolean) => {
			setOptimistic(next);
		},
		onError: (_error, next) => {
			setOptimistic(null);
			toast.error(
				next
					? "Could not add this project to your favorites"
					: "Could not remove this project from your favorites",
				{
					action: {
						label: "Retry",
						onClick: () => toggle.mutate(next),
					},
				},
			);
		},
		// Only on success: a failed toggle changed nothing server-side, so
		// invalidating would fire two refetches that return what is already
		// cached.
		// Async so TanStack awaits it before onSettled clears the optimistic
		// value — otherwise the star flickers back to a prop the refetch has not
		// refreshed yet.
		onSuccess: async () => {
			// Every key here is DERIVED, never hand-built. A filter is compared
			// against the real key from index zero: the shortcut query is
			// registered as `["tenant", orgId, ...base]`, and oRPC registers
			// `[["projects","list"], {...}]` — so a flat `["projects"]` filter
			// compares a string against an array and matches nothing at all.
			// Getting this wrong is silent: the star flips optimistically, then
			// reverts to a prop that never refreshed.
			queryClient.invalidateQueries({
				queryKey: createTenantQueryKey(
					organizationId,
					PROJECT_SHORTCUTS_BASE_KEY,
				),
			});
			queryClient.invalidateQueries({
				queryKey: orpc.projects.list.key(),
			});
			await Promise.all([
				queryClient.invalidateQueries({
					queryKey: orpc.projects.get.key({
						input: { id: projectId },
					}),
				}),
				// "Shared with me" renders the same card from a different query.
				// This diff added isFavorite to that read specifically to feed
				// this control, so it has to be invalidated with the others.
				queryClient.invalidateQueries({
					queryKey: orpc.projects.listGuest.key(),
				}),
			]);
		},
		// The optimistic value must clear on both paths.
		onSettled: () => {
			setOptimistic(null);
		},
	});

	if (!enabled) {
		return null;
	}

	const label = current
		? `Remove ${projectName} from favorites`
		: `Add ${projectName} to favorites`;

	return (
		<Tooltip>
			<TooltipTrigger asChild>
				<Button
					type="button"
					variant="ghost"
					size="icon"
					aria-label={label}
					aria-pressed={current}
					disabled={toggle.isPending}
					onClick={(event) => {
						// The card and the table row are themselves navigable.
						event.preventDefault();
						event.stopPropagation();
						toggle.mutate(!current);
					}}
					className={cn(
						"size-7 shrink-0 transition-opacity",
						current
							? "text-primary hover:text-primary"
							: "text-muted-foreground hover:text-foreground",
						variant === "row" &&
							!current && [
								"opacity-0 focus-visible:opacity-100 group-hover:opacity-100",
								// Touch and stylus never hover.
								"pointer-coarse:opacity-100",
							],
						className,
					)}
				>
					<StarIcon
						className={cn("size-4", current && "fill-current")}
					/>
				</Button>
			</TooltipTrigger>
			<TooltipContent>{label}</TooltipContent>
		</Tooltip>
	);
}
