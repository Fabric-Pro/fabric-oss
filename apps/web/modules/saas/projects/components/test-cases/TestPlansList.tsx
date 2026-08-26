"use client";

import { orpc } from "@shared/lib/orpc-query-utils";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { Button } from "@ui/components/button";
import { cn } from "@ui/lib";
import { formatDistanceToNow } from "date-fns";
import {
	ClipboardListIcon,
	Loader2Icon,
	PlusIcon,
	TriangleAlertIcon,
} from "lucide-react";
import { useTranslations } from "next-intl";
import { useState } from "react";
import { toast } from "sonner";
import type { TestPlanState } from "./constants";
import { PassRateBar, PassRateValue } from "./PassRateBar";
import { PlanFormDialog } from "./PlanFormDialog";
import { type PlanResultRollup, planPassRateView } from "./plan-pass-rate";
import { SectionHint } from "./SectionHint";
import { TestCaseStatusChip } from "./TestCaseStatusChip";

type Props = {
	projectId: string;
	organizationId: string | null;
	canEdit: boolean;
	onSelectPlan: (planId: string) => void;
};

/** The plan-card slice of a `plans.list` item (extra API fields are ignored). */
type PlanCardData = {
	id: string;
	identifier: string;
	name: string;
	description: string | null;
	state: TestPlanState;
	updatedAt: string | Date;
	_count: { caseLinks: number };
	resultRollup: PlanResultRollup | null;
};

/** The chips, in the order they read. `ALL` first so it is the obvious reset. */
const PLAN_STATE_FILTERS = ["ALL", "ACTIVE", "INACTIVE"] as const;
type PlanStateFilter = (typeof PLAN_STATE_FILTERS)[number];

export function TestPlansList({
	projectId,
	organizationId,
	canEdit,
	onSelectPlan,
}: Props) {
	const t = useTranslations("projects.testCases");
	const [createOpen, setCreateOpen] = useState(false);
	/**
	 * Client-side, unlike the cases filters. A project has a handful of plans,
	 * not hundreds, and the list is already fetched whole for the pass-rate
	 * rollup — so a round trip per chip would cost a request to filter six rows.
	 */
	const [stateFilter, setStateFilter] = useState<PlanStateFilter>("ALL");

	// `includePassRate` attaches each plan's `resultRollup` so the cards can render
	// the pass-rate bar in one batched query (no N+1).
	const { data, isLoading, isError, refetch } = useQuery(
		orpc.projects.testCases.plans.list.queryOptions({
			input: { projectId, organizationId, includePassRate: true },
		}),
	);
	const allPlans = data?.items ?? [];
	const plans =
		stateFilter === "ALL"
			? allPlans
			: allPlans.filter((p) => p.state === stateFilter);
	const counts = {
		ALL: allPlans.length,
		ACTIVE: allPlans.filter((p) => p.state === "ACTIVE").length,
		INACTIVE: allPlans.filter((p) => p.state === "INACTIVE").length,
	} as const;

	return (
		<div className="space-y-5">
			<div className="flex flex-wrap items-center justify-between gap-3">
				<div>
					<p className="app-editorial-label">
						{t("plans.heading")}
						<SectionHint
							className="ml-1.5 align-middle"
							label={t("plans.hintAria")}
							body={t("plans.hint")}
						/>
					</p>
					<p className="mt-1 text-muted-foreground text-sm">
						{t("plans.subtitle")}
					</p>
				</div>
				{canEdit && (
					<Button onClick={() => setCreateOpen(true)}>
						<PlusIcon className="mr-2 size-4" aria-hidden="true" />
						{t("actions.newPlan")}
					</Button>
				)}
			</div>

			{allPlans.length > 0 && (
				<div className="flex flex-wrap items-center gap-1.5">
					{PLAN_STATE_FILTERS.map((f) => (
						<Button
							key={f}
							type="button"
							size="sm"
							variant={stateFilter === f ? "primary" : "outline"}
							className="h-7 gap-1.5 rounded-full text-xs"
							aria-pressed={stateFilter === f}
							onClick={() => setStateFilter(f)}
						>
							{t(`plans.filters.${f.toLowerCase()}`)}
							<b className="font-semibold tabular-nums">
								{counts[f]}
							</b>
						</Button>
					))}
				</div>
			)}

			{isLoading ? (
				<div className="flex items-center justify-center py-16 text-muted-foreground">
					<Loader2Icon className="size-5 animate-spin" />
				</div>
			) : isError ? (
				/*
				 * A failed load must never render as "no test plans yet": that
				 * reads as a fact about the project, and the reader's next move
				 * is to create a plan that already exists.
				 */
				<div className="flex flex-col items-start gap-2 rounded-md border border-dashed border-border bg-muted/30 px-4 py-6">
					<p className="flex items-center gap-1.5 text-destructive text-sm">
						<TriangleAlertIcon
							className="size-4"
							aria-hidden="true"
						/>
						{t("errors.plansFailed")}
					</p>
					<Button
						type="button"
						size="sm"
						variant="outline"
						onClick={() => refetch()}
					>
						{t("actions.retry")}
					</Button>
				</div>
			) : plans.length === 0 ? (
				<EmptyPlans
					canEdit={canEdit}
					label={t("empty.plans")}
					onCreate={() => setCreateOpen(true)}
					createLabel={t("actions.newPlan")}
				/>
			) : (
				<ul className="grid grid-cols-1 gap-4 sm:grid-cols-2 xl:grid-cols-3">
					{plans.map((plan) => (
						<li key={plan.id}>
							<PlanCard
								plan={plan}
								onSelect={() => onSelectPlan(plan.id)}
							/>
						</li>
					))}
				</ul>
			)}

			<CreatePlanDialog
				projectId={projectId}
				organizationId={organizationId}
				open={createOpen}
				onOpenChange={setCreateOpen}
				onCreated={(planId) => onSelectPlan(planId)}
			/>
		</div>
	);
}

/**
 * A single plan as a warm-neutral card: identifier + state chip, name and
 * (clamped) description, a tokenized pass-rate bar with the passing %, and a
 * footer with the live case count and the last-updated time. The whole card is
 * the click target (opens the plan detail); it carries no nested interactive
 * elements, so a single `<button>` keeps it keyboard-accessible.
 */
function PlanCard({
	plan,
	onSelect,
}: {
	plan: PlanCardData;
	onSelect: () => void;
}) {
	const t = useTranslations("projects.testCases");
	const view = planPassRateView(plan.resultRollup);
	const updatedAt = new Date(plan.updatedAt);
	const validDate = !Number.isNaN(updatedAt.getTime());

	return (
		<div className="relative flex h-full flex-col gap-3 rounded-xl border bg-card p-4 transition-colors hover:border-primary/40 hover:bg-accent/50">
			<div className="flex items-center justify-between gap-2">
				<span className="font-mono text-muted-foreground text-xs tabular-nums">
					{plan.identifier}
				</span>
				<TestCaseStatusChip
					status={plan.state === "ACTIVE" ? "READY" : "CLOSED"}
					label={
						plan.state === "ACTIVE"
							? t("plans.active")
							: t("plans.inactive")
					}
				/>
			</div>

			<div className="space-y-1">
				{/* The plan name is the stretched click target for the card. */}
				<h3 className="font-medium text-sm">
					<button
						type="button"
						onClick={onSelect}
						className="line-clamp-1 break-words text-left after:absolute after:inset-0 after:rounded-xl focus:outline-none focus-visible:ring-2 focus-visible:ring-ring"
					>
						{plan.name}
					</button>
				</h3>
				<p
					className={cn(
						"line-clamp-2 text-xs",
						plan.description
							? "text-muted-foreground"
							: "text-muted-foreground/60 italic",
					)}
				>
					{plan.description || t("plans.card.noDescription")}
				</p>
			</div>

			<div className="mt-auto space-y-1.5">
				<div className="flex items-center justify-between">
					<span className="font-medium text-[11px] text-muted-foreground uppercase tracking-[0.14em]">
						{t("plans.card.passing")}
					</span>
					<PassRateValue view={view} />
				</div>
				<PassRateBar view={view} />
			</div>

			<div className="flex items-center justify-between gap-2 border-t pt-2.5 text-muted-foreground text-xs">
				<span className="tabular-nums">
					{t("caseCount", { count: plan._count.caseLinks })}
				</span>
				{validDate && (
					<time
						dateTime={updatedAt.toISOString()}
						title={updatedAt.toLocaleString()}
					>
						{t("plans.card.updated", {
							time: formatDistanceToNow(updatedAt, {
								addSuffix: true,
							}),
						})}
					</time>
				)}
			</div>
		</div>
	);
}

function EmptyPlans({
	canEdit,
	label,
	onCreate,
	createLabel,
}: {
	canEdit: boolean;
	label: string;
	onCreate: () => void;
	createLabel: string;
}) {
	return (
		<div
			className="flex flex-col items-center justify-center gap-3 rounded-xl border border-dashed py-16 text-center"
			style={{
				backgroundImage:
					"radial-gradient(circle, color-mix(in srgb, var(--muted-foreground) 13%, transparent) 1px, transparent 1px)",
				backgroundSize: "32px 32px",
			}}
		>
			<ClipboardListIcon className="size-8 text-muted-foreground/60" />
			<h3 className="font-serif text-xl font-normal">{label}</h3>
			{canEdit && (
				<Button onClick={onCreate}>
					<PlusIcon className="mr-2 size-4" aria-hidden="true" />
					{createLabel}
				</Button>
			)}
		</div>
	);
}

function CreatePlanDialog({
	projectId,
	organizationId,
	open,
	onOpenChange,
	onCreated,
}: {
	projectId: string;
	organizationId: string | null;
	open: boolean;
	onOpenChange: (open: boolean) => void;
	onCreated: (planId: string) => void;
}) {
	const t = useTranslations("projects.testCases");
	const queryClient = useQueryClient();

	const createMutation = useMutation(
		orpc.projects.testCases.plans.create.mutationOptions({
			onSuccess: (data) => {
				toast.success(t("toasts.planCreated"));
				queryClient.invalidateQueries({
					queryKey: orpc.projects.testCases.plans.list.key(),
				});
				onOpenChange(false);
				onCreated(data.plan.id);
			},
			onError: (e) =>
				toast.error(t("toasts.planCreateFailed", { error: e.message })),
		}),
	);

	return (
		<PlanFormDialog
			open={open}
			onOpenChange={onOpenChange}
			title={t("plans.createTitle")}
			dialogDescription={t("plans.createDescription")}
			submitLabel={t("plans.create")}
			pending={createMutation.isPending}
			onSubmit={(v) =>
				createMutation.mutate({
					projectId,
					organizationId,
					name: v.name,
					description: v.description,
				})
			}
		/>
	);
}
