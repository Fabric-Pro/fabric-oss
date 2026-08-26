"use client";

/**
 * QA sign-offs on a feature — who has approved it, and how many the project
 * wants before it can be marked done.
 *
 * Renders nothing at all when the project requires none, which is the default.
 * A section that says "0 of 0 required" on every feature in every project that
 * never asked for the control is noise, and this panel already has plenty.
 */

import { orpc } from "@shared/lib/orpc-query-utils";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { Button } from "@ui/components/button";
import { cn } from "@ui/lib";
import { CheckCircle2Icon, Loader2Icon } from "lucide-react";
import { toast } from "sonner";

export function QaSignOffSection({
	projectId,
	storyId,
	canEdit,
	currentUserId,
}: {
	projectId: string;
	storyId: string;
	canEdit: boolean;
	currentUserId: string;
}) {
	const queryClient = useQueryClient();

	const query = useQuery(
		orpc.projects.testCases.signOffs.get.queryOptions({
			input: { projectId, storyId },
		}),
	);

	const invalidate = () =>
		queryClient.invalidateQueries({
			queryKey: orpc.projects.testCases.signOffs.get.key(),
		});

	const record = useMutation(
		orpc.projects.testCases.signOffs.record.mutationOptions({
			onSuccess: () => {
				toast.success("Testing sign-off recorded");
				invalidate();
			},
			onError: (error) => toast.error(error.message),
		}),
	);

	const revoke = useMutation(
		orpc.projects.testCases.signOffs.revoke.mutationOptions({
			onSuccess: () => {
				toast.success("Testing sign-off withdrawn");
				invalidate();
			},
			onError: (error) => toast.error(error.message),
		}),
	);

	const data = query.data;
	// Hidden entirely when the gate is off — see the module comment.
	if (!data || data.required === 0) {
		return null;
	}

	const mine = data.signOffs.find((s) => s.signedById === currentUserId);
	const pending = record.isPending || revoke.isPending;

	return (
		<section className="rounded-lg border p-4">
			<div className="flex flex-wrap items-start justify-between gap-3">
				<div className="min-w-0">
					<p className="font-medium text-[11px] text-muted-foreground uppercase tracking-[0.2em]">
						Testing sign-off
					</p>
					<p className="mt-2 font-medium text-sm">
						{data.recorded} of {data.required} recorded
					</p>
					<p className="mt-1 text-muted-foreground text-xs">
						{data.satisfied
							? "This feature has the approvals it needs to be marked done."
							: `This feature cannot be marked done until ${data.required} ${
									data.required === 1
										? "person signs"
										: "people sign"
								} it off.`}
					</p>
				</div>

				{canEdit && (
					<Button
						variant={mine ? "outline" : "primary"}
						size="sm"
						disabled={pending}
						onClick={() =>
							mine
								? revoke.mutate({ projectId, storyId })
								: record.mutate({ projectId, storyId })
						}
					>
						{pending && (
							<Loader2Icon
								className="mr-2 size-3.5 motion-safe:animate-spin"
								aria-hidden="true"
							/>
						)}
						{mine ? "Withdraw my sign-off" : "Sign off"}
					</Button>
				)}
			</div>

			{data.signOffs.length > 0 && (
				<ul className="mt-3 space-y-1.5">
					{data.signOffs.map((signOff) => (
						<li
							key={signOff.id}
							className="flex items-center gap-2 text-sm"
						>
							<CheckCircle2Icon
								className={cn(
									"size-3.5 shrink-0",
									"text-secondary",
								)}
								aria-hidden="true"
							/>
							<span className="truncate">
								{signOff.signedByLabel}
							</span>
							{signOff.signedById === currentUserId && (
								<span className="text-muted-foreground text-xs">
									(you)
								</span>
							)}
						</li>
					))}
				</ul>
			)}
		</section>
	);
}
