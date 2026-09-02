"use client";

import { orpc } from "@shared/lib/orpc-query-utils";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { Button } from "@ui/components/button";
import {
	Dialog,
	DialogContent,
	DialogDescription,
	DialogHeader,
	DialogTitle,
} from "@ui/components/dialog";
import {
	Tooltip,
	TooltipContent,
	TooltipTrigger,
} from "@ui/components/tooltip";
import { ArchiveIcon, SparklesIcon } from "lucide-react";
import { useState } from "react";
import { toast } from "sonner";

interface Props {
	projectId: string;
	organizationId?: string | null;
	open: boolean;
	onOpenChange: (open: boolean) => void;
	/** Refetch the decision log, whose rows render the type label. */
	onArchived?: () => void;
}

/**
 * Manage the project's decision-type taxonomy. Retiring a type is an archive,
 * not a delete: decisions already tagged with it keep showing their label, and
 * applying the same name again brings the original entry back.
 */
export function DecisionTypesDialog({
	projectId,
	organizationId,
	open,
	onOpenChange,
	onArchived,
}: Props) {
	const queryClient = useQueryClient();
	const [pendingId, setPendingId] = useState<string | null>(null);

	const typesQuery = useQuery(
		orpc.projects.architectureDecisions.types.list.queryOptions({
			input: { projectId, organizationId },
			enabled: open,
		}),
	);
	const types = typesQuery.data?.types ?? [];

	const refreshTypes = () =>
		queryClient.invalidateQueries({
			queryKey: orpc.projects.architectureDecisions.types.list.queryKey({
				input: { projectId, organizationId },
			}),
		});

	const restoreMutation = useMutation(
		orpc.projects.architectureDecisions.types.restore.mutationOptions({
			onSuccess: (data) => {
				toast.success(`Restored “${data.type.name}”`);
				refreshTypes();
				onArchived?.();
			},
			onError: (e) => toast.error(`Failed to restore: ${e.message}`),
		}),
	);

	const archiveMutation = useMutation(
		orpc.projects.architectureDecisions.types.archive.mutationOptions({
			onSuccess: (data) => {
				toast.success(`Retired “${data.type.name}”`, {
					action: {
						label: "Undo",
						onClick: () =>
							restoreMutation.mutate({
								projectId,
								organizationId,
								id: data.type.id,
							}),
					},
				});
				refreshTypes();
				// The log renders each decision's type label, so let the parent
				// refetch its own (filtered) list rather than guessing its key.
				onArchived?.();
			},
			onError: (e) => toast.error(`Failed to retire: ${e.message}`),
			onSettled: () => setPendingId(null),
		}),
	);

	return (
		<Dialog open={open} onOpenChange={onOpenChange}>
			<DialogContent className="sm:max-w-lg">
				<DialogHeader>
					<DialogTitle>Decision types</DialogTitle>
					<DialogDescription>
						Types grow as your team tags decisions. Retiring one
						removes it from the picker — decisions that already use
						it keep their label, and reusing the name brings it
						back.
					</DialogDescription>
				</DialogHeader>

				{typesQuery.isLoading ? (
					<p className="py-6 text-center text-muted-foreground text-sm">
						Loading types…
					</p>
				) : typesQuery.isError ? (
					// Distinct from the empty state on purpose: a failed fetch
					// rendering "No types yet" would tell the user their team has
					// never tagged a decision, which is a different — and false —
					// statement about their data.
					<div className="space-y-3 py-6 text-center">
						<p className="text-muted-foreground text-sm">
							Couldn’t load this project’s types.
						</p>
						<Button
							variant="outline"
							size="sm"
							onClick={() => typesQuery.refetch()}
						>
							Try again
						</Button>
					</div>
				) : types.length === 0 ? (
					<p className="py-6 text-center text-muted-foreground text-sm">
						No types yet. One is created the first time you tag a
						decision with a new label.
					</p>
				) : (
					<ul className="divide-y rounded-md border">
						{types.map((t) => (
							<li
								key={t.id}
								className="flex items-center justify-between gap-3 px-3 py-2"
							>
								<span className="flex min-w-0 items-center gap-2">
									<span className="truncate text-sm">
										{t.name}
									</span>
									{t.origin === "AI" && (
										<Tooltip>
											<TooltipTrigger asChild>
												<span className="inline-flex items-center gap-1 text-muted-foreground text-xs">
													<SparklesIcon
														className="size-3"
														aria-label="AI-suggested type"
													/>
													AI
												</span>
											</TooltipTrigger>
											<TooltipContent
												surface="popover"
												className="max-w-56"
											>
												Suggested by AI when a decision
												was captured.
											</TooltipContent>
										</Tooltip>
									)}
								</span>
								<Button
									variant="ghost"
									size="sm"
									aria-label={
										pendingId === t.id
											? `Retiring ${t.name}`
											: `Retire ${t.name}`
									}
									aria-busy={pendingId === t.id}
									// One source of truth: any retire in flight
									// disables the whole list, so a second click
									// cannot race the first.
									disabled={pendingId !== null}
									onClick={() => {
										setPendingId(t.id);
										archiveMutation.mutate({
											projectId,
											organizationId,
											id: t.id,
										});
									}}
								>
									<ArchiveIcon className="mr-2 size-4" />
									{pendingId === t.id
										? "Retiring…"
										: "Retire"}
								</Button>
							</li>
						))}
					</ul>
				)}
			</DialogContent>
		</Dialog>
	);
}
