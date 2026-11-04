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

/** The copy each mode reads under `configureDialog`. */
const COPY_KEYS = {
	include: "configureDialog.typedPath",
	exclude: "configureDialog.typedExclusion",
} as const;

/**
 * The typed path inputs, offered where the tree cannot reach every path: a
 * provider with no listing, a truncated listing, or a listing that failed.
 * What one adds goes through the same adapter
 * transition as a tick (`include`: Coding Instructions' synced folder, or
 * one more Living Memory selected path) or an untick (`exclude`: a path
 * left out, as Living Memory's left-out paths or Coding Instructions' own
 * ignore rules), so typing can never do what the tree could not. While
 * `blockedReason` is set the input takes nothing and says why.
 */
export function AddRepositoryPathInput({
	namespace,
	mode = "include",
	onAdd,
	disabled,
	blockedReason = null,
	serverErrorId,
}: {
	namespace: RepositorySyncNamespace;
	mode?: "include" | "exclude";
	/** Add the typed path; the refusal to show inline, or `null` when added. */
	onAdd: (raw: string) => SelectionMessage | null;
	disabled: boolean;
	/** Why nothing can be typed now (no folder chosen yet, rules unknown). */
	blockedReason?: SelectionMessage | null;
	/** The dialog's own inline error, when it is about this field. */
	serverErrorId?: string;
}) {
	const t = useTranslations(namespace);
	const id = useId();
	const [value, setValue] = useState("");
	const [error, setError] = useState<SelectionMessage | null>(null);
	const copy = COPY_KEYS[mode];
	const inputId = `${id}-input`;
	const errorId = `${id}-error`;
	const hintId = `${id}-hint`;
	const off = disabled || blockedReason !== null;

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
			<Label htmlFor={inputId}>{t(`${copy}.label`)}</Label>
			<div className="flex gap-2">
				<Input
					id={inputId}
					value={value}
					placeholder={t(`${copy}.placeholder`)}
					disabled={off}
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
					disabled={off}
				>
					{t(`${copy}.add`)}
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
					{blockedReason
						? translateSelectionMessage(t, blockedReason)
						: t(`${copy}.hint`)}
				</p>
			)}
		</div>
	);
}
