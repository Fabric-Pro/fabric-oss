"use client";

import { FABRIC_IGNORE_FILE } from "@repo/instructions";
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
import { useId, useMemo, useState } from "react";
import { toast } from "sonner";
import { useSettledValue } from "../../hooks/use-settled-value";
import {
	configureErrorMessage,
	type RepositorySyncConfiguration,
	type RepositorySyncIntegration,
	repositorySyncTreeErrorKey,
	repositorySyncTreeSelection,
	type SyncNowResult,
	syncNowResultMessage,
} from "../../lib/instructions-repository-sync";
import {
	hasExclusionEdits,
	NO_EXCLUSION_EDITS,
	projectGlobsChanged,
	stagedProjectGlobs,
} from "../../lib/instructions-sync-exclusions";
import { AddRepositoryPathInput } from "../repository-sync/AddRepositoryPathInput";
import {
	applyInstructionsAction,
	type InstructionsAction,
	type InstructionsIgnoreFile,
	type InstructionsSelection,
	instructionsSelectionModel,
	instructionsSummary,
	SELECT_ALL_INSTRUCTIONS,
	SELECT_NONE_INSTRUCTIONS,
} from "../repository-sync/lib/instructions-selection";
import {
	ancestorsOf,
	indexRepositoryTree,
} from "../repository-sync/lib/repository-tree";
import {
	offersTypedPath,
	type SelectionMessage,
	selectionTreeListingOf,
} from "../repository-sync/lib/selection-row";
import { RepositorySyncSelectionTree } from "../repository-sync/RepositorySyncSelectionTree";
import { SelectedPathsList } from "../repository-sync/SelectedPathsList";
import { SelectionSummary } from "../repository-sync/SelectionSummary";

const NAMESPACE = "projects.codingInstructions.repositorySync";

/** How long the branch must stay unchanged before the listing is fetched. */
const BRANCH_DEBOUNCE_MS = 500;
const LIST_TREE_STALE_MS = 5 * 60 * 1000;

/** The synced folder's `.fabricignore`, as the notices word it. */
type IgnoreFileState =
	| { kind: "none" }
	| { kind: "loading" }
	| { kind: "error" }
	| { kind: "tooLarge" }
	| { kind: "rules"; rules: readonly string[] };

/**
 * What the dialog knows of the synced folder's `.fabricignore`. Only a file
 * with rules changes anything: no file, one with no rules, and one over the
 * sync's limit all leave the project's rules in force, as in the sync.
 */
function ignoreFileStateOf(input: {
	read: boolean;
	failed: boolean;
	data:
		| { supported: boolean; state: string; rules: readonly string[] }
		| undefined;
}): IgnoreFileState {
	if (!input.read) {
		return { kind: "none" };
	}
	if (input.failed) {
		return { kind: "error" };
	}
	if (!input.data) {
		return { kind: "loading" };
	}
	if (!input.data.supported) {
		return { kind: "none" };
	}
	if (input.data.state === "tooLarge") {
		return { kind: "tooLarge" };
	}
	return input.data.state === "rules" && input.data.rules.length > 0
		? { kind: "rules", rules: input.data.rules }
		: { kind: "none" };
}

/**
 * Points the project's coding instructions at a branch and folder of one of
 * its connected repositories, then starts the first sync (design 2026-09-23
 * §7.2). The server verifies the branch before saving anything; what it
 * refuses is shown inline, beside the field that needs changing.
 *
 * The folder is chosen in the shared selection tree over the chosen branch
 * (`RepositorySyncSelectionTree`, Fizzy #2750 §4): one ticked folder is the
 * synced root, and ticking another moves the sync there. Nothing is ticked
 * for a new configuration, and Save waits until something is. Unticking a
 * row under the root leaves it out: it stages its pattern (`F/**` for a
 * folder, the relative path for a file) in the project's own ignore rules —
 * the rules folder uploads and the settings dialog share — kept here as
 * additions and removals against the saved list
 * (`../repository-sync/lib/instructions-selection.ts`). Moving the root, or
 * changing the repository or branch, drops the staged edits, since each
 * pattern is relative to the folder of the tree it was staged in. Whenever
 * the staged edits would remove a saved rule, the dialog lists it before
 * Save. A provider with no listing, a truncated listing, or a failed one
 * offers the folder as typed text.
 *
 * Save re-reads the saved rules, applies the staged edits to that fresh list
 * (so a rule someone else saved meanwhile survives), and sends the result
 * WITH the configuration, only when it differs: `configure` writes both in
 * one transaction, so the rules never land without the folder they are
 * relative to, and the sync `syncNow` then starts plans under them.
 *
 * Mounted only while open, so the fields are seeded once from the props and a
 * background poll of the tab cannot overwrite what someone is choosing.
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
	const t = useTranslations(NAMESPACE);
	const id = useId();
	const seed =
		(current &&
			integrations.find(
				(i) => i.id === current.repositoryIntegrationId,
			)) ??
		integrations[0] ??
		null;
	const [integrationId, setIntegrationId] = useState(seed?.id ?? "");
	const [ref, setRef] = useState(current?.ref ?? seed?.defaultBranch ?? "");
	const [selection, setSelection] = useState<InstructionsSelection>(() => ({
		root: current ? current.rootPath : null,
		edits: NO_EXCLUSION_EDITS,
	}));
	// The way to the stored folder starts open, so it shows its selection.
	const [initiallyOpen] = useState<ReadonlySet<string>>(
		() => new Set(current ? ancestorsOf(current.rootPath) : []),
	);
	const [automatic, setAutomatic] = useState(current?.automatic ?? true);
	const [inlineError, setInlineError] = useState<string | null>(null);
	// Which field the inline error is ABOUT, derived from `mapped.key`
	// (`configureDialog.errors.<CODE>`, set only while `mapped.inline`):
	// BRANCH_NOT_FOUND names the branch, INVALID_ROOT_PATH names the folder,
	// and a repository-level code (REPOSITORY_NOT_FOUND/_UNAVAILABLE/
	// _CREDENTIALS_EXPIRED) is inline but about neither field, so it stays
	// unattached — the `role="alert"` paragraph still announces it (review
	// finding B-2).
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
	const root = selection.root;

	// The branch's listing: only a settled branch is listed, since a key per
	// keystroke would be a request per keystroke.
	const debouncedBranch = useSettledValue(branch, BRANCH_DEBOUNCE_MS);
	const listingRequested = integrationId !== "" && branch !== "";
	const listingEnabled =
		open && listingRequested && debouncedBranch === branch;
	const treeQuery = useQuery(
		orpc.projects.instructions.repositorySync.listTree.queryOptions({
			input: {
				projectId,
				repositoryIntegrationId: integrationId,
				ref: debouncedBranch,
			},
			enabled: listingEnabled,
			staleTime: LIST_TREE_STALE_MS,
			retry: false,
		}),
	);
	const listing = selectionTreeListingOf({
		requested: listingRequested,
		enabled: listingEnabled,
		query: treeQuery,
		errorMessage: (error) => ({
			key: repositorySyncTreeErrorKey(error),
			values: { ref: debouncedBranch },
		}),
	});
	const entries = listing.status === "ready" ? listing.entries : undefined;
	const treeIndex = useMemo(
		() => (entries ? indexRepositoryTree(entries) : null),
		[entries],
	);
	const truncated = listing.status === "ready" && listing.truncated;

	// The synced folder's `.fabricignore`: only the exact root-level file
	// counts, as in the sync, and only a regular one (a symbolic link is no
	// file to the sync). A truncated listing may have stopped before it, so
	// the file is read then too (a 404 is simply "absent").
	const ignoreFilePath =
		root === "" ? FABRIC_IGNORE_FILE : `${root}/${FABRIC_IGNORE_FILE}`;
	const rootListed =
		root === "" ||
		(root !== null && treeIndex?.nodes.get(root)?.type === "dir");
	const ignoreEntry = treeIndex?.entryByPath.get(ignoreFilePath);
	const readsIgnoreFile =
		treeIndex !== null &&
		rootListed &&
		((ignoreEntry?.type === "file" && ignoreEntry.regular !== false) ||
			(truncated && ignoreEntry === undefined));
	const ignoreFileQuery = useQuery(
		orpc.projects.instructions.repositorySync.readIgnoreFile.queryOptions({
			input: {
				projectId,
				repositoryIntegrationId: integrationId,
				ref: debouncedBranch,
				rootPath: root ?? "",
			},
			enabled: readsIgnoreFile,
			staleTime: LIST_TREE_STALE_MS,
			retry: false,
		}),
	);
	const ignoreFile = ignoreFileStateOf({
		read: readsIgnoreFile,
		failed: ignoreFileQuery.isError,
		data: ignoreFileQuery.data,
	});
	const ignoreFileRules =
		ignoreFile.kind === "rules" ? ignoreFile.rules : null;
	const modelIgnoreFile = useMemo<InstructionsIgnoreFile>(() => {
		if (ignoreFile.kind === "loading") {
			return { kind: "loading" };
		}
		if (ignoreFile.kind === "error") {
			return { kind: "failed" };
		}
		return ignoreFileRules
			? { kind: "rules", rules: ignoreFileRules }
			: { kind: "none" };
	}, [ignoreFile.kind, ignoreFileRules]);

	const model = useMemo(
		() =>
			instructionsSelectionModel({
				tree: treeIndex,
				selection,
				savedGlobs,
				settingsFailed: settings.isError,
				ignoreFile: modelIgnoreFile,
			}),
		[treeIndex, selection, savedGlobs, settings.isError, modelIgnoreFile],
	);
	const summary = instructionsSummary({
		model,
		listing: listing.status,
		truncated,
	});

	function clearInlineError() {
		setInlineError(null);
		setInlineErrorField(null);
	}

	function apply(action: InstructionsAction) {
		setSelection((prev) => applyInstructionsAction(prev, action));
		clearInlineError();
	}

	/** The branch field's new value; another branch is another tree. */
	function changeRef(next: string) {
		if (next.trim() !== branch) {
			setSelection((prev) => ({ ...prev, edits: NO_EXCLUSION_EDITS }));
		}
		setRef(next);
		clearInlineError();
	}

	/** A typed folder: the same transition as ticking it in the tree. */
	function addTypedFolder(raw: string): SelectionMessage | null {
		if (raw.trim() === "") {
			return { key: "configureDialog.typedPath.empty" };
		}
		const folder = repositorySyncTreeSelection(raw);
		if (folder !== root) {
			apply({ type: "setRoot", root: folder });
		}
		return null;
	}

	/**
	 * The project's ignore list to send with the configuration, or
	 * `undefined` to leave it alone: the staged edits applied to the rules
	 * as saved NOW, not as this dialog last read them, so a rule saved
	 * elsewhere in the meantime is kept. Throws when they cannot be read.
	 */
	async function rulesToSave(): Promise<string[] | null | undefined> {
		if (!hasExclusionEdits(selection.edits)) {
			return undefined;
		}
		setReadingRules(true);
		try {
			const fresh = await queryClient.fetchQuery({
				...settingsQuery,
				staleTime: 0,
			});
			const next = stagedProjectGlobs(fresh.ignoreGlobs, selection.edits);
			return projectGlobsChanged(fresh.ignoreGlobs, next)
				? next
				: undefined;
		} finally {
			setReadingRules(false);
		}
	}

	async function submit() {
		if (root === null) {
			return;
		}
		clearInlineError();
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
				rootPath: root,
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
			setSelection((prev) => ({ ...prev, edits: NO_EXCLUSION_EDITS }));
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

	const ids = {
		error: "instructions-sync-error",
		nothingSelected: `${id}-nothing-selected`,
		saveReason: `${id}-save-reason`,
		removal: `${id}-removal`,
	};
	const saveBlocked: "noRepository" | "noBranch" | "nothingSelected" | null =
		pending
			? null
			: integrationId === ""
				? "noRepository"
				: branch === ""
					? "noBranch"
					: root === null
						? "nothingSelected"
						: null;
	const removedRules = model.removedSavedRules;
	const saveDescribedBy =
		[
			saveBlocked === "nothingSelected"
				? ids.nothingSelected
				: saveBlocked
					? ids.saveReason
					: null,
			removedRules.length > 0 ? ids.removal : null,
		]
			.filter((part): part is string => part !== null)
			.join(" ") || undefined;
	const typedPath = offersTypedPath(listing);

	return (
		<Dialog open={open} onOpenChange={onOpenChange}>
			<DialogContent className="max-w-2xl">
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
									setSelection((prev) => ({
										...prev,
										edits: NO_EXCLUSION_EDITS,
									}));
									clearInlineError();
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
									? ids.error
									: undefined
							}
						/>
					</div>
					<RepositorySyncSelectionTree
						namespace={NAMESPACE}
						listing={listing}
						row={model.row}
						onToggle={(node) => {
							const action = model.actionFor(node);
							if (action) {
								apply(action);
							}
						}}
						onSelectAll={() => apply(SELECT_ALL_INSTRUCTIONS)}
						onSelectNone={() => apply(SELECT_NONE_INSTRUCTIONS)}
						disabled={pending}
						initiallyOpen={initiallyOpen}
						notices={
							<RulesNotices
								settingsFailed={settings.isError}
								ignoreFile={
									root !== null && listing.status === "ready"
										? ignoreFile
										: { kind: "none" }
								}
							/>
						}
						summary={
							<SelectionSummary
								namespace={NAMESPACE}
								summary={summary}
								nothingSelectedId={ids.nothingSelected}
							/>
						}
					/>
					<SelectedPathsList
						namespace={NAMESPACE}
						disabled={pending}
						included={
							root === null
								? []
								: [
										{
											path: root,
											type: "dir",
											onRemove: () =>
												apply(SELECT_NONE_INSTRUCTIONS),
										},
									]
						}
						excluded={model.leftOut.map((item) => ({
							path: item.path,
							type: item.type,
							onReinclude: () => apply(item.action),
						}))}
					/>
					{typedPath ? (
						<AddRepositoryPathInput
							namespace={NAMESPACE}
							disabled={pending}
							onAdd={addTypedFolder}
							serverErrorId={
								inlineErrorField === "root"
									? ids.error
									: undefined
							}
						/>
					) : null}
					{removedRules.length > 0 ? (
						<div
							id={ids.removal}
							className="flex flex-col gap-1 rounded-md border border-border p-2 text-xs"
						>
							<p>{t("configureDialog.removalNotice")}</p>
							<ul className="flex flex-wrap gap-1.5">
								{removedRules.map((rule) => (
									<li key={rule}>
										<code>{rule}</code>
									</li>
								))}
							</ul>
						</div>
					) : null}
					{inlineError ? (
						<p
							id={ids.error}
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
				<DialogFooter className="items-center">
					{saveBlocked === "noRepository" ||
					saveBlocked === "noBranch" ? (
						<p
							id={ids.saveReason}
							className="mr-auto text-muted-foreground text-xs"
						>
							{t(`configureDialog.saveBlocked.${saveBlocked}`)}
						</p>
					) : null}
					<Button
						variant="outline"
						onClick={() => onOpenChange(false)}
						disabled={pending}
					>
						{t("configureDialog.cancel")}
					</Button>
					<Button
						onClick={submit}
						disabled={pending || saveBlocked !== null}
						aria-describedby={saveDescribedBy}
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

/**
 * What applies to the synced folder's rules as a whole: the project's rules
 * could not be loaded, or the root's `.fabricignore` is being read, could
 * not be read, replaces the project's rules, or is too large to apply. Each
 * row it affects says so in a few words; this is the whole story.
 */
function RulesNotices({
	settingsFailed,
	ignoreFile,
}: {
	settingsFailed: boolean;
	ignoreFile: IgnoreFileState;
}) {
	const t = useTranslations(`${NAMESPACE}.tree.notices`);
	return (
		<>
			{settingsFailed ? (
				<p role="alert" className="text-destructive text-xs">
					{t("settingsError")}
				</p>
			) : null}
			{ignoreFile.kind === "loading" ? (
				<output className="flex items-center gap-2 text-muted-foreground text-xs">
					<Loader2Icon
						className="size-3 animate-spin"
						aria-hidden="true"
					/>
					{t("ignoreFileLoading")}
				</output>
			) : null}
			{ignoreFile.kind === "error" ? (
				<p role="alert" className="text-destructive text-xs">
					{t("ignoreFileError")}
				</p>
			) : null}
			{ignoreFile.kind === "rules" ? (
				<p className="text-xs">{t("fabricignore")}</p>
			) : null}
			{ignoreFile.kind === "tooLarge" ? (
				<p className="text-muted-foreground text-xs">
					{t("ignoreFileTooLarge")}
				</p>
			) : null}
		</>
	);
}
