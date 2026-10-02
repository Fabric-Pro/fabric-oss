"use client";

import { useTranslations } from "next-intl";
import { instructionActionErrorKey } from "../lib/instructions-action-error";

/** `(error) => translated line`, for a failed Coding Instructions action's toast. */
export function useInstructionActionError(): (error: unknown) => string {
	const t = useTranslations("projects.codingInstructions.actionErrors");
	return (error) => t(instructionActionErrorKey(error));
}
