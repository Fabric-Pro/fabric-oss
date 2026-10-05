"use client";

import {
	COMMIT_SUBJECT_MAX_CHARS,
	type CommitRefusal,
} from "@saas/projects/lib/instructions-direct-commit";
import { Input } from "@ui/components/input";
import { Label } from "@ui/components/label";
import { useTranslations } from "next-intl";
import { useId } from "react";

/**
 * The commit message a "Commit to <branch>" starts from, editable.
 *
 * One line, as a person writes `git commit -m`; it is the subject History
 * shows, and it cannot outgrow the subject limit. An empty one is held back by
 * the surface's own button; the server's refusal of a message (which also
 * catches a credential in it) arrives as `refusal` and is worded from its
 * code, never quoted.
 */
export function CommitMessageField({
	value,
	onChange,
	refusal = null,
	disabled = false,
	className,
}: {
	value: string;
	onChange: (value: string) => void;
	refusal?: CommitRefusal | null;
	disabled?: boolean;
	className?: string;
}) {
	const t = useTranslations("projects.codingInstructions.commit");
	const id = useId();
	const error =
		refusal?.field === "message" ? t(`refusals.${refusal.key}`) : null;
	return (
		<div className={className ?? "flex flex-col gap-1.5"}>
			<Label htmlFor={id}>{t("messageLabel")}</Label>
			<Input
				id={id}
				value={value}
				disabled={disabled}
				maxLength={COMMIT_SUBJECT_MAX_CHARS}
				spellCheck
				aria-invalid={error ? true : undefined}
				aria-describedby={error ? `${id}-error` : undefined}
				onChange={(event) => onChange(event.target.value)}
			/>
			{error ? (
				<p id={`${id}-error`} className="text-destructive text-sm">
					{error}
				</p>
			) : null}
		</div>
	);
}
