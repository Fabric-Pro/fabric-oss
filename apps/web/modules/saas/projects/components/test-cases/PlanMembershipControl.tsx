"use client";

import { orpc } from "@shared/lib/orpc-query-utils";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { Button } from "@ui/components/button";
import {
	Select,
	SelectContent,
	SelectItem,
	SelectTrigger,
	SelectValue,
} from "@ui/components/select";
import { PlusIcon, XIcon } from "lucide-react";
import { useTranslations } from "next-intl";
import { useState } from "react";
import { toast } from "sonner";

// ---------------------------------------------------------------------------
// Plan membership — add the case to / remove it from plans (edit-mode).
// ---------------------------------------------------------------------------

export function PlanMembershipControl({
	projectId,
	organizationId,
	testCaseId,
	memberships,
	canEdit,
	onChanged,
}: {
	projectId: string;
	organizationId: string | null;
	testCaseId: string;
	memberships: {
		id: string;
		planId: string;
		identifier: string;
		name: string;
	}[];
	canEdit: boolean;
	onChanged: () => void;
}) {
	const t = useTranslations("projects.testCases");
	const queryClient = useQueryClient();
	const [planToAdd, setPlanToAdd] = useState<string>("");

	const { data: plansData } = useQuery({
		...orpc.projects.testCases.plans.list.queryOptions({
			input: { projectId, organizationId },
		}),
		enabled: canEdit,
	});
	const plans = plansData?.items ?? [];
	const memberPlanIds = new Set(memberships.map((m) => m.planId));
	const addable = plans.filter((p) => !memberPlanIds.has(p.id));

	const refresh = () => {
		queryClient.invalidateQueries({
			queryKey: orpc.projects.testCases.get.queryKey({
				input: { projectId, testCaseId, organizationId },
			}),
		});
		onChanged();
	};

	const addMutation = useMutation(
		orpc.projects.testCases.plans.addCase.mutationOptions({
			onSuccess: () => {
				toast.success(t("toasts.addedToPlan"));
				setPlanToAdd("");
				refresh();
			},
			onError: (e) =>
				toast.error(t("toasts.addToPlanFailed", { error: e.message })),
		}),
	);
	const removeMutation = useMutation(
		orpc.projects.testCases.plans.removeCase.mutationOptions({
			onSuccess: () => {
				toast.success(t("toasts.removedFromPlan"));
				refresh();
			},
			onError: (e) =>
				toast.error(
					t("toasts.removeFromPlanFailed", { error: e.message }),
				),
		}),
	);

	return (
		<div className="space-y-2">
			<p className="app-editorial-label">{t("plans.heading")}</p>
			{memberships.length === 0 ? (
				<p className="text-muted-foreground text-sm">
					{t("membership.empty")}
				</p>
			) : (
				<ul className="flex flex-wrap gap-1.5">
					{memberships.map((m) => (
						<li
							key={m.id}
							className="inline-flex items-center gap-1.5 rounded-md border bg-card px-2 py-1 text-sm"
						>
							<span className="font-mono text-muted-foreground text-xs">
								{m.identifier}
							</span>
							<span className="max-w-40 truncate">{m.name}</span>
							{canEdit && (
								<button
									type="button"
									onClick={() =>
										removeMutation.mutate({
											projectId,
											organizationId,
											planId: m.planId,
											testCaseId,
										})
									}
									aria-label={t("membership.removeFromAria", {
										name: m.name,
									})}
									className="rounded-full text-muted-foreground transition-colors hover:text-destructive"
								>
									<XIcon className="size-3.5" />
								</button>
							)}
						</li>
					))}
				</ul>
			)}
			{canEdit && addable.length > 0 && (
				<div className="flex items-center gap-2 pt-1">
					<Select value={planToAdd} onValueChange={setPlanToAdd}>
						<SelectTrigger className="h-9 w-full sm:w-56">
							<SelectValue
								placeholder={t("membership.addPlaceholder")}
							/>
						</SelectTrigger>
						<SelectContent>
							{addable.map((p) => (
								<SelectItem key={p.id} value={p.id}>
									{p.identifier} · {p.name}
								</SelectItem>
							))}
						</SelectContent>
					</Select>
					<Button
						type="button"
						variant="outline"
						size="sm"
						disabled={!planToAdd || addMutation.isPending}
						onClick={() =>
							addMutation.mutate({
								projectId,
								organizationId,
								planId: planToAdd,
								testCaseId,
							})
						}
					>
						<PlusIcon className="mr-1 size-4" aria-hidden="true" />
						{t("actions.add")}
					</Button>
				</div>
			)}
		</div>
	);
}
