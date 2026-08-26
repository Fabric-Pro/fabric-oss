"use client";

import { Button } from "@ui/components/button";
import { Checkbox } from "@ui/components/checkbox";
import {
	Dialog,
	DialogContent,
	DialogDescription,
	DialogFooter,
	DialogHeader,
	DialogTitle,
} from "@ui/components/dialog";
import { useTranslations } from "next-intl";
import { useEffect, useState } from "react";

export type SummarySources = {
	context: boolean;
	decisions: boolean;
	roadmap: boolean;
	codeRepo: boolean;
};

type SourceKey = keyof SummarySources;

type Props = {
	open: boolean;
	onOpenChange: (open: boolean) => void;
	/** Whether the code-repo source is available (feature-flagged). */
	codeRepoEnabled: boolean;
	pending?: boolean;
	onConfirm: (sources: SummarySources) => void;
};

/**
 * Fronts the (re-)summarize action with a source picker: choose which source types
 * the run considers. All are on by default (code-repo only when its flag is on) and
 * at least one must stay selected. The chosen set is remembered per history entry.
 */
export function SummarySourceSelectionDialog({
	open,
	onOpenChange,
	codeRepoEnabled,
	pending,
	onConfirm,
}: Props) {
	const t = useTranslations("projects.contextSummary.sources");
	const defaults = (): SummarySources => ({
		context: true,
		decisions: true,
		roadmap: true,
		codeRepo: codeRepoEnabled,
	});
	const [sources, setSources] = useState<SummarySources>(defaults);

	// Reset to defaults whenever the dialog opens, so a prior half-selection never
	// carries over into a new run.
	useEffect(() => {
		if (open) {
			setSources(defaults());
		}
		// eslint-disable-next-line react-hooks/exhaustive-deps
	}, [open, codeRepoEnabled]);

	// The visible sources — code-repo is hidden entirely when its flag is off.
	const items: { key: SourceKey; shown: boolean }[] = [
		{ key: "context", shown: true },
		{ key: "decisions", shown: true },
		{ key: "roadmap", shown: true },
		{ key: "codeRepo", shown: codeRepoEnabled },
	];
	const noneSelected =
		!sources.context &&
		!sources.decisions &&
		!sources.roadmap &&
		!(sources.codeRepo && codeRepoEnabled);

	return (
		<Dialog open={open} onOpenChange={onOpenChange}>
			<DialogContent className="sm:max-w-md">
				<DialogHeader>
					<DialogTitle>{t("title")}</DialogTitle>
					<DialogDescription>{t("description")}</DialogDescription>
				</DialogHeader>

				<fieldset className="space-y-3">
					<legend className="sr-only">{t("title")}</legend>
					{items
						.filter((i) => i.shown)
						.map(({ key }) => (
							<label
								key={key}
								className="flex cursor-pointer items-start gap-3 rounded-lg border border-border bg-muted/30 p-3 motion-safe:transition-colors hover:bg-muted/60 has-[:focus-visible]:ring-1 has-[:focus-visible]:ring-ring"
							>
								<Checkbox
									checked={sources[key]}
									onCheckedChange={(checked) =>
										setSources((prev) => ({
											...prev,
											[key]: checked === true,
										}))
									}
									className="mt-0.5"
								/>
								<span className="min-w-0">
									<span className="block font-medium text-foreground text-sm">
										{t(`items.${key}.label`)}
									</span>
									<span className="block text-muted-foreground text-xs">
										{t(`items.${key}.description`)}
									</span>
								</span>
							</label>
						))}
				</fieldset>

				{noneSelected && (
					<p className="text-destructive text-xs" role="alert">
						{t("atLeastOne")}
					</p>
				)}

				<DialogFooter>
					<Button
						type="button"
						variant="outline"
						onClick={() => onOpenChange(false)}
					>
						{t("cancel")}
					</Button>
					<Button
						type="button"
						disabled={noneSelected || pending}
						onClick={() =>
							onConfirm({
								...sources,
								codeRepo: sources.codeRepo && codeRepoEnabled,
							})
						}
					>
						{t("start")}
					</Button>
				</DialogFooter>
			</DialogContent>
		</Dialog>
	);
}
