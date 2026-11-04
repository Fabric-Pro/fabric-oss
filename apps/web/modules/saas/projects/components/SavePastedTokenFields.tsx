"use client";

/**
 * Beside a pasted GitHub token, while the credential manager is on (spec
 * 2026-11-04 §4.3): "Save in the credential manager" with the credential's
 * name, and the question asked when the person already saved a token for the
 * same GitHub account. Shared by the repository import form and the project
 * repository "Connect with a token (PAT)" form.
 */

import { Button } from "@ui/components/button";
import { Checkbox } from "@ui/components/checkbox";
import { Input } from "@ui/components/input";
import { Label } from "@ui/components/label";
import { useTranslations } from "next-intl";
import { useId } from "react";

/** A saved credential the server named instead of saving a duplicate. */
export type ExistingSavedToken = {
	id: string;
	label: string;
	externalAccountLogin: string | null;
};

export function SaveInCredentialManagerFields({
	save,
	onSaveChange,
	label,
	onLabelChange,
	disabled = false,
}: {
	save: boolean;
	onSaveChange: (save: boolean) => void;
	label: string;
	onLabelChange: (label: string) => void;
	disabled?: boolean;
}) {
	const t = useTranslations("projects.savePastedToken");
	const id = useId();
	const ids = {
		save: `${id}-save`,
		saveHint: `${id}-save-hint`,
		label: `${id}-label`,
		labelHint: `${id}-label-hint`,
	};
	return (
		<div className="flex flex-col gap-2">
			<div className="flex items-start gap-2">
				<Checkbox
					id={ids.save}
					checked={save}
					disabled={disabled}
					onCheckedChange={(value) => onSaveChange(value === true)}
					aria-describedby={ids.saveHint}
				/>
				<div className="flex flex-col gap-0.5">
					<Label htmlFor={ids.save} className="text-sm">
						{t("save")}
					</Label>
					<p
						id={ids.saveHint}
						className="text-muted-foreground text-xs"
					>
						{t("saveHint")}
					</p>
				</div>
			</div>
			{save ? (
				<div className="flex flex-col gap-1">
					<Label htmlFor={ids.label} className="text-xs">
						{t("labelLabel")}
					</Label>
					<Input
						id={ids.label}
						value={label}
						maxLength={120}
						disabled={disabled}
						placeholder={t("labelPlaceholder")}
						onChange={(e) => onLabelChange(e.target.value)}
						aria-describedby={ids.labelHint}
						className="text-sm"
					/>
					<p
						id={ids.labelHint}
						className="text-muted-foreground text-xs"
					>
						{t("labelHint")}
					</p>
				</div>
			) : null}
		</div>
	);
}

export function SavedTokenReusePrompt({
	existing,
	onUse,
	onSaveAsNew,
	busy = false,
}: {
	existing: ExistingSavedToken;
	onUse: () => void;
	onSaveAsNew: () => void;
	busy?: boolean;
}) {
	const t = useTranslations("projects.savePastedToken");
	return (
		<div
			role="alert"
			className="flex flex-col gap-2 rounded-md border bg-muted/40 p-3"
		>
			<p className="text-sm">
				{t("reuseMessage", {
					login: existing.externalAccountLogin ?? existing.label,
					label: existing.label,
				})}
			</p>
			<div className="flex gap-2">
				<Button type="button" size="sm" disabled={busy} onClick={onUse}>
					{t("use")}
				</Button>
				<Button
					type="button"
					size="sm"
					variant="outline"
					disabled={busy}
					onClick={onSaveAsNew}
				>
					{t("saveAsNew")}
				</Button>
			</div>
		</div>
	);
}
