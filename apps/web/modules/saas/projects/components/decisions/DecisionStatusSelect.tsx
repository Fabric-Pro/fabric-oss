"use client";

import { orpc } from "@shared/lib/orpc-query-utils";
import { useMutation, useQueryClient } from "@tanstack/react-query";
import { Badge } from "@ui/components/badge";
import {
	Select,
	SelectContent,
	SelectItem,
	SelectTrigger,
} from "@ui/components/select";
import { cn } from "@ui/lib";
import { toast } from "sonner";
import {
	DECISION_STATUSES,
	type DecisionStatus,
	STATUS_CONFIG,
} from "./constants";

export function DecisionStatusBadge({
	status,
	className,
}: {
	status: DecisionStatus;
	className?: string;
}) {
	const cfg = STATUS_CONFIG[status];
	return (
		<Badge
			variant="outline"
			className={cn("gap-1.5", cfg.badgeClassName, className)}
		>
			<span className={cn("size-1.5 rounded-full", cfg.dotClassName)} />
			{cfg.label}
		</Badge>
	);
}

type Props = {
	projectId: string;
	decisionId: string;
	value: DecisionStatus;
	canEdit: boolean;
	organizationId?: string | null;
	onChanged?: () => void;
};

/** Inline status control — a quick-change dropdown for editors, a badge otherwise. */
export function DecisionStatusSelect({
	projectId,
	decisionId,
	value,
	canEdit,
	organizationId,
	onChanged,
}: Props) {
	const queryClient = useQueryClient();

	const mutation = useMutation(
		orpc.projects.architectureDecisions.update.mutationOptions({
			onSuccess: () => {
				queryClient.invalidateQueries({
					queryKey: orpc.projects.architectureDecisions.get.queryKey({
						input: {
							projectId,
							id: decisionId,
							organizationId: organizationId ?? null,
						},
					}),
				});
				queryClient.invalidateQueries({
					queryKey:
						orpc.projects.architectureDecisions.versions.list.queryKey(
							{
								input: {
									projectId,
									architectureDecisionId: decisionId,
									organizationId: organizationId ?? null,
								},
							},
						),
				});
				onChanged?.();
			},
			onError: (error) =>
				toast.error(`Failed to update status: ${error.message}`),
		}),
	);

	if (!canEdit) {
		return <DecisionStatusBadge status={value} />;
	}

	return (
		<Select
			value={value}
			disabled={mutation.isPending}
			onValueChange={(v) =>
				mutation.mutate({
					projectId,
					id: decisionId,
					organizationId: organizationId ?? null,
					status: v as DecisionStatus,
				})
			}
		>
			<SelectTrigger
				aria-label="Change status"
				className="h-auto w-auto gap-1 rounded-full border-0 bg-transparent p-0.5 shadow-none transition-colors hover:bg-accent focus:ring-0 focus:ring-offset-0 data-[state=open]:bg-accent [&>svg]:size-3.5 [&>svg]:opacity-50 hover:[&>svg]:opacity-90"
			>
				<DecisionStatusBadge status={value} />
			</SelectTrigger>
			<SelectContent>
				{DECISION_STATUSES.map((s) => (
					<SelectItem key={s} value={s}>
						{STATUS_CONFIG[s].label}
					</SelectItem>
				))}
			</SelectContent>
		</Select>
	);
}
