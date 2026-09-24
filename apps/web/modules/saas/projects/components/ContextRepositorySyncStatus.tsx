"use client";

import { orpc } from "@shared/lib/orpc-query-utils";
import { useMutation } from "@tanstack/react-query";
import {
	AlertDialog,
	AlertDialogAction,
	AlertDialogCancel,
	AlertDialogContent,
	AlertDialogDescription,
	AlertDialogFooter,
	AlertDialogHeader,
	AlertDialogTitle,
} from "@ui/components/alert-dialog";
import { Button } from "@ui/components/button";
import {
	DropdownMenu,
	DropdownMenuCheckboxItem,
	DropdownMenuContent,
	DropdownMenuItem,
	DropdownMenuTrigger,
} from "@ui/components/dropdown-menu";
import { formatDistanceToNow } from "date-fns";
import { FolderSyncIcon, Loader2Icon, MoreVerticalIcon } from "lucide-react";
import { useTranslations } from "next-intl";
import { useState } from "react";
import { toast } from "sonner";
import {
	type ContextSyncAttentionReason,
	type ContextSyncNowResult,
	type ContextSyncState,
	contextSyncAttentionMessageKey,
	contextSyncConfigureErrorMessage,
	contextSyncLastAppliedMessage,
	contextSyncLastAppliedSummary,
	contextSyncNowResultMessage,
	contextSyncPausedReason,
	contextSyncTriggerLabelKey,
	offersSyncFromRepository,
	offersSyncNow,
} from "../lib/context-repository-sync";
import { ConfigureContextRepositorySyncDialog } from "./ConfigureContextRepositorySyncDialog";

/**
 * Living Memory's repository sync entry point and status (design 2026-09-23
 * §7.1, Fizzy #2657): "Sync from repository" when nothing is configured yet;
 * once configured, the repository/branch line, the last applied run's
 * outcome, awaiting-index and cleanup-pending notes, an attention list,
 * "Sync now", and a menu (Automatic sync, Change branch or paths…,
 * Disconnect). Read-only members (no `CONTEXT_CREATE`) see the status only —
 * every button here is gated on `state.canConfigure`.
 *
 * Automatic sync (§11.1, Fizzy #2673) mirrors the coding-instructions
 * sibling: the status line names the applied run's trigger; the menu toggle
 * calls `configure` with the stored repository, branch and paths and the
 * flipped flag (so it goes through the same branch check and makes the
 * member the one automatic runs act as); a pause shows its reason, and
 * "Re-enable" reopens the configure dialog, whose save clears it. A pause
 * is dormant while automatic sync is off. Readers see the state as text.
 * While the toggle or a disconnect is in flight, the other menu actions are
 * disabled, so a second change is not built from the configuration the
 * first is replacing.
 */
export function ContextRepositorySyncStatus({
	projectId,
	organizationId,
	state,
	onChanged,
}: {
	projectId: string;
	organizationId: string | null;
	/** `undefined` while the first read of `repositorySync.get` is in flight. */
	state: ContextSyncState | undefined;
	/** A run finished, indexing progressed, or the configuration changed. */
	onChanged: () => void;
}) {
	const t = useTranslations("projects.contexts.livingMemory.repositorySync");
	const [dialogOpen, setDialogOpen] = useState(false);
	const [disconnectConfirmOpen, setDisconnectConfirmOpen] = useState(false);

	const syncNow = useMutation(
		orpc.projects.contexts.repositorySync.syncNow.mutationOptions({
			onSuccess: (result) => {
				const announced = contextSyncNowResultMessage(
					result as ContextSyncNowResult,
				);
				toast[announced.tone](t(announced.key));
				onChanged();
			},
			onError: (error) => toast.error(error.message),
		}),
	);
	const disable = useMutation(
		orpc.projects.contexts.repositorySync.disable.mutationOptions({
			onSuccess: () => {
				toast.success(t("disconnectConfirm.disconnected"));
				onChanged();
			},
			onError: (error) => toast.error(error.message),
		}),
	);
	const configure = useMutation(
		orpc.projects.contexts.repositorySync.configure.mutationOptions({
			onSuccess: (_result, variables) => {
				toast.success(
					t(
						variables.automatic
							? "settings.automaticTurnedOn"
							: "settings.automaticTurnedOff",
					),
				);
				onChanged();
			},
			onError: (error) => {
				const mapped = contextSyncConfigureErrorMessage(error);
				toast.error(t(mapped.key, mapped.values));
			},
		}),
	);
	const busy = configure.isPending || disable.isPending;

	if (!state) {
		return null;
	}

	const configured = state.configured;

	if (!configured) {
		if (!offersSyncFromRepository(state)) {
			return null;
		}
		return (
			<>
				<Button
					variant="outline"
					size="sm"
					data-testid="context-sync-from-repository"
					data-onboarding-target="context-sync-from-repository"
					onClick={() => setDialogOpen(true)}
				>
					<FolderSyncIcon
						className="mr-2 size-4"
						aria-hidden="true"
					/>
					{t("entry")}
				</Button>
				<ConfigureContextRepositorySyncDialog
					projectId={projectId}
					organizationId={organizationId}
					open={dialogOpen}
					onOpenChange={setDialogOpen}
					integrations={state.availableIntegrations}
					current={null}
					onSaved={onChanged}
				/>
			</>
		);
	}

	const repository = `${configured.integration.repositoryOwner}/${configured.integration.repositoryName}`;
	const summary = contextSyncLastAppliedSummary(state.lastAppliedRun);
	const statusMessage = contextSyncLastAppliedMessage(summary);
	const statusValues =
		summary.kind === "applied"
			? {
					...statusMessage.values,
					time: formatDistanceToNow(
						typeof summary.startedAt === "string"
							? new Date(summary.startedAt)
							: summary.startedAt,
					),
				}
			: statusMessage.values;

	const attentionItems = attentionItemsOf(state.lastAppliedRun);
	const canManage = offersSyncNow(state);
	const trigger =
		summary.kind === "not-synced" || !state.lastAppliedRun
			? null
			: t(contextSyncTriggerLabelKey(state.lastAppliedRun.trigger));
	const paused = contextSyncPausedReason(configured);

	function setAutomatic(next: boolean) {
		if (!configured) {
			return;
		}
		configure.mutate({
			projectId,
			organizationId,
			repositoryIntegrationId: configured.repositoryIntegrationId,
			ref: configured.ref,
			paths: configured.paths,
			automatic: next,
		});
	}

	return (
		<div
			className="flex flex-col gap-1.5 text-sm"
			data-testid="context-repository-sync-status"
		>
			<p className="flex items-center gap-1.5 font-medium">
				<FolderSyncIcon
					className="size-4 shrink-0 text-primary"
					aria-hidden="true"
				/>
				{t("repositoryLine", { repository, ref: configured.ref })}
			</p>
			{/* biome-ignore lint/a11y/useSemanticElements: this is a status/log region announcing sync progress, not a form-derived value; <output> is for the latter, <div role="status"> is the WAI-ARIA-recommended pattern for the former. */}
			<div
				role="status"
				aria-live="polite"
				className="flex flex-col gap-1"
			>
				{state.running ? (
					<p
						className="inline-flex items-center gap-1.5 text-primary"
						data-testid="context-sync-running"
					>
						<Loader2Icon
							className="size-3.5 animate-spin"
							aria-hidden="true"
						/>
						{t("running")}
					</p>
				) : (
					<p
						className="text-muted-foreground"
						data-testid="context-sync-status-line"
					>
						{t(statusMessage.key, statusValues)}
						{trigger ? ` · ${trigger}` : null}
					</p>
				)}
				{state.awaitingIndexCount > 0 ? (
					<p
						className="text-muted-foreground"
						data-testid="context-sync-awaiting-index"
					>
						{t("awaitingIndex", {
							count: state.awaitingIndexCount,
						})}
					</p>
				) : null}
				{state.cleanupPending > 0 ? (
					<p
						className="text-muted-foreground"
						data-testid="context-sync-cleanup-pending"
					>
						{t("cleanupPending", { count: state.cleanupPending })}
					</p>
				) : null}
				{paused ? (
					<p
						className="flex flex-wrap items-center gap-x-2 text-muted-foreground"
						data-testid="context-sync-paused"
					>
						{t("pausedLine", {
							reason: t(`pausedReasons.${paused}`),
						})}
						{canManage ? (
							<Button
								size="sm"
								variant="link"
								className="h-auto px-0"
								onClick={() => setDialogOpen(true)}
							>
								{t("reEnableButton")}
							</Button>
						) : null}
					</p>
				) : null}
			</div>
			{attentionItems.length > 0 ? (
				<ul
					className="flex flex-col gap-0.5 text-destructive text-xs"
					data-testid="context-sync-attention"
				>
					{attentionItems.map((item) => (
						<li key={`${item.reason}-${item.key}`}>
							{t(contextSyncAttentionMessageKey(item.reason), {
								key: item.key,
							})}
						</li>
					))}
				</ul>
			) : null}
			{canManage ? null : (
				<p
					className="text-muted-foreground"
					data-testid="context-sync-automatic-state"
				>
					{t("settings.automaticState", {
						state: t(
							configured.automatic
								? "settings.automaticOn"
								: "settings.automaticOff",
						),
					})}
				</p>
			)}
			{canManage ? (
				<div className="flex items-center gap-2 pt-1">
					<Button
						size="sm"
						variant="outline"
						data-testid="context-sync-now"
						data-onboarding-target="context-sync-now"
						disabled={state.running || syncNow.isPending}
						onClick={() =>
							syncNow.mutate({ projectId, organizationId })
						}
					>
						{state.running || syncNow.isPending ? (
							<Loader2Icon
								className="mr-2 size-3.5 animate-spin"
								aria-hidden="true"
							/>
						) : null}
						{t("syncNow")}
					</Button>
					<DropdownMenu>
						<DropdownMenuTrigger asChild>
							<Button
								variant="ghost"
								size="icon"
								aria-label={t("menu.label")}
								data-testid="context-sync-menu-trigger"
							>
								<MoreVerticalIcon className="size-4" />
							</Button>
						</DropdownMenuTrigger>
						<DropdownMenuContent align="start" className="max-w-xs">
							<DropdownMenuCheckboxItem
								data-testid="context-sync-automatic"
								checked={configured.automatic}
								disabled={busy}
								onCheckedChange={setAutomatic}
								aria-labelledby="context-sync-automatic-setting"
								aria-describedby="context-sync-automatic-setting-hint"
							>
								<span className="flex flex-col gap-0.5">
									<span id="context-sync-automatic-setting">
										{t("settings.automatic")}
									</span>
									<span
										id="context-sync-automatic-setting-hint"
										className="text-muted-foreground text-xs"
									>
										{t("settings.automaticHint")}
									</span>
								</span>
							</DropdownMenuCheckboxItem>
							<DropdownMenuItem
								data-testid="context-sync-change"
								disabled={busy}
								onSelect={() => setDialogOpen(true)}
							>
								{t("menu.changeButton")}
							</DropdownMenuItem>
							<DropdownMenuItem
								className="text-destructive focus:text-destructive"
								data-testid="context-sync-disconnect"
								disabled={busy}
								onSelect={() => setDisconnectConfirmOpen(true)}
							>
								{t("menu.disconnect")}
							</DropdownMenuItem>
						</DropdownMenuContent>
					</DropdownMenu>
				</div>
			) : null}
			<ConfigureContextRepositorySyncDialog
				projectId={projectId}
				organizationId={organizationId}
				open={dialogOpen}
				onOpenChange={setDialogOpen}
				integrations={state.availableIntegrations}
				current={configured}
				onSaved={onChanged}
			/>
			<AlertDialog
				open={disconnectConfirmOpen}
				onOpenChange={setDisconnectConfirmOpen}
			>
				<AlertDialogContent>
					<AlertDialogHeader>
						<AlertDialogTitle>
							{t("disconnectConfirm.title", { repository })}
						</AlertDialogTitle>
						<AlertDialogDescription>
							{t("disconnectConfirm.description", { repository })}
						</AlertDialogDescription>
					</AlertDialogHeader>
					<AlertDialogFooter>
						<AlertDialogCancel>
							{t("disconnectConfirm.cancel")}
						</AlertDialogCancel>
						<AlertDialogAction
							variant="destructive"
							disabled={disable.isPending}
							data-testid="context-sync-disconnect-confirm"
							onClick={() =>
								disable.mutate({ projectId, organizationId })
							}
						>
							{t("disconnectConfirm.confirm")}
						</AlertDialogAction>
					</AlertDialogFooter>
				</AlertDialogContent>
			</AlertDialog>
		</div>
	);
}

/**
 * The last applied run's attention items (§7.3): apply-time conflicts
 * (`applyAttention`), the plan's own attention sample, and prune conflicts —
 * each rendered with copy keyed by its reason.
 */
function attentionItemsOf(
	run: ContextSyncState["lastAppliedRun"],
): Array<{ key: string; reason: ContextSyncAttentionReason }> {
	if (!run) {
		return [];
	}
	const items: Array<{ key: string; reason: ContextSyncAttentionReason }> = [
		...run.applyAttention,
	];
	if (run.plan) {
		for (const item of run.plan.attention) {
			items.push({
				key: item.key,
				reason: item.reason as ContextSyncAttentionReason,
			});
		}
	}
	for (const key of run.pruneConflicts.keys) {
		items.push({ key, reason: "prune-conflict" });
	}
	return items;
}
