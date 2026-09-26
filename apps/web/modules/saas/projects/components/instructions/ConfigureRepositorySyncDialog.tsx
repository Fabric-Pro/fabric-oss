"use client";

import { orpc } from "@shared/lib/orpc-query-utils";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
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
import { useMemo, useState } from "react";
import { toast } from "sonner";
import {
	configureErrorMessage,
	type RepositorySyncConfiguration,
	type RepositorySyncIntegration,
	repositorySyncTreeSelection,
	type SyncNowResult,
	syncNowResultMessage,
} from "../../lib/instructions-repository-sync";
import {
	type ExclusionEdits,
	hasExclusionEdits,
	NO_EXCLUSION_EDITS,
	projectGlobsChanged,
	stagedProjectGlobs,
	toggleExclusion,
} from "../../lib/instructions-sync-exclusions";
import { InstructionsRepositorySyncTreeBrowser } from "./InstructionsRepositorySyncTreeBrowser";

/**
 * Points the project's coding instructions at a branch and folder of one of
 * its connected repositories, then starts the first sync (design 2026-09-23
 * §7.2). The server verifies the branch before saving anything; what it
 * refuses is shown inline, beside the field that needs changing.
 *
 * The folder can be picked from a browser over the chosen branch
 * (`InstructionsRepositorySyncTreeBrowser`, Fizzy #2725) or typed. The typed
 * field stays the one selection state: picking a folder writes to it, and
 * typing a listed folder selects its row. A provider without a listing, or
 * a listing that fails, leaves the typed field working as before.
 *
 * Folders under the chosen one can be excluded from the sync (Fizzy #2726).
 * A toggle only stages an edit to the project's own ignore rules — the
 * rules folder uploads and the settings dialog share — kept here as
 * additions and removals and dropped when the repository, the branch or the
 * folder changes, since each pattern is relative to the folder of the tree
 * it was staged in. Save re-reads the saved rules, applies the staged edits
 * to that fresh list (so a rule someone else saved meanwhile survives), and
 * sends the result WITH the configuration, only when it differs:
 * `configure` writes both in one transaction, so the rules never land
 * without the folder they are relative to, and the sync `syncNow` then
 * starts plans under them.
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
	const queryClient = useQueryClient();
	const settingsQuery = orpc.projects.instructions.getSettings.queryOptions({
		input: { projectId },
	});
	const settings = useQuery(settingsQuery);
	const savedGlobs = settings.isSuccess
		? settings.data.ignoreGlobs
		: undefined;
	const [exclusionEdits, setExclusionEdits] =
		useState<ExclusionEdits>(NO_EXCLUSION_EDITS);
	// `undefined` until the saved list has loaded; stable between edits,
	// since every row of the browser matches against it.
	const stagedGlobs = useMemo(
		() =>
			savedGlobs === undefined
				? undefined
				: stagedProjectGlobs(savedGlobs, exclusionEdits),
		[savedGlobs, exclusionEdits],
	);
	// Re-reading the saved rules before a save (`submit`).
	const [readingRules, setReadingRules] = useState(false);
	const configure = useMutation(
		orpc.projects.instructions.repositorySync.configure.mutationOptions(),
	);
	const syncNow = useMutation(
		orpc.projects.instructions.repositorySync.syncNow.mutationOptions(),
	);
	const pending = readingRules || configure.isPending || syncNow.isPending;
	const selected = integrations.find((i) => i.id === integrationId) ?? null;
	const branch = ref.trim();

	/**
	 * The folder field's new value. Staged exclusions are patterns relative
	 * to the folder they were staged under, so a different folder starts
	 * again from the saved rules.
	 */
	function changeRootPath(next: string) {
		if (
			repositorySyncTreeSelection(next) !==
			repositorySyncTreeSelection(rootPath)
		) {
			setExclusionEdits(NO_EXCLUSION_EDITS);
		}
		setRootPath(next);
		setInlineError(null);
		setInlineErrorField(null);
	}

	/** The branch field's new value; another branch is another tree. */
	function changeRef(next: string) {
		if (next.trim() !== branch) {
			setExclusionEdits(NO_EXCLUSION_EDITS);
		}
		setRef(next);
		setInlineError(null);
		setInlineErrorField(null);
	}

	/**
	 * The project's ignore list to send with the configuration, or
	 * `undefined` to leave it alone: the staged edits applied to the rules
	 * as saved NOW, not as this dialog last read them, so a rule saved
	 * elsewhere in the meantime is kept. Throws when they cannot be read.
	 */
	async function rulesToSave(): Promise<string[] | null | undefined> {
		if (!hasExclusionEdits(exclusionEdits)) {
			return undefined;
		}
		setReadingRules(true);
		try {
			const fresh = await queryClient.fetchQuery({
				...settingsQuery,
				staleTime: 0,
			});
			const next = stagedProjectGlobs(fresh.ignoreGlobs, exclusionEdits);
			return projectGlobsChanged(fresh.ignoreGlobs, next)
				? next
				: undefined;
		} finally {
			setReadingRules(false);
		}
	}

	async function submit() {
		setInlineError(null);
		setInlineErrorField(null);
		let ignoreGlobs: string[] | null | undefined;
		try {
			ignoreGlobs = await rulesToSave();
		} catch {
			toast.error(t("configureDialog.errors.ignoreRulesUnavailable"));
			return;
		}
		try {
			await configure.mutateAsync({
				projectId,
				repositoryIntegrationId: integrationId,
				ref: branch,
				rootPath: rootPath.trim(),
				automatic,
				// Written with the configuration, in one transaction, or not
				// at all.
				...(ignoreGlobs === undefined ? {} : { ignoreGlobs }),
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
		if (ignoreGlobs !== undefined) {
			// Saved with the configuration: the saved list is the sent one.
			queryClient.setQueryData(settingsQuery.queryKey, (old) =>
				old ? { ...old, ignoreGlobs } : old,
			);
			setExclusionEdits(NO_EXCLUSION_EDITS);
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
									// Another repository's folders: start
									// again from the saved rules.
									setExclusionEdits(NO_EXCLUSION_EDITS);
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
							onChange={(e) => changeRef(e.target.value)}
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
					<InstructionsRepositorySyncTreeBrowser
						projectId={projectId}
						repositoryIntegrationId={integrationId}
						branch={branch}
						rootPath={rootPath}
						disabled={pending}
						onSelect={changeRootPath}
						exclusions={{
							projectGlobs: stagedGlobs,
							settingsFailed: settings.isError,
							onToggle: (pattern, exclude) =>
								setExclusionEdits((prev) =>
									toggleExclusion(prev, pattern, exclude),
								),
						}}
					/>
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
							onChange={(e) => changeRootPath(e.target.value)}
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
