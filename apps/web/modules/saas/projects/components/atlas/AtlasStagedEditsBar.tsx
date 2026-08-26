"use client";

/**
 * Floating Save / Reset bar shown over an Atlas canvas while structural edits are
 * staged (see `useStagedGraphEdits`). Appears only when there are pending
 * changes; surfaces the change count and the primary Save + Reset (discard)
 * actions. Used by BOTH the solo graph and the System map.
 *
 * Tokenised surface (warm card, no glassmorphism), motion-safe entrance, and an
 * accessible status role so assistive tech announces that there are unsaved
 * changes to save.
 */
import { Button } from "@ui/components/button";
import { Loader2Icon, SaveIcon, XIcon } from "lucide-react";
import { useTranslations } from "next-intl";

interface AtlasStagedEditsBarProps {
	/** Number of staged changes (positions + creates + deletes). */
	count: number;
	/** Persist all staged changes. */
	onSave: () => void;
	/** Discard all staged changes (revert to the saved state). */
	onDiscard: () => void;
	/** True while the save is in flight (disables both buttons + shows a spinner). */
	isSaving: boolean;
}

export function AtlasStagedEditsBar({
	count,
	onSave,
	onDiscard,
	isSaving,
}: AtlasStagedEditsBarProps) {
	const t = useTranslations("projects.atlas.staged");
	return (
		<div className="pointer-events-none absolute inset-x-0 top-3 z-40 flex justify-center px-4">
			<div className="motion-safe:animate-in motion-safe:fade-in motion-safe:slide-in-from-top-2 pointer-events-auto flex items-center gap-3 rounded-xl border border-primary/40 bg-card px-4 py-2.5 shadow-lg ring-1 ring-primary/10">
				{/* aria-live (no explicit role) announces the changing count to AT. */}
				<output
					aria-live="polite"
					className="text-sm font-medium text-foreground tabular-nums"
				>
					{t("unsavedCount", { count })}
				</output>
				<div className="flex items-center gap-1.5">
					<Button
						type="button"
						variant="ghost"
						size="sm"
						onClick={onDiscard}
						disabled={isSaving}
						className="gap-1.5 text-muted-foreground"
					>
						<XIcon aria-hidden="true" className="size-3.5" />
						{t("discard")}
					</Button>
					<Button
						type="button"
						size="sm"
						onClick={onSave}
						disabled={isSaving}
						className="gap-1.5"
					>
						{isSaving ? (
							<Loader2Icon
								aria-hidden="true"
								className="size-3.5 motion-safe:animate-spin"
							/>
						) : (
							<SaveIcon aria-hidden="true" className="size-3.5" />
						)}
						{t("save")}
					</Button>
				</div>
			</div>
		</div>
	);
}
