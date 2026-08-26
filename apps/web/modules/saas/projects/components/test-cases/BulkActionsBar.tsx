"use client";

import { useConfirmationAlert } from "@saas/shared/components/ConfirmationAlertProvider";
import { orpc } from "@shared/lib/orpc-query-utils";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { Button } from "@ui/components/button";
import { DestructiveTooltip } from "@ui/components/destructive-tooltip";
import {
	Select,
	SelectContent,
	SelectItem,
	SelectTrigger,
	SelectValue,
} from "@ui/components/select";
import { CloudUploadIcon, RotateCcwIcon, Trash2Icon } from "lucide-react";
import { useTranslations } from "next-intl";
import { toast } from "sonner";
import {
	MARKABLE_RESULTS,
	RESULT_I18N_KEY,
	STATE_I18N_KEY,
	TEST_CASE_STATES,
	type TestCaseState,
} from "./constants";
import { SyncGateButton } from "./SyncGateButton";
import type { toBulkFilter } from "./use-test-cases-view";

/** The predicate half of the list input — what "all N matching" resolves to. */
type BulkFilter = ReturnType<typeof toBulkFilter>;

/**
 * Mirrors the `selection.ids` cap on the bulk procedures. Past this an explicit
 * id list is not a legal request, so the predicate is the only way to express
 * the selection — which is what "select all matching" escalates to.
 */
export const BULK_ID_LIMIT = 500;

/**
 * Who the action applies to. `ids` is what the reader ticked; `filter` is the
 * same predicate the list rendered, re-resolved server-side so "all N matching"
 * covers rows this browser never loaded.
 */
export type BulkSelection =
	| { mode: "ids"; ids: string[] }
	| { mode: "filter"; filter: BulkFilter };

/** Results a reader can apply as a mark — `NOT_RUN` is reached via the reset. */
type MarkableResult = "PASSED" | "FAILED" | "BLOCKED";

function isMarkable(value: string): value is MarkableResult {
	return value === "PASSED" || value === "FAILED" || value === "BLOCKED";
}

type BulkOperation =
	| { type: "SET_STATE"; state: TestCaseState }
	| { type: "SET_RESULT"; result: MarkableResult }
	| { type: "ADD_TO_PLAN"; planId: string };

/** Success copy per operation — the server reports how many rows it touched. */
const BULK_TOAST_KEY: Record<BulkOperation["type"], string> = {
	SET_STATE: "bulk.updated",
	SET_RESULT: "bulk.marked",
	ADD_TO_PLAN: "bulk.added",
};

type Props = {
	projectId: string;
	organizationId: string | null;
	selection: BulkSelection;
	/** How many cases the action will hit — `total` when selecting all matching. */
	count: number;
	canDelete: boolean;
	canPush: boolean;
	unsupportedCopy: string;
	onDone: () => void;
};

export function BulkActionsBar({
	projectId,
	organizationId,
	selection,
	count,
	canDelete,
	canPush,
	unsupportedCopy,
	onDone,
}: Props) {
	const t = useTranslations("projects.testCases");
	// Destructive-tooltip copy lives in the top-level `tooltips` namespace
	// (English-only source locale, per the tooltip standard).
	const tt = useTranslations("tooltips.testCases");
	const queryClient = useQueryClient();
	const { confirm } = useConfirmationAlert();

	const invalidate = () =>
		queryClient.invalidateQueries({
			queryKey: orpc.projects.testCases.list.key(),
		});

	// One request per action, whatever the size of the set: the server resolves
	// the selection and applies the operation in a single transaction, so a
	// partial failure can't leave half the set applied.
	const bulkMutation = useMutation(
		orpc.projects.testCases.bulk.mutationOptions({
			onSuccess: ({ affected }, variables) => {
				toast.success(
					t(BULK_TOAST_KEY[variables.operation.type], {
						count: affected,
					}),
				);
				invalidate();
				onDone();
			},
			onError: (e) => toast.error(t("bulk.failed", { error: e.message })),
		}),
	);

	const deleteMutation = useMutation(
		orpc.projects.testCases.bulkDelete.mutationOptions({
			onSuccess: ({ affected }) => {
				toast.success(t("bulk.deleted", { count: affected }));
				invalidate();
				onDone();
			},
			onError: (e) =>
				toast.error(t("bulk.deleteFailed", { error: e.message })),
		}),
	);

	// Project-wide reset (the `resetResults` mutation is not selection-scoped) —
	// the confirm copy makes the whole-project scope explicit.
	const resetMutation = useMutation(
		orpc.projects.testCases.resetResults.mutationOptions({
			onSuccess: () => {
				toast.success(t("toasts.reset"));
				invalidate();
				onDone();
			},
			onError: (e) =>
				toast.error(t("toasts.resetFailed", { error: e.message })),
		}),
	);

	const syncMutation = useMutation(
		orpc.projects.testCases.sync.bulk.mutationOptions({
			onSuccess: () => {
				toast.success(t("bulk.syncStarted"));
				onDone();
			},
			onError: (e) =>
				toast.error(t("toasts.syncFailed", { error: e.message })),
		}),
	);

	const { data: plansData } = useQuery(
		orpc.projects.testCases.plans.list.queryOptions({
			input: { projectId, organizationId },
		}),
	);
	const plans = plansData?.items ?? [];

	const busy =
		bulkMutation.isPending ||
		deleteMutation.isPending ||
		resetMutation.isPending ||
		syncMutation.isPending;

	// More ids than the procedure accepts. The escalation banner is offered in
	// exactly this state, so the way out is to select all matching (one
	// predicate, no cap) — until then the actions would only earn a rejection.
	const overIdLimit =
		selection.mode === "ids" && selection.ids.length > BULK_ID_LIMIT;
	const actionsDisabled = busy || overIdLimit;

	const apply = (operation: BulkOperation) =>
		bulkMutation.mutate({
			projectId,
			organizationId,
			selection,
			operation,
		});

	// Sync takes an explicit id list, so it cannot express "every matching
	// case". Rather than silently syncing only the loaded rows, reuse the gate's
	// aria-disabled + tooltip affordance to say why it is unavailable.
	const syncGate =
		selection.mode === "filter"
			? { supported: false, copy: t("bulk.syncNeedsIds") }
			: { supported: canPush, copy: unsupportedCopy };

	return (
		<div className="flex flex-wrap items-center gap-2 rounded-lg border bg-muted/40 px-3 py-2">
			<span className="text-sm tabular-nums">
				{t("bulk.selectedCount", { count })}
			</span>
			<div className="h-4 w-px bg-border" />

			{/* A disabled row with no stated reason is a dead end — say why. */}
			{overIdLimit && (
				<output className="text-muted-foreground text-xs">
					{t("bulk.overIdLimit", { limit: BULK_ID_LIMIT })}
				</output>
			)}

			<Select
				disabled={actionsDisabled}
				onValueChange={(v) =>
					apply({ type: "SET_STATE", state: v as TestCaseState })
				}
			>
				<SelectTrigger
					className="h-8 w-[9.5rem]"
					aria-label={t("bulk.setStateAria")}
				>
					<SelectValue placeholder={t("bulk.setStatePlaceholder")} />
				</SelectTrigger>
				<SelectContent>
					{TEST_CASE_STATES.map((s) => (
						<SelectItem key={s} value={s}>
							{t(STATE_I18N_KEY[s])}
						</SelectItem>
					))}
				</SelectContent>
			</Select>

			<Select
				disabled={actionsDisabled}
				onValueChange={(v) => {
					if (isMarkable(v)) {
						apply({ type: "SET_RESULT", result: v });
					}
				}}
			>
				<SelectTrigger
					className="h-8 w-[9.5rem]"
					aria-label={t("bulk.markResultAria")}
				>
					<SelectValue placeholder={t("bulk.markResult")} />
				</SelectTrigger>
				<SelectContent>
					{MARKABLE_RESULTS.map((r) => (
						<SelectItem key={r} value={r}>
							{t(RESULT_I18N_KEY[r])}
						</SelectItem>
					))}
				</SelectContent>
			</Select>

			<Button
				variant="ghost"
				size="sm"
				disabled={actionsDisabled}
				onClick={() =>
					confirm({
						title: t("confirm.resetTitle"),
						message: t("confirm.resetMessage"),
						confirmLabel: t("bulk.reset"),
						cancelLabel: t("actions.cancel"),
						// `.mutate()` (not mutateAsync): a rejecting reset would
						// otherwise leave the confirm dialog stuck open (the provider
						// awaits onConfirm without try/catch). onError toasts it.
						onConfirm: () => {
							resetMutation.mutate({ projectId, organizationId });
						},
					})
				}
			>
				<RotateCcwIcon className="mr-1.5 size-4" aria-hidden="true" />
				{t("bulk.reset")}
			</Button>

			{plans.length > 0 && (
				<Select
					disabled={actionsDisabled}
					onValueChange={(planId) =>
						apply({ type: "ADD_TO_PLAN", planId })
					}
				>
					<SelectTrigger
						className="h-8 w-[9.5rem]"
						aria-label={t("bulk.addToPlanAria")}
					>
						<SelectValue placeholder={t("actions.addToPlan")} />
					</SelectTrigger>
					<SelectContent>
						{plans.map((p) => (
							<SelectItem key={p.id} value={p.id}>
								{p.identifier} · {p.name}
							</SelectItem>
						))}
					</SelectContent>
				</Select>
			)}

			<SyncGateButton
				supported={syncGate.supported}
				unsupportedCopy={syncGate.copy}
				disabled={actionsDisabled}
				onClick={() =>
					syncMutation.mutate({
						projectId,
						organizationId,
						// Only reachable in ids mode: the gate above renders the
						// button inert whenever the selection is a predicate.
						testCaseIds:
							selection.mode === "ids" ? selection.ids : [],
						direction: "push",
					})
				}
				variant="ghost"
				icon={
					<CloudUploadIcon
						className="mr-1.5 size-4"
						aria-hidden="true"
					/>
				}
				label={t("bulk.sync")}
				ariaLabel={t("bulk.sync")}
			/>

			{canDelete && (
				<DestructiveTooltip
					copy={
						tt.raw("delete") as {
							label: string;
							warning: string;
						}
					}
				>
					<Button
						variant="ghost"
						size="sm"
						disabled={actionsDisabled}
						className="text-destructive hover:text-destructive"
						onClick={() =>
							confirm({
								title: t("confirm.bulkDeleteTitle"),
								message: t("confirm.bulkDeleteMessage", {
									count,
								}),
								confirmLabel: t("actions.delete"),
								cancelLabel: t("actions.cancel"),
								destructive: true,
								// `.mutate()` (not mutateAsync): the provider awaits
								// onConfirm without try/catch, so a rejecting delete
								// would leave the dialog stuck open. onError toasts it.
								onConfirm: () => {
									deleteMutation.mutate({
										projectId,
										organizationId,
										selection,
									});
								},
							})
						}
					>
						<Trash2Icon
							className="mr-1.5 size-4"
							aria-hidden="true"
						/>
						{t("actions.delete")}
					</Button>
				</DestructiveTooltip>
			)}

			{/* Never gated on `overIdLimit` — it is one of the two ways out of it. */}
			<Button
				variant="ghost"
				size="sm"
				disabled={busy}
				onClick={onDone}
				className="ml-auto"
			>
				{t("bulk.clearSelection")}
			</Button>
		</div>
	);
}
