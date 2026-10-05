"use client";

import { useTranslations } from "next-intl";
import { migrationOpenRefusal } from "../lib/instructions-action-error";
import {
	type SyncAction,
	syncActionErrorKey,
} from "../lib/instructions-repository-sync";
import { useInstructionActionError } from "./use-instruction-action-error";

/**
 * `(error, action, ref) => translated line`, for a failed repository-sync
 * action's toast: the sentence for a change a move into a repository has
 * paused, else the typed code's own words or the action's generic line.
 */
export function useSyncActionError(
	migrationRepository?: string | null,
): (error: unknown, action: SyncAction, ref?: string) => string {
	const t = useTranslations("projects.codingInstructions.repositorySync");
	const actionError = useInstructionActionError(migrationRepository);
	return (error, action, ref = "") =>
		migrationOpenRefusal(error) === null
			? t(syncActionErrorKey(error, action), { ref })
			: actionError(error);
}
