"use client";

/**
 * "Recommend Features from Context" in the Roadmap's actions menu
 * (Fizzy #2204 FR10, FR46; #2208 FR55–FR59).
 *
 * Present whenever a starter exists (flag on, AI provider available). A
 * viewer without PROJECT_UPDATE sees it disabled with the permission reason,
 * not hidden (FR46). Disabled, with the reason as text, while the recommend
 * gate blocks — a soft block shows the gate's own body (FR37) and its remedy —
 * or while a run is already in flight. A thin-context WARNING is shown under
 * the description and never blocks.
 */

import { useAnalytics } from "@analytics";
import { SparklesIcon } from "lucide-react";
import { useTranslations } from "next-intl";
import { toast } from "sonner";
import {
	useCapabilityGate,
	useCapabilityGates,
} from "../../capability-gates/useCapabilityGates";
import type { RoadmapRecommendationStarter } from "../roadmap-entry/recommendation-starter";
import type { RoadmapActionItem } from "../roadmap-entry/roadmap-action-items";
import { startErrorToast } from "./useRecommendationRun";

interface RecommendActionItemArgs {
	starter: RoadmapRecommendationStarter | null;
	/** `project.canUpdateProject`; undefined while it loads (hidden). */
	canUpdateProject: boolean | undefined;
}

export function useRecommendActionItem({
	starter,
	canUpdateProject,
}: RecommendActionItemArgs): RoadmapActionItem | null {
	const t = useTranslations("projects.recommendations");
	const tReason = useTranslations("projects.stories.startBuilding.reason");
	const tGates = useTranslations("projects.capabilityGates");
	const gate = useCapabilityGate("roadmap.recommend-features");
	const { linkFor } = useCapabilityGates();
	const { trackEvent } = useAnalytics();

	if (!starter || canUpdateProject === undefined) {
		return null;
	}

	const view = gate.view;

	let disabledReason: string | null = null;
	let disabledDetail: string | null = null;
	let remedy: RoadmapActionItem["remedy"] = null;
	if (canUpdateProject === false) {
		disabledReason = tReason("permission");
	} else if (gate.blocked && view) {
		disabledReason = tGates(view.title);
		disabledDetail = tGates(view.body, view.params);
		const link =
			view.ctaKind === "navigate" && view.ctaTarget
				? linkFor(view.ctaTarget)
				: null;
		if (link && view.ctaLabel) {
			remedy = { label: tGates(view.ctaLabel), ...link };
		}
	} else if (starter.isStarting || starter.isRunning) {
		disabledReason = t("running");
	}

	const warning =
		!gate.blocked && view?.state === "WARNING"
			? tGates(view.body, view.params)
			: null;

	return {
		id: "recommend-features",
		label: t("menuItem"),
		icon: SparklesIcon,
		description: t("menuDescription"),
		disabledReason,
		disabledDetail,
		warning,
		remedy,
		onSelect: () => {
			trackEvent("roadmap_entry_point_selected", {
				entryPoint: "recommend",
				placement: "menu",
			});
			starter
				.start({ entryPoint: "MATURE_ROADMAP" })
				.catch((error: unknown) => {
					const { title, description } = startErrorToast(
						error,
						t("startFailed"),
						t("generationFailed"),
					);
					toast.error(title, { description });
				});
		},
	};
}
