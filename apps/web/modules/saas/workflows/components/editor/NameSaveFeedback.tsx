"use client";
import { useTranslations } from "next-intl";
export type NameSaveStatus = "idle" | "saving" | "saved" | "error";
export function NameSaveFeedback({ status }: { status: NameSaveStatus }) {
	const t = useTranslations("workflows.authoring");
	const copy = (key: string, fallback: string) =>
		t.has(key) ? t(key) : fallback;
	return (
		<span
			role="note"
			className={
				status === "error"
					? "block text-xs text-destructive"
					: "block text-xs text-muted-foreground"
			}
			aria-live="polite"
		>
			{status === "saving"
				? copy("savingName", "Saving name…")
				: status === "saved"
					? copy("savedName", "Name saved")
					: status === "error"
						? copy(
								"nameFailed",
								"Name was not saved. Press Enter or leave the field to retry.",
							)
						: copy(
								"nameAutomatic",
								"Name saves automatically when you leave the field.",
							)}
		</span>
	);
}
