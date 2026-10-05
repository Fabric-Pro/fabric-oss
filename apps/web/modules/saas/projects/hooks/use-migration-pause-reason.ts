"use client";

import { useTranslations } from "next-intl";
import {
	migrationPause,
	type RepositoryMigrationView,
} from "../lib/instructions-migration";
import { useInstructionMigrationRepository } from "./instruction-migration-repository";

/**
 * The sentence that says why the tab's changes are paused while a move of
 * uploaded instructions into a repository is open (Fizzy #2878 §9), or null
 * when none is. It is the sentence a refused action gives, read from the move
 * as the tab last saw it (`move` is null before the first read arrives).
 */
export function useMigrationPauseReason(
	migrating: boolean,
	move: RepositoryMigrationView | null,
): string | null {
	const t = useTranslations("projects.codingInstructions.actionErrors");
	const repository = useInstructionMigrationRepository();
	if (!migrating) {
		return null;
	}
	const pause = migrationPause(move);
	return t(pause.key, {
		repository: repository ?? t("migrationRepositoryFallback"),
		number: pause.number ?? "",
	});
}
