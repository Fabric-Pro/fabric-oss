"use client";

import { orpc } from "@shared/lib/orpc-query-utils";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
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
import { Badge } from "@ui/components/badge";
import { Button } from "@ui/components/button";
import {
	Dialog,
	DialogContent,
	DialogDescription,
	DialogHeader,
	DialogTitle,
} from "@ui/components/dialog";
import { formatDistanceToNow } from "date-fns";
import { Loader2Icon, PencilIcon, PlusIcon, Trash2Icon } from "lucide-react";
import { useTranslations } from "next-intl";
import { useState } from "react";
import { toast } from "sonner";
import type { ContextSyncConfiguration } from "../lib/context-repository-sync";
import {
	type WriteTargetsList,
	type WriteTargetView,
	writeTargetErrorMessage,
} from "../lib/context-write-targets";
import { WriteFolderForm } from "./write-folders/WriteFolderForm";

const NAMESPACE = "projects.contexts.livingMemory.writeFolders";

type View =
	| { kind: "list" }
	| { kind: "form"; editing: WriteTargetView | null };

function asDate(value: string | Date): Date {
	return typeof value === "string" ? new Date(value) : value;
}

/**
 * Living Memory's write folders (ADR-022): the folders of the synced
 * repository that agents connected through the Fabric plugin write their files
 * into. A list of them with how each lands (a pull request, or pushed straight
 * to the synced branch and who turned that on), adding one, changing one and
 * removing one.
 *
 * Read-only members see the list. Adding, changing and removing are offered
 * only when the list says the caller can configure (`canConfigure`); the server
 * checks the same rights and is the authority, and direct push needs more than
 * that (`canEnableDirectPush`). Mounted only while open, like the configure
 * dialog, so a refetch cannot replace what someone is choosing.
 */
export function ContextWriteTargetsDialog({
	projectId,
	organizationId,
	sync,
	open,
	onOpenChange,
}: {
	projectId: string;
	organizationId: string | null;
	sync: ContextSyncConfiguration;
	open: boolean;
	onOpenChange: (open: boolean) => void;
}) {
	const t = useTranslations(NAMESPACE);
	const queryClient = useQueryClient();
	const [view, setView] = useState<View>({ kind: "list" });
	const [removing, setRemoving] = useState<WriteTargetView | null>(null);

	const listOptions =
		orpc.projects.contexts.repositorySync.writeTargets.list.queryOptions({
			input: { projectId },
		});
	const listQuery = useQuery({ ...listOptions, enabled: open });
	const list = listQuery.data as WriteTargetsList | undefined;

	const members = useQuery({
		...orpc.projects.members.list.queryOptions({
			input: { projectId, organizationId },
		}),
		enabled:
			open &&
			(list?.targets.some((x) => x.mode === "DIRECT_PUSH") ?? false),
		staleTime: Number.POSITIVE_INFINITY,
	});

	const remove = useMutation(
		orpc.projects.contexts.repositorySync.writeTargets.delete.mutationOptions(),
	);

	function refresh() {
		return queryClient.invalidateQueries({
			queryKey: listOptions.queryKey,
		});
	}

	function memberName(userId: string | null): string | null {
		const member = members.data?.members?.find(
			(m: { userId?: string }) => m.userId === userId,
		) as { user?: { name?: string | null } } | undefined;
		return member?.user?.name || null;
	}

	async function confirmRemove(target: WriteTargetView) {
		try {
			await remove.mutateAsync({ projectId, targetId: target.id });
		} catch (failure) {
			const mapped = writeTargetErrorMessage(failure, {
				maxTargets: list?.maxTargets ?? 0,
			});
			toast.error(t(mapped.key, mapped.values));
			setRemoving(null);
			return;
		}
		toast.success(t("remove.removed", { folder: target.folder }));
		setRemoving(null);
		await refresh();
	}

	const atLimit = list ? list.targets.length >= list.maxTargets : false;

	return (
		<Dialog open={open} onOpenChange={onOpenChange}>
			<DialogContent className="max-w-2xl">
				<DialogHeader>
					<DialogTitle>{t("title")}</DialogTitle>
					<DialogDescription>{t("description")}</DialogDescription>
				</DialogHeader>

				{listQuery.isPending ? (
					<output className="flex items-center gap-2 text-muted-foreground text-sm">
						<Loader2Icon
							className="size-4 motion-safe:animate-spin"
							aria-hidden="true"
						/>
						{t("loading")}
					</output>
				) : !list ? (
					<div
						role="alert"
						className="flex flex-col items-start gap-2 text-sm"
					>
						<p className="text-destructive">{t("loadError")}</p>
						<Button
							size="sm"
							variant="outline"
							onClick={() => void listQuery.refetch()}
						>
							{t("retry")}
						</Button>
					</div>
				) : view.kind === "form" ? (
					<WriteFolderForm
						projectId={projectId}
						sync={sync}
						list={list}
						editing={view.editing}
						onCancel={() => setView({ kind: "list" })}
						onSaved={() => {
							setView({ kind: "list" });
							void refresh();
						}}
					/>
				) : (
					<div className="flex flex-col gap-4">
						{list.targets.length === 0 ? (
							<div
								className="flex flex-col gap-1 rounded-md border border-input p-4 text-sm"
								data-testid="write-folders-empty"
							>
								<p className="font-medium">
									{t("empty.title")}
								</p>
								<p className="text-muted-foreground">
									{t("empty.body", { branch: sync.ref })}
								</p>
							</div>
						) : (
							<ul
								aria-label={t("listLabel")}
								className="flex flex-col divide-y divide-border rounded-md border border-input"
							>
								{list.targets.map((target) => {
									const who = memberName(
										target.directPushEnabledById,
									);
									return (
										<li
											key={target.id}
											className="flex items-start justify-between gap-3 p-3"
											data-testid="write-folder-row"
										>
											<div className="flex min-w-0 flex-col gap-1">
												<div className="flex flex-wrap items-center gap-2">
													<code className="min-w-0 truncate font-mono text-sm">
														{target.folder}
													</code>
													<Badge
														status={
															target.mode ===
															"DIRECT_PUSH"
																? "warning"
																: "info"
														}
													>
														{t(
															`mode.${target.mode}`,
														)}
													</Badge>
													{target.indexMode ===
													"STORE_ONLY" ? (
														<Badge status="info">
															{t(
																"indexMode.STORE_ONLY",
															)}
														</Badge>
													) : null}
												</div>
												{target.mode ===
													"DIRECT_PUSH" &&
												target.directPushEnabledAt ? (
													<p className="text-muted-foreground text-xs">
														{who
															? t(
																	"row.directPushBy",
																	{
																		name: who,
																		time: formatDistanceToNow(
																			asDate(
																				target.directPushEnabledAt,
																			),
																		),
																	},
																)
															: t(
																	"row.directPushByUnknown",
																	{
																		time: formatDistanceToNow(
																			asDate(
																				target.directPushEnabledAt,
																			),
																		),
																	},
																)}
													</p>
												) : null}
											</div>
											{list.canConfigure ? (
												<div className="flex shrink-0 gap-1">
													<Button
														variant="ghost"
														size="icon"
														aria-label={t(
															"row.edit",
															{
																folder: target.folder,
															},
														)}
														onClick={() =>
															setView({
																kind: "form",
																editing: target,
															})
														}
													>
														<PencilIcon
															className="size-4"
															aria-hidden="true"
														/>
													</Button>
													<Button
														variant="ghost"
														size="icon"
														aria-label={t(
															"row.remove",
															{
																folder: target.folder,
															},
														)}
														onClick={() =>
															setRemoving(target)
														}
													>
														<Trash2Icon
															className="size-4"
															aria-hidden="true"
														/>
													</Button>
												</div>
											) : null}
										</li>
									);
								})}
							</ul>
						)}
						{list.canConfigure ? (
							<div className="flex items-center justify-between gap-3">
								<p className="text-muted-foreground text-xs">
									{atLimit
										? t("limitReached", {
												max: list.maxTargets,
											})
										: t("count", {
												count: list.targets.length,
												max: list.maxTargets,
											})}
								</p>
								<Button
									size="sm"
									disabled={atLimit}
									onClick={() =>
										setView({ kind: "form", editing: null })
									}
								>
									<PlusIcon
										className="size-4"
										aria-hidden="true"
									/>
									{t("add")}
								</Button>
							</div>
						) : (
							<p className="text-muted-foreground text-xs">
								{t("readOnly")}
							</p>
						)}
					</div>
				)}

				<AlertDialog
					open={removing !== null}
					onOpenChange={(next) => {
						if (!next && !remove.isPending) {
							setRemoving(null);
						}
					}}
				>
					<AlertDialogContent>
						<AlertDialogHeader>
							<AlertDialogTitle>
								{t("remove.title", {
									folder: removing?.folder ?? "",
								})}
							</AlertDialogTitle>
							<AlertDialogDescription>
								{t("remove.description")}
							</AlertDialogDescription>
						</AlertDialogHeader>
						<AlertDialogFooter>
							<AlertDialogCancel disabled={remove.isPending}>
								{t("remove.cancel")}
							</AlertDialogCancel>
							<AlertDialogAction
								variant="destructive"
								disabled={remove.isPending}
								data-testid="write-folder-remove-confirm"
								onClick={(event) => {
									event.preventDefault();
									if (removing) {
										void confirmRemove(removing);
									}
								}}
							>
								{t("remove.confirm")}
							</AlertDialogAction>
						</AlertDialogFooter>
					</AlertDialogContent>
				</AlertDialog>
			</DialogContent>
		</Dialog>
	);
}
