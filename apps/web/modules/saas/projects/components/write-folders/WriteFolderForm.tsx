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
import { Label } from "@ui/components/label";
import { RadioGroup, RadioGroupItem } from "@ui/components/radio-group";
import { Loader2Icon } from "lucide-react";
import { useTranslations } from "next-intl";
import { useId, useState } from "react";
import type { ContextSyncConfiguration } from "../../lib/context-repository-sync";
import {
	type WriteTargetMode,
	type WriteTargetsList,
	type WriteTargetView,
	writeTargetErrorMessage,
} from "../../lib/context-write-targets";
import { WriteFolderPicker } from "./WriteFolderPicker";

const NAMESPACE = "projects.contexts.livingMemory.writeFolders";

/**
 * Adds a write folder, or changes one: the folder (`WriteFolderPicker`) and
 * how its files land. Pull request is the default and what the server assumes.
 *
 * Push directly is offered only when the list said the caller may turn it on
 * (`canEnableDirectPush`); for anyone else its option is disabled and says
 * why. Choosing it asks first, in words about the risk: the files go to the
 * synced branch with no review, and the next agent reads them. A change that
 * ends in direct push asks whether or not the folder already was one, since
 * re-pointing a direct-push folder is turning it on for the new folder.
 *
 * Every refusal the server gives is shown under the form in its own words
 * (`writeTargetErrorMessage`), and the form stays as it was so it can be
 * corrected.
 */
export function WriteFolderForm({
	projectId,
	sync,
	list,
	editing,
	onSaved,
	onCancel,
}: {
	projectId: string;
	sync: ContextSyncConfiguration;
	list: WriteTargetsList;
	/** The folder being changed, or `null` for a new one. */
	editing: WriteTargetView | null;
	onSaved: () => void;
	onCancel: () => void;
}) {
	const t = useTranslations(NAMESPACE);
	const id = useId();
	const [folder, setFolder] = useState(editing?.folder ?? "");
	const [mode, setMode] = useState<WriteTargetMode>(
		editing?.mode ?? "PULL_REQUEST",
	);
	const [error, setError] = useState<string | null>(null);
	const [confirming, setConfirming] = useState(false);

	const create = useMutation(
		orpc.projects.contexts.repositorySync.writeTargets.create.mutationOptions(),
	);
	const update = useMutation(
		orpc.projects.contexts.repositorySync.writeTargets.update.mutationOptions(),
	);
	const pending = create.isPending || update.isPending;
	const siblings = list.targets
		.filter((target) => target.id !== editing?.id)
		.map((target) => target.folder);
	const changed =
		editing === null || folder !== editing.folder || mode !== editing.mode;
	const askFirst = mode === "DIRECT_PUSH" && changed;
	const canSave = folder !== "" && changed && !pending;
	const directPushAllowed = list.canEnableDirectPush;
	const errorId = `${id}-error`;
	const directPushHintId = `${id}-direct-push-hint`;

	async function save() {
		setConfirming(false);
		setError(null);
		try {
			if (editing === null) {
				await create.mutateAsync({ projectId, folder, mode });
			} else {
				await update.mutateAsync({
					projectId,
					targetId: editing.id,
					...(folder !== editing.folder ? { folder } : {}),
					...(mode !== editing.mode ? { mode } : {}),
				});
			}
		} catch (failure) {
			const mapped = writeTargetErrorMessage(failure, {
				maxTargets: list.maxTargets,
			});
			setError(t(mapped.key, mapped.values));
			return;
		}
		onSaved();
	}

	return (
		<form
			className="flex flex-col gap-4"
			onSubmit={(event) => {
				event.preventDefault();
				if (!canSave) {
					return;
				}
				if (askFirst) {
					setConfirming(true);
				} else {
					void save();
				}
			}}
			aria-describedby={error ? errorId : undefined}
		>
			<fieldset className="flex min-w-0 flex-col gap-2">
				<legend className="mb-1 font-medium text-sm">
					{t("form.folderLegend")}
				</legend>
				<WriteFolderPicker
					projectId={projectId}
					sync={sync}
					value={folder}
					onChange={(next) => {
						setFolder(next);
						setError(null);
					}}
					siblings={siblings}
					disabled={pending}
				/>
			</fieldset>

			<RadioGroup
				value={mode}
				onValueChange={(next) => {
					setMode(next as WriteTargetMode);
					setError(null);
				}}
				aria-label={t("form.modeLegend")}
				disabled={pending}
			>
				<div className="flex items-start gap-3">
					<RadioGroupItem
						value="PULL_REQUEST"
						id={`${id}-pull-request`}
						className="mt-1"
					/>
					<Label
						htmlFor={`${id}-pull-request`}
						className="grid gap-0.5 font-normal"
					>
						<span className="font-medium">
							{t("mode.PULL_REQUEST")}
						</span>
						<span className="text-muted-foreground text-xs">
							{t("form.pullRequestHint", { branch: sync.ref })}
						</span>
					</Label>
				</div>
				<div className="flex items-start gap-3">
					<RadioGroupItem
						value="DIRECT_PUSH"
						id={`${id}-direct-push`}
						className="mt-1"
						disabled={!directPushAllowed}
						aria-describedby={directPushHintId}
					/>
					<Label
						htmlFor={`${id}-direct-push`}
						className="grid gap-0.5 font-normal"
					>
						<span className="font-medium">
							{t("mode.DIRECT_PUSH")}
						</span>
						<span
							id={directPushHintId}
							className="text-muted-foreground text-xs"
						>
							{directPushAllowed
								? t("form.directPushHint", { branch: sync.ref })
								: t("form.directPushNeedsAdmin")}
						</span>
					</Label>
				</div>
			</RadioGroup>

			{error ? (
				<p
					id={errorId}
					role="alert"
					className="text-destructive text-xs"
					data-testid="write-folder-error"
				>
					{error}
				</p>
			) : null}

			<div className="flex justify-end gap-2">
				<Button
					type="button"
					variant="outline"
					onClick={onCancel}
					disabled={pending}
				>
					{t("form.cancel")}
				</Button>
				<Button type="submit" disabled={!canSave}>
					{pending ? (
						<Loader2Icon
							className="size-4 motion-safe:animate-spin"
							aria-hidden="true"
						/>
					) : null}
					{editing === null ? t("form.add") : t("form.save")}
				</Button>
			</div>

			<AlertDialog open={confirming} onOpenChange={setConfirming}>
				<AlertDialogContent>
					<AlertDialogHeader>
						<AlertDialogTitle>
							{t("directPushConfirm.title", { folder })}
						</AlertDialogTitle>
						<AlertDialogDescription>
							{t("directPushConfirm.description", {
								branch: sync.ref,
							})}
						</AlertDialogDescription>
					</AlertDialogHeader>
					<AlertDialogFooter>
						<AlertDialogCancel>
							{t("directPushConfirm.cancel")}
						</AlertDialogCancel>
						<AlertDialogAction
							variant="destructive"
							data-testid="write-folder-direct-push-confirm"
							onClick={() => void save()}
						>
							{t("directPushConfirm.confirm")}
						</AlertDialogAction>
					</AlertDialogFooter>
				</AlertDialogContent>
			</AlertDialog>
		</form>
	);
}
