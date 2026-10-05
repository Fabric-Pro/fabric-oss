"use client";

import { useTranslations } from "next-intl";
import {
	instructionActionErrorKey,
	migrationOpenRefusal,
} from "../lib/instructions-action-error";
import { migrationRefusalPause } from "../lib/instructions-migration";
import { useInstructionMigrationRepository } from "./instruction-migration-repository";

/**
 * `(error) => translated line`, for a failed Coding Instructions action's
 * toast. The repository a move names comes from the tab's provider; the tab
 * itself, which is above its own provider, passes it in.
 */
export function useInstructionActionError(
	migrationRepository?: string | null,
): (error: unknown) => string {
	const t = useTranslations("projects.codingInstructions.actionErrors");
	const providedRepository = useInstructionMigrationRepository();
	return (error) => {
		const move = migrationOpenRefusal(error);
		if (move === null) {
			return t(instructionActionErrorKey(error));
		}
		const pause = migrationRefusalPause(move);
		return t(pause.key, {
			repository:
				migrationRepository ??
				providedRepository ??
				t("migrationRepositoryFallback"),
			number: pause.number ?? "",
		});
	};
}
