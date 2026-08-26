"use client";

import type { MaturationViewMode } from "@saas/projects/hooks/useMaturationViewMode";
import { Button } from "@ui/components/button";
import {
	Tooltip,
	TooltipContent,
	TooltipProvider,
	TooltipTrigger,
} from "@ui/components/tooltip";
import { useTranslations } from "next-intl";

type Props = {
	viewMode: MaturationViewMode;
	onChange: (mode: MaturationViewMode) => void;
};

/**
 * Session v1/v2 toggle for the feature editor. Lives in the
 * SHARED page header (gated on the org flag) so it is reachable in BOTH modes —
 * a PO who flipped to v1 for a demo can flip back within the same session.
 *
 * Two `aria-pressed` toggle buttons rather than a switch: the labels ("Classic"
 * / "Maturation") are clearer than an unlabeled on/off, and each carries its
 * own `aria-label` + tooltip for the icon-tight action bar.
 */
export function MaturationViewToggle({ viewMode, onChange }: Props) {
	const t = useTranslations("projects.stories.maturation.viewToggle");
	const tTip = useTranslations("tooltips.maturation");

	return (
		<TooltipProvider>
			{/* biome-ignore lint/a11y/useSemanticElements: a <fieldset> is the semantic group element but is intended for form controls with a legend; an inline editor-version button group is better expressed as role="group" + aria-label, matching the repo's other toggle groups (RoadmapSettingsMenu, carousel). */}
			<div
				className="inline-flex items-center rounded-md border bg-muted/40 p-0.5"
				role="group"
				aria-label={t("label")}
			>
				<Tooltip>
					<TooltipTrigger asChild>
						<Button
							type="button"
							variant={viewMode === "v1" ? "secondary" : "ghost"}
							size="sm"
							className="h-7 px-2.5 text-xs"
							aria-pressed={viewMode === "v1"}
							aria-label={t("switchToV1")}
							onClick={() => onChange("v1")}
						>
							{t("v1")}
						</Button>
					</TooltipTrigger>
					<TooltipContent>
						{tTip("switchToClassicEditor")}
					</TooltipContent>
				</Tooltip>
				<Tooltip>
					<TooltipTrigger asChild>
						<Button
							type="button"
							variant={viewMode === "v2" ? "secondary" : "ghost"}
							size="sm"
							className="h-7 px-2.5 text-xs"
							aria-pressed={viewMode === "v2"}
							aria-label={t("switchToV2")}
							onClick={() => onChange("v2")}
						>
							{t("v2")}
						</Button>
					</TooltipTrigger>
					<TooltipContent>
						{tTip("switchToMaturationEditor")}
					</TooltipContent>
				</Tooltip>
			</div>
		</TooltipProvider>
	);
}
