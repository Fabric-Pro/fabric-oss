"use client";

import { orpc } from "@shared/lib/orpc-query-utils";
import { useMutation } from "@tanstack/react-query";
import { useTranslations } from "next-intl";
import { toast } from "sonner";
import {
	type ContextSyncNowResult,
	type ContextSyncState,
	contextSyncActionErrorMessage,
	contextSyncConfigureErrorMessage,
	contextSyncNowResultMessage,
} from "../../lib/context-repository-sync";
import {
	applyContextAction,
	type ContextActionResult,
	type ContextSelection,
} from "./lib/context-selection";

/**
 * Removing a file from Living Memory without touching the repository: the
 * file is left out of the sync, which then removes it from Context, and the
 * next runs keep it out. Restoring takes it off the left-out list and the
 * file syncs again. Pure; the hook below applies it.
 *
 * A file inside a selected folder is left out (`exclude`); a file selected
 * on its own is unselected (`unselect`), since nothing may be left out of
 * itself, and it then is not on the left-out list to restore from. The last
 * selected path cannot go: that is disconnecting the sync.
 */
export function leaveOutOfLivingMemory(
	selection: ContextSelection,
	path: string,
): ContextActionResult | { ok: false; code: "LAST_PATH" } {
	if (selection.paths.includes(path)) {
		if (selection.paths.length === 1) {
			return { ok: false, code: "LAST_PATH" };
		}
		return applyContextAction(selection, { type: "unselect", path });
	}
	return applyContextAction(selection, { type: "exclude", path });
}

/**
 * Where the Context tab shows each left-out path: in the Living Memory
 * folder it was left out of (its parent folder), when that folder is shown;
 * otherwise (a left-out folder whose parent has no synced file, or a folder
 * whose every file is left out) in a group of its own.
 */
export function placeLeftOutPaths(
	folders: readonly string[],
	excludedPaths: readonly string[],
): { byFolder: Map<string, string[]>; elsewhere: string[] } {
	const shown = new Set(folders);
	const byFolder = new Map<string, string[]>();
	const elsewhere: string[] = [];
	for (const path of excludedPaths) {
		const slash = path.lastIndexOf("/");
		const parent = slash === -1 ? "" : path.slice(0, slash);
		if (shown.has(parent)) {
			byFolder.set(parent, [...(byFolder.get(parent) ?? []), path]);
		} else {
			elsewhere.push(path);
		}
	}
	return { byFolder, elsewhere };
}

export function restoreToLivingMemory(
	selection: ContextSelection,
	path: string,
): ContextActionResult {
	return applyContextAction(selection, { type: "reinclude", path });
}

/**
 * Save a changed selection the way the configure dialog does: `configure`
 * with the stored repository and branch, then a run, unless the server
 * queued one behind a run already open.
 */
export function useLivingMemoryExclusion({
	projectId,
	organizationId,
	state,
	onChanged,
}: {
	projectId: string;
	organizationId: string | null;
	state: ContextSyncState | undefined;
	onChanged: () => void;
}) {
	const t = useTranslations("projects.contexts.livingMemory.repositorySync");
	const configure = useMutation(
		orpc.projects.contexts.repositorySync.configure.mutationOptions(),
	);
	const syncNow = useMutation(
		orpc.projects.contexts.repositorySync.syncNow.mutationOptions(),
	);
	const configured = state?.configured ?? null;

	async function save(
		result: ReturnType<typeof leaveOutOfLivingMemory>,
		done: string,
	): Promise<boolean> {
		if (!configured) {
			return false;
		}
		if (!result.ok) {
			toast.error(t(`exclusions.errors.${result.code}`));
			return false;
		}
		let saved: Awaited<ReturnType<typeof configure.mutateAsync>>;
		try {
			saved = await configure.mutateAsync({
				projectId,
				organizationId,
				repositoryIntegrationId: configured.repositoryIntegrationId,
				ref: configured.ref,
				paths: [...result.selection.paths],
				excludedPaths: [...result.selection.excludedPaths],
			});
		} catch (error) {
			const mapped = contextSyncConfigureErrorMessage(error);
			toast.error(t(mapped.key, mapped.values));
			return false;
		}
		toast.success(t(done));
		if (!("syncQueued" in saved)) {
			try {
				const run = (await syncNow.mutateAsync({
					projectId,
					organizationId,
				})) as ContextSyncNowResult;
				const announced = contextSyncNowResultMessage(run);
				if (announced.tone !== "success") {
					toast[announced.tone](t(announced.key));
				}
			} catch (error) {
				const mapped = contextSyncActionErrorMessage(error, "syncNow");
				toast.error(t(mapped.key, mapped.values));
			}
		}
		onChanged();
		return true;
	}

	const selection: ContextSelection | null = configured
		? { paths: configured.paths, excludedPaths: configured.excludedPaths }
		: null;

	return {
		pending: configure.isPending || syncNow.isPending,
		leaveOut: (path: string) =>
			selection
				? save(
						leaveOutOfLivingMemory(selection, path),
						"exclusions.leftOut",
					)
				: Promise.resolve(false),
		restore: (path: string) =>
			selection
				? save(
						restoreToLivingMemory(selection, path),
						"exclusions.restored",
					)
				: Promise.resolve(false),
	};
}
