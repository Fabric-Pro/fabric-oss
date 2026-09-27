"use client";

import { orpc } from "@shared/lib/orpc-query-utils";
import { useMutation, useQuery } from "@tanstack/react-query";
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
import { useSettledValue } from "../hooks/use-settled-value";
import {
	activeContextSyncIntegrations,
	CONTEXT_SYNC_MAX_PATHS,
	type ContextSyncConfiguration,
	type ContextSyncIntegration,
	type ContextSyncNowResult,
	contextSyncAutomaticInput,
	contextSyncConfigureErrorMessage,
	contextSyncNowResultMessage,
	contextSyncPathValidationMessage,
	contextSyncTreeErrorMessage,
	validateContextSyncPathAddition,
} from "../lib/context-repository-sync";
import { AddRepositoryPathInput } from "./repository-sync/AddRepositoryPathInput";
import {
	applyContextAction,
	type ContextAction,
	type ContextRepositoryTreeEntry,
	type ContextSelection,
	contextSelectionModel,
	contextSummary,
} from "./repository-sync/lib/context-selection";
import {
	ancestorsOf,
	indexRepositoryTree,
} from "./repository-sync/lib/repository-tree";
import {
	offersTypedPath,
	type SelectionMessage,
	selectionTreeListingOf,
} from "./repository-sync/lib/selection-row";
import { RepositorySyncSelectionTree } from "./repository-sync/RepositorySyncSelectionTree";
import { SelectedPathsList } from "./repository-sync/SelectedPathsList";
import { SelectionSummary } from "./repository-sync/SelectionSummary";

const NAMESPACE = "projects.contexts.livingMemory.repositorySync";

/** How long the branch must stay unchanged before the listing is fetched. */
const BRANCH_DEBOUNCE_MS = 500;
const LIST_TREE_STALE_MS = 5 * 60 * 1000;

/**
 * Points the project's Living Memory at selected folders and files of a
 * branch in one of its connected repositories, then starts the first sync
 * (design 2026-09-23 §5.1, §7.2, Fizzy #2657). The server verifies the
 * branch and canonicalizes the paths before saving anything; what it refuses
 * is shown inline, beside the field it is about when it names one.
 *
 * What syncs is chosen in the shared selection tree over the chosen branch
 * (`RepositorySyncSelectionTree`, Fizzy #2750 §5.7): ticking a folder or file
 * selects it (a ticked folder is live: files added to it later sync too),
 * and unticking something inside a ticked folder leaves it out, pruned from
 * Living Memory on the next sync. The selection is the one reducer
 * (`./repository-sync/lib/context-selection.ts`) the tree, the list under
 * it and the typed "Add a path" input all use; the typed input is offered
 * where the tree cannot reach (no listing, a truncated one, or a failed one).
 * Nothing is ticked for a new configuration, and Save waits until something
 * is. Save always sends `excludedPaths` explicitly — `[]` clears what was
 * left out — since only a caller that omits it (the status card's toggle)
 * relies on the server keeping the stored list.
 *
 * Mounted only while open, so a background poll of the tab cannot overwrite
 * what someone is choosing.
 *
 * "Keep in sync automatically" (§11.1, Fizzy #2673) is ticked for a new
 * configuration and seeded from the stored value when changing one, as the
 * coding-instructions dialog does. It is sent on a first configure, and
 * afterwards only once touched (`contextSyncAutomaticInput`).
 */
export function ConfigureContextRepositorySyncDialog({
	projectId,
	organizationId,
	open,
	onOpenChange,
	integrations,
	current,
	onSaved,
}: {
	projectId: string;
	organizationId: string | null;
	open: boolean;
	onOpenChange: (open: boolean) => void;
	/** Every connected integration, as `repositorySync.get` returns them. */
	integrations: ContextSyncIntegration[];
	current: ContextSyncConfiguration | null;
	onSaved: () => void;
}) {
	const t = useTranslations(NAMESPACE);
	const id = useId();
	const active = activeContextSyncIntegrations(integrations);
	const seed =
		(current &&
			active.find((i) => i.id === current.repositoryIntegrationId)) ??
		active[0] ??
		null;
	const [integrationId, setIntegrationId] = useState(seed?.id ?? "");
	const [ref, setRef] = useState(current?.ref ?? seed?.defaultBranch ?? "");
	const [selection, setSelection] = useState<ContextSelection>(() => ({
		paths: current?.paths ?? [],
		excludedPaths: current?.excludedPaths ?? [],
	}));
	// The way to what is stored, open from the start: the folders above every
	// selected and left-out path.
	const [initiallyOpen] = useState<ReadonlySet<string>>(
		() =>
			new Set(
				[
					...(current?.paths ?? []),
					...(current?.excludedPaths ?? []),
				].flatMap(ancestorsOf),
			),
	);
	const [automatic, setAutomatic] = useState(current?.automatic ?? true);
	const [automaticTouched, setAutomaticTouched] = useState(false);
	const [inlineError, setInlineError] = useState<string | null>(null);
	const [inlineErrorField, setInlineErrorField] = useState<
		"branch" | "paths" | null
	>(null);

	const configure = useMutation(
		orpc.projects.contexts.repositorySync.configure.mutationOptions(),
	);
	const syncNow = useMutation(
		orpc.projects.contexts.repositorySync.syncNow.mutationOptions(),
	);
	const pending = configure.isPending || syncNow.isPending;
	const selected = active.find((i) => i.id === integrationId) ?? null;
	const branch = ref.trim();

	// The branch's listing: only a settled branch is listed, since a key per
	// keystroke would be a request per keystroke.
	const debouncedBranch = useSettledValue(branch, BRANCH_DEBOUNCE_MS);
	const listingRequested = integrationId !== "" && branch !== "";
	const listingEnabled =
		open && listingRequested && debouncedBranch === branch;
	const treeQuery = useQuery(
		orpc.projects.contexts.repositorySync.listTree.queryOptions({
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
	const listing = selectionTreeListingOf<ContextRepositoryTreeEntry>({
		requested: listingRequested,
		enabled: listingEnabled,
		query: treeQuery,
		errorMessage: (error) =>
			contextSyncTreeErrorMessage(error, debouncedBranch),
	});
	const entries =
		listing.status === "ready"
			? (listing.entries as readonly ContextRepositoryTreeEntry[])
			: undefined;
	const treeIndex = useMemo(
		() => (entries ? indexRepositoryTree(entries) : null),
		[entries],
	);
	const truncated = listing.status === "ready" && listing.truncated;
	const model = useMemo(
		() => contextSelectionModel({ tree: treeIndex, selection }),
		[treeIndex, selection],
	);
	const summary = contextSummary({
		model,
		tree: treeIndex,
		listing: listing.status,
		truncated,
	});

	function clearInlineError() {
		setInlineError(null);
		setInlineErrorField(null);
	}

	function apply(action: ContextAction) {
		const result = applyContextAction(selection, action);
		if (result.ok) {
			setSelection(result.selection);
			clearInlineError();
		}
	}

	/** A typed path: the same transition as ticking it in the tree. */
	function addTypedPath(raw: string): SelectionMessage | null {
		// Nothing typed is not "the whole repository": Select all is.
		if (raw.trim() === "") {
			return { key: "configureDialog.typedPath.empty" };
		}
		const validated = validateContextSyncPathAddition(raw, selection.paths);
		if (!validated.ok) {
			return contextSyncPathValidationMessage(validated.error);
		}
		const result = applyContextAction(selection, {
			type: "include",
			path: validated.path,
		});
		if (!result.ok) {
			return {
				key: "pathErrors.TOO_MANY_PATHS",
				values: { max: CONTEXT_SYNC_MAX_PATHS },
			};
		}
		setSelection(result.selection);
		clearInlineError();
		return null;
	}

	async function submit() {
		clearInlineError();
		try {
			await configure.mutateAsync({
				projectId,
				organizationId,
				repositoryIntegrationId: integrationId,
				ref: branch,
				paths: [...selection.paths],
				// Always explicit: `[]` clears what was left out.
				excludedPaths: [...selection.excludedPaths],
				...contextSyncAutomaticInput({
					current,
					touched: automaticTouched,
					automatic,
				}),
			});
		} catch (error) {
			const mapped = contextSyncConfigureErrorMessage(error);
			const message = t(mapped.key, mapped.values);
			if (mapped.inline) {
				setInlineError(message);
				setInlineErrorField(
					mapped.field === "branch" || mapped.field === "paths"
						? mapped.field
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
				organizationId,
			})) as ContextSyncNowResult;
			const announced = contextSyncNowResultMessage(result);
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
		error: "context-sync-error",
		nothingSelected: `${id}-nothing-selected`,
		saveReason: `${id}-save-reason`,
	};
	const saveBlocked: "noRepository" | "noBranch" | "nothingSelected" | null =
		pending
			? null
			: integrationId === ""
				? "noRepository"
				: branch === ""
					? "noBranch"
					: selection.paths.length === 0
						? "nothingSelected"
						: null;
	const saveDescribedBy =
		saveBlocked === "nothingSelected"
			? ids.nothingSelected
			: saveBlocked
				? ids.saveReason
				: undefined;
	const listedType = (path: string) =>
		path === "" ? "dir" : (treeIndex?.nodes.get(path)?.type ?? null);

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
					{active.length > 1 ? (
						<div className="flex flex-col gap-1.5">
							<Label htmlFor="context-sync-repository">
								{t("configureDialog.repositoryLabel")}
							</Label>
							<select
								id="context-sync-repository"
								className="h-9 rounded-md border border-input bg-background px-3 text-sm"
								value={integrationId}
								onChange={(e) => {
									const next = active.find(
										(i) => i.id === e.target.value,
									);
									setIntegrationId(e.target.value);
									if (next) {
										setRef(next.defaultBranch);
									}
									clearInlineError();
								}}
							>
								{active.map((i) => (
									<option key={i.id} value={i.id}>
										{`${i.provider} · ${i.repositoryOwner}/${i.repositoryName}`}
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
						<Label htmlFor="context-sync-branch">
							{t("configureDialog.branchLabel")}
						</Label>
						<Input
							id="context-sync-branch"
							value={ref}
							onChange={(e) => {
								setRef(e.target.value);
								clearInlineError();
							}}
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
						onSelectAll={() => apply({ type: "selectAll" })}
						onSelectNone={() => apply({ type: "selectNone" })}
						disabled={pending}
						initiallyOpen={initiallyOpen}
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
						included={selection.paths.map((path) => ({
							path,
							type: listedType(path),
							onRemove: () => apply({ type: "unselect", path }),
						}))}
						excluded={selection.excludedPaths.map((path) => ({
							path,
							type: listedType(path),
							onReinclude: () =>
								apply({ type: "reinclude", path }),
						}))}
					/>
					{offersTypedPath(listing) ? (
						<AddRepositoryPathInput
							namespace={NAMESPACE}
							disabled={pending}
							onAdd={addTypedPath}
							serverErrorId={
								inlineErrorField === "paths"
									? ids.error
									: undefined
							}
						/>
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
							id="context-sync-automatic"
							className="mt-0.5"
							checked={automatic}
							onCheckedChange={(value) => {
								setAutomatic(value === true);
								setAutomaticTouched(true);
							}}
							aria-describedby="context-sync-automatic-hint"
						/>
						<div className="flex flex-col gap-0.5">
							<Label htmlFor="context-sync-automatic">
								{t("configureDialog.automaticLabel")}
							</Label>
							<p
								id="context-sync-automatic-hint"
								className="text-muted-foreground text-xs"
							>
								{t("configureDialog.automaticHint")}
							</p>
						</div>
					</div>
					<p className="text-muted-foreground text-sm">
						{t("configureDialog.contextignoreNotice")}
					</p>
					<p className="text-muted-foreground text-sm">
						{t("configureDialog.pruneNotice")}
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
