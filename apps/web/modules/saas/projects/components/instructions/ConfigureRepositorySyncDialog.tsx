"use client";

import { orpc } from "@shared/lib/orpc-query-utils";
import { useMutation } from "@tanstack/react-query";
import { Button } from "@ui/components/button";
import { Checkbox } from "@ui/components/checkbox";
import {
	Dialog,
	DialogContent,
	DialogDescription,
	DialogFooter,
	DialogHeader,
	DialogTitle,
} from "@ui/components/dialog";
import { Input } from "@ui/components/input";
import { Label } from "@ui/components/label";
import { Loader2Icon } from "lucide-react";
import { useTranslations } from "next-intl";
import { useState } from "react";
import { toast } from "sonner";
import {
	configureErrorMessage,
	type RepositorySyncConfiguration,
	type RepositorySyncIntegration,
	type SyncNowResult,
	syncNowResultMessage,
} from "../../lib/instructions-repository-sync";

/**
 * Points the project's coding instructions at a branch and folder of one of
 * its connected repositories, then starts the first sync (design 2026-09-23
 * §7.2). The server verifies the branch before saving anything; what it
 * refuses is shown inline, beside the field that needs changing.
 *
 * Mounted only while open, so the fields are seeded once from the props and a
 * background poll of the tab cannot overwrite what someone is typing.
 *
 * "Keep in sync automatically" defaults to on for a new configuration and
 * to the stored value when changing one (spec §7.2). Saving makes the
 * member the one automatic runs publish as, which the hint says.
 */
export function ConfigureRepositorySyncDialog({
	projectId,
	open,
	onOpenChange,
	integrations,
	current,
	onSaved,
}: {
	projectId: string;
	open: boolean;
	onOpenChange: (open: boolean) => void;
	/** ACTIVE integrations only, as `repositorySync.get` returns them. */
	integrations: RepositorySyncIntegration[];
	current: RepositorySyncConfiguration | null;
	onSaved: () => void;
}) {
	const t = useTranslations("projects.codingInstructions.repositorySync");
	const seed =
		(current &&
			integrations.find(
				(i) => i.id === current.repositoryIntegrationId,
			)) ??
		integrations[0] ??
		null;
	const [integrationId, setIntegrationId] = useState(seed?.id ?? "");
	const [ref, setRef] = useState(current?.ref ?? seed?.defaultBranch ?? "");
	const [rootPath, setRootPath] = useState(current?.rootPath ?? "");
	const [automatic, setAutomatic] = useState(current?.automatic ?? true);
	const [inlineError, setInlineError] = useState<string | null>(null);
	// Which field the inline error is ABOUT, derived from `mapped.key`
	// (`configureDialog.errors.<CODE>`, set only while `mapped.inline`):
	// BRANCH_NOT_FOUND names the branch, INVALID_ROOT_PATH names the folder,
	// and a repository-level code (REPOSITORY_NOT_FOUND/_UNAVAILABLE/
	// _CREDENTIALS_EXPIRED) is inline but about neither field, so it stays
	// unattached — the `role="alert"` paragraph still announces it (review
	// finding B-2: both fields sharing one `aria-describedby` told a
	// screen-reader user the branch was invalid when the folder was).
	const [inlineErrorField, setInlineErrorField] = useState<
		"branch" | "root" | null
	>(null);
	const configure = useMutation(
		orpc.projects.instructions.repositorySync.configure.mutationOptions(),
	);
	const syncNow = useMutation(
		orpc.projects.instructions.repositorySync.syncNow.mutationOptions(),
	);
	const pending = configure.isPending || syncNow.isPending;
	const selected = integrations.find((i) => i.id === integrationId) ?? null;
	const branch = ref.trim();

	async function submit() {
		setInlineError(null);
		setInlineErrorField(null);
		try {
			await configure.mutateAsync({
				projectId,
				repositoryIntegrationId: integrationId,
				ref: branch,
				rootPath: rootPath.trim(),
				automatic,
			});
		} catch (error) {
			const mapped = configureErrorMessage(error);
			const message = t(mapped.key, { ref: branch });
			if (mapped.inline) {
				setInlineError(message);
				setInlineErrorField(
					mapped.key === "configureDialog.errors.BRANCH_NOT_FOUND"
						? "branch"
						: mapped.key ===
								"configureDialog.errors.INVALID_ROOT_PATH"
							? "root"
							: null,
				);
			} else {
				toast.error(message);
			}
			return;
		}
		// Saved. The first sync starts now (§7.2); a refusal to start is
		// reported, and the configuration stands either way.
		try {
			const result = (await syncNow.mutateAsync({
				projectId,
			})) as SyncNowResult;
			const announced = syncNowResultMessage(result);
			toast[announced.tone](t(announced.key));
		} catch (error) {
			toast.error(
				error instanceof Error
					? error.message
					: t("configureDialog.errors.generic"),
			);
		}
		onSaved();
		onOpenChange(false);
	}

	return (
		<Dialog open={open} onOpenChange={onOpenChange}>
			<DialogContent className="max-w-lg">
				<DialogHeader>
					<DialogTitle>{t("configureDialog.title")}</DialogTitle>
					<DialogDescription>
						{t("configureDialog.description")}
					</DialogDescription>
				</DialogHeader>
				<div className="flex flex-col gap-4">
					{integrations.length > 1 ? (
						<div className="flex flex-col gap-1.5">
							<Label htmlFor="instructions-sync-repository">
								{t("configureDialog.repositoryLabel")}
							</Label>
							<select
								id="instructions-sync-repository"
								className="h-9 rounded-md border border-input bg-background px-3 text-sm"
								value={integrationId}
								onChange={(e) => {
									const next = integrations.find(
										(i) => i.id === e.target.value,
									);
									setIntegrationId(e.target.value);
									if (next) {
										setRef(next.defaultBranch);
									}
									setInlineError(null);
									setInlineErrorField(null);
								}}
							>
								{integrations.map((i) => (
									<option key={i.id} value={i.id}>
										{`${t(`providers.${i.provider}`)} · ${i.repositoryOwner}/${i.repositoryName}`}
									</option>
								))}
							</select>
						</div>
					) : selected ? (
						<p className="text-sm">
							<span className="text-muted-foreground">
								{t("configureDialog.repositoryLabel")}:{" "}
							</span>
							<span>{`${selected.repositoryOwner}/${selected.repositoryName}`}</span>
						</p>
					) : null}
					<div className="flex flex-col gap-1.5">
						<Label htmlFor="instructions-sync-branch">
							{t("configureDialog.branchLabel")}
						</Label>
						<Input
							id="instructions-sync-branch"
							value={ref}
							onChange={(e) => {
								setRef(e.target.value);
								setInlineError(null);
								setInlineErrorField(null);
							}}
							aria-invalid={
								inlineErrorField === "branch" ? true : undefined
							}
							aria-describedby={
								inlineErrorField === "branch"
									? "instructions-sync-error"
									: undefined
							}
						/>
					</div>
					<div className="flex flex-col gap-1.5">
						<Label htmlFor="instructions-sync-root">
							{t("configureDialog.rootPathLabel")}
						</Label>
						<Input
							id="instructions-sync-root"
							value={rootPath}
							placeholder={t(
								"configureDialog.rootPathPlaceholder",
							)}
							onChange={(e) => {
								setRootPath(e.target.value);
								setInlineError(null);
								setInlineErrorField(null);
							}}
							aria-invalid={
								inlineErrorField === "root" ? true : undefined
							}
							aria-describedby={
								inlineErrorField === "root"
									? "instructions-sync-error"
									: undefined
							}
						/>
						<p className="text-muted-foreground text-xs">
							{t("configureDialog.rootPathHint")}
						</p>
					</div>
					{inlineError ? (
						<p
							id="instructions-sync-error"
							role="alert"
							className="text-destructive text-xs"
						>
							{inlineError}
						</p>
					) : null}
					<div className="flex items-start gap-2">
						<Checkbox
							id="instructions-sync-automatic"
							className="mt-0.5"
							checked={automatic}
							onCheckedChange={(value) =>
								setAutomatic(value === true)
							}
							aria-describedby="instructions-sync-automatic-hint"
						/>
						<div className="flex flex-col gap-0.5">
							<Label htmlFor="instructions-sync-automatic">
								{t("configureDialog.automaticLabel")}
							</Label>
							<p
								id="instructions-sync-automatic-hint"
								className="text-muted-foreground text-xs"
							>
								{t("configureDialog.automaticHint")}
							</p>
						</div>
					</div>
					<p className="text-muted-foreground text-sm">
						{t("configureDialog.afterSyncNotice")}
					</p>
					<p className="text-muted-foreground text-sm">
						{t("configureDialog.actingNotice")}
					</p>
				</div>
				<DialogFooter>
					<Button
						variant="outline"
						onClick={() => onOpenChange(false)}
						disabled={pending}
					>
						{t("configureDialog.cancel")}
					</Button>
					<Button
						onClick={submit}
						disabled={pending || !integrationId || branch === ""}
					>
						{pending ? (
							<Loader2Icon
								className="size-4 animate-spin"
								aria-hidden="true"
							/>
						) : null}
						{t("configureDialog.submit")}
					</Button>
				</DialogFooter>
			</DialogContent>
		</Dialog>
	);
}
