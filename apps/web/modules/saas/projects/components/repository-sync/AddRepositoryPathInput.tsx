"use client";

import { Button } from "@ui/components/button";
import { Input } from "@ui/components/input";
import { Label } from "@ui/components/label";
import { useTranslations } from "next-intl";
import { useId, useState } from "react";
import {
	type SelectionMessage,
	translateSelectionMessage,
} from "./lib/selection-row";
import type { RepositorySyncNamespace } from "./RepositorySyncSelectionTree";

/**
 * The typed "Add a path" input, offered where the tree cannot reach every
 * path: a provider with no listing, a truncated listing, or a listing that
 * failed (Fizzy #2750 §3.2). What it adds goes through the same adapter
 * transition as a tick (Coding Instructions: the synced folder; Living
 * Memory: one more selected path), so typing can never do what the tree
 * could not. Exclusions are chosen in the tree only, which the hint says.
 */
export function AddRepositoryPathInput({
	namespace,
	onAdd,
	disabled,
	serverErrorId,
}: {
	namespace: RepositorySyncNamespace;
	/** Add the typed path; the refusal to show inline, or `null` when added. */
	onAdd: (raw: string) => SelectionMessage | null;
	disabled: boolean;
	/** The dialog's own inline error, when it is about this field. */
	serverErrorId?: string;
}) {
	const t = useTranslations(namespace);
	const id = useId();
	const [value, setValue] = useState("");
	const [error, setError] = useState<SelectionMessage | null>(null);
	const inputId = `${id}-input`;
	const errorId = `${id}-error`;
	const hintId = `${id}-hint`;

	function add() {
		const refusal = onAdd(value);
		setError(refusal);
		if (refusal === null) {
			setValue("");
		}
	}

	const describedBy =
		[error ? errorId : hintId, serverErrorId]
			.filter((part): part is string => Boolean(part))
			.join(" ") || undefined;
	return (
		<div className="flex flex-col gap-1.5">
			<Label htmlFor={inputId}>
				{t("configureDialog.typedPath.label")}
			</Label>
			<div className="flex gap-2">
				<Input
					id={inputId}
					value={value}
					placeholder={t("configureDialog.typedPath.placeholder")}
					disabled={disabled}
					onChange={(e) => {
						setValue(e.target.value);
						setError(null);
					}}
					onKeyDown={(e) => {
						if (e.key === "Enter") {
							e.preventDefault();
							add();
						}
					}}
					aria-invalid={error || serverErrorId ? true : undefined}
					aria-describedby={describedBy}
				/>
				<Button
					type="button"
					variant="outline"
					onClick={add}
					disabled={disabled}
				>
					{t("configureDialog.typedPath.add")}
				</Button>
			</div>
			{error ? (
				<p
					id={errorId}
					role="alert"
					className="text-destructive text-xs"
				>
					{translateSelectionMessage(t, error)}
				</p>
			) : (
				<p id={hintId} className="text-muted-foreground text-xs">
					{t("configureDialog.typedPath.hint")}
				</p>
			)}
		</div>
	);
}
