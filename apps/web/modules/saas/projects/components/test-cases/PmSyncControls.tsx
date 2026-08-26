"use client";

import { orpc } from "@shared/lib/orpc-query-utils";
import { useMutation, useQueryClient } from "@tanstack/react-query";
import { Button } from "@ui/components/button";
import { Label } from "@ui/components/label";
import { Switch } from "@ui/components/switch";
import {
	Tooltip,
	TooltipContent,
	TooltipTrigger,
} from "@ui/components/tooltip";
import { Loader2Icon, RefreshCwIcon } from "lucide-react";
import { useTranslations } from "next-intl";
import { toast } from "sonner";
import { SyncGateButton } from "./SyncGateButton";
import { TestCaseStatusChip } from "./TestCaseStatusChip";
import { useTestCaseSyncCapability } from "./use-test-case-sync-capability";

// ---------------------------------------------------------------------------
// PM-sync controls. The auto-sync toggle persists with the case (on Save). The
// imperative actions drive the `testCases.sync.*` procedures directly: Sync now
// force-pushes THIS case, Retry re-enqueues a FAILED/CONFLICT case, and Dismiss
// clears a stuck FAILED flag. Sync now + Auto-sync are gated on the same
// test-execution capability as the RUNS section (see the in-body comment): for a
// provider that lacks it they render disabled with a "not supported" tooltip. A
// SUPPORTED provider with no board selected keeps them enabled and the procedure
// returns a friendly "select a board" toast on click. Dismiss stays enabled (it
// only clears a local FAILED flag, no PM round-trip).
// ---------------------------------------------------------------------------

export function PmSyncControls({
	projectId,
	organizationId,
	testCaseId,
	pmAutoSyncEnabled,
	onToggle,
	lastPmSyncStatus,
	lastPmSyncError,
	disabled,
}: {
	projectId: string;
	organizationId: string | null;
	testCaseId: string;
	pmAutoSyncEnabled: boolean;
	onToggle: (v: boolean) => void;
	lastPmSyncStatus: "PENDING" | "SUCCESS" | "CONFLICT" | "FAILED" | null;
	lastPmSyncError: string | null;
	disabled?: boolean;
}) {
	const t = useTranslations("projects.testCases");
	const queryClient = useQueryClient();
	const needsAttention =
		lastPmSyncStatus === "CONFLICT" || lastPmSyncStatus === "FAILED";

	// Test-case↔PM sync (Sync now + Auto-sync) is gated on whether the connected
	// tool holds NATIVE test cases: `canPush` (= `supportsPush`) already folds in
	// native test-case support (Azure DevOps / Jira Xray-Zephyr / GitLab), NOT
	// merely generic work-item CRUD. A tool without it gets a disabled control +
	// "not supported" tooltip, mirroring the server gate so the button never errors
	// on click.
	const capability = useTestCaseSyncCapability(projectId);
	const syncUnsupported = !capability.canPush;
	const unsupportedCopy = capability.unsupportedCopy;

	// Refresh the case detail (status chip + error) and the list (chip column)
	// after any sync action lands. Mirrors the sheet's top-level invalidateLists.
	const invalidate = () => {
		queryClient.invalidateQueries({
			queryKey: orpc.projects.testCases.list.key(),
		});
		queryClient.invalidateQueries({
			queryKey: orpc.projects.testCases.get.queryKey({
				input: { projectId, testCaseId, organizationId },
			}),
		});
	};

	// Sync now: force-push THIS case (unsyncedOnly:false) so a re-sync works even
	// when the row already looks synced. A friendly BAD_REQUEST (no board/tool
	// connected) is surfaced via the error toast.
	const syncMutation = useMutation(
		orpc.projects.testCases.sync.bulk.mutationOptions({
			onSuccess: () => {
				toast.success(t("sync.syncStarted"));
				invalidate();
			},
			onError: (e) => toast.error(e.message),
		}),
	);
	// Retry returns { enqueued } — enqueued:false means there is no usable PM
	// connection (or Temporal is down), surfaced as an error toast.
	const retryMutation = useMutation(
		orpc.projects.testCases.sync.retry.mutationOptions({
			onSuccess: (data) => {
				invalidate();
				if (data.enqueued) {
					toast.success(t("sync.retryQueued"));
				} else {
					toast.error(t("sync.retryFailed"));
				}
			},
			onError: (e) => toast.error(e.message),
		}),
	);
	// Dismiss is FAILED-scoped; dismissed:false is a no-op (e.g. a CONFLICT),
	// reported as a neutral message rather than a success.
	const dismissMutation = useMutation(
		orpc.projects.testCases.sync.dismiss.mutationOptions({
			onSuccess: (data) => {
				invalidate();
				if (data.dismissed) {
					toast.success(t("sync.dismissed"));
				} else {
					toast.message(t("sync.dismissNoop"));
				}
			},
			onError: (e) => toast.error(e.message),
		}),
	);

	const anyPending =
		syncMutation.isPending ||
		retryMutation.isPending ||
		dismissMutation.isPending;
	const actionsDisabled = disabled || anyPending;

	return (
		<div className="space-y-3 border-t pt-5">
			<div className="flex items-center justify-between gap-3">
				<div>
					<p className="app-editorial-label">{t("sync.heading")}</p>
					<p className="mt-1 text-muted-foreground text-xs">
						{t("sync.hint")}
					</p>
				</div>
				{syncUnsupported ? (
					<Tooltip>
						<TooltipTrigger asChild>
							<div className="flex items-center gap-2 opacity-60">
								<Label
									htmlFor="tc-autosync"
									className="text-muted-foreground text-xs"
								>
									{t("sync.autoSync")}
								</Label>
								<Switch
									id="tc-autosync"
									checked={pmAutoSyncEnabled}
									onCheckedChange={onToggle}
									disabled
									aria-label={unsupportedCopy}
								/>
							</div>
						</TooltipTrigger>
						<TooltipContent
							surface="popover"
							className="max-w-[15rem]"
						>
							{unsupportedCopy}
						</TooltipContent>
					</Tooltip>
				) : (
					<div className="flex items-center gap-2">
						<Label
							htmlFor="tc-autosync"
							className="text-muted-foreground text-xs"
						>
							{t("sync.autoSync")}
						</Label>
						<Switch
							id="tc-autosync"
							checked={pmAutoSyncEnabled}
							onCheckedChange={onToggle}
							disabled={disabled}
							aria-label={t("sync.autoSyncAria")}
						/>
					</div>
				)}
			</div>

			{lastPmSyncStatus && (
				<div className="flex flex-wrap items-center gap-2">
					<span className="text-muted-foreground text-xs">
						{t("sync.statusLabel")}
					</span>
					<TestCaseStatusChip
						status={lastPmSyncStatus}
						label={t(`pmStatus.${lastPmSyncStatus}`)}
					/>
					{needsAttention && lastPmSyncError && (
						<span className="text-destructive text-xs">
							{lastPmSyncError}
						</span>
					)}
				</div>
			)}

			<div className="flex flex-wrap items-center gap-2">
				<SyncGateButton
					supported={!syncUnsupported}
					unsupportedCopy={unsupportedCopy}
					pending={syncMutation.isPending}
					disabled={actionsDisabled}
					onClick={() =>
						syncMutation.mutate({
							projectId,
							organizationId,
							testCaseIds: [testCaseId],
							unsyncedOnly: false,
							direction: "push",
						})
					}
					icon={
						<RefreshCwIcon
							className="mr-2 size-4"
							aria-hidden="true"
						/>
					}
					label={t("actions.sync")}
				/>
				{needsAttention && (
					<Button
						type="button"
						variant="outline"
						size="sm"
						disabled={actionsDisabled || syncUnsupported}
						onClick={() =>
							retryMutation.mutate({
								projectId,
								testCaseId,
								organizationId,
							})
						}
					>
						{retryMutation.isPending && (
							<Loader2Icon
								className="mr-2 size-4 animate-spin"
								aria-hidden="true"
							/>
						)}
						{t("sync.retry")}
					</Button>
				)}
				{needsAttention && (
					<Button
						type="button"
						variant="ghost"
						size="sm"
						disabled={actionsDisabled}
						onClick={() =>
							dismissMutation.mutate({
								projectId,
								testCaseId,
								organizationId,
							})
						}
					>
						{dismissMutation.isPending && (
							<Loader2Icon
								className="mr-2 size-4 animate-spin"
								aria-hidden="true"
							/>
						)}
						{t("sync.dismiss")}
					</Button>
				)}
			</div>
		</div>
	);
}
