"use client";

import { Badge } from "@ui/components/badge";
import { XIcon } from "lucide-react";
import { useTranslations } from "next-intl";
import { useId } from "react";
import {
	type SelectionMessage,
	translateSelectionMessage,
} from "./lib/selection-row";
import type { RepositorySyncNamespace } from "./RepositorySyncSelectionTree";

export type SelectedPathItem = {
	path: string;
	/** The listing's type for it, when known: a folder reads `path/`. */
	type: "file" | "dir" | null;
};

export type IncludedPathItem = SelectedPathItem & { onRemove: () => void };

export type ExcludedPathItem = SelectedPathItem & {
	/** `null` when it cannot be re-included here; `disabledReason` says why. */
	onReinclude: (() => void) | null;
	disabledReason?: SelectionMessage | null;
};

/**
 * What the selection holds, under the tree (Fizzy #2750 §3.2): each
 * included path (× removes it) and each exclusion as "except …" (×
 * includes it again, when it can be). Replaces Coding Instructions' typed
 * folder field and Living Memory's chip row; the tree, the typed input and
 * this list all change one selection.
 */
export function SelectedPathsList({
	namespace,
	included,
	excluded,
	disabled,
}: {
	namespace: RepositorySyncNamespace;
	included: readonly IncludedPathItem[];
	excluded: readonly ExcludedPathItem[];
	disabled: boolean;
}) {
	const t = useTranslations(namespace);
	const id = useId();
	if (included.length === 0) {
		return null;
	}
	const labelId = `${id}-label`;
	const display = (item: SelectedPathItem) =>
		item.path === ""
			? t("configureDialog.selectedPaths.wholeRepository")
			: item.type === "dir"
				? `${item.path}/`
				: item.path;
	return (
		<div className="flex flex-col gap-1">
			<p id={labelId} className="font-medium text-xs">
				{t("configureDialog.selectedPaths.label")}
			</p>
			<ul aria-labelledby={labelId} className="flex flex-wrap gap-1.5">
				{included.map((item) => (
					<li key={`in:${item.path}`}>
						<Badge variant="outline" className="gap-1 text-xs">
							{display(item)}
							<button
								type="button"
								aria-label={t(
									"configureDialog.selectedPaths.remove",
									{
										path: display(item),
									},
								)}
								disabled={disabled}
								onClick={item.onRemove}
								className="rounded-sm focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-ring disabled:opacity-50"
							>
								<XIcon className="size-3" aria-hidden="true" />
							</button>
						</Badge>
					</li>
				))}
				{excluded.map((item) => {
					const reasonId = `${id}-reason-${item.path}`;
					const reason = item.disabledReason
						? translateSelectionMessage(t, item.disabledReason)
						: null;
					return (
						<li key={`out:${item.path}`}>
							<Badge variant="info" className="gap-1 text-xs">
								{t("configureDialog.selectedPaths.except", {
									path: display(item),
								})}
								<button
									type="button"
									aria-label={t(
										"configureDialog.selectedPaths.includeAgain",
										{ path: display(item) },
									)}
									aria-describedby={
										reason ? reasonId : undefined
									}
									disabled={
										disabled || item.onReinclude === null
									}
									onClick={item.onReinclude ?? undefined}
									className="rounded-sm focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-ring disabled:opacity-50"
								>
									<XIcon
										className="size-3"
										aria-hidden="true"
									/>
								</button>
							</Badge>
							{reason ? (
								<span id={reasonId} className="sr-only">
									{reason}
								</span>
							) : null}
						</li>
					);
				})}
			</ul>
		</div>
	);
}
