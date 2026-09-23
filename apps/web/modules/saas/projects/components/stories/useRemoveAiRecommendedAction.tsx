"use client";

/**
 * 3C's entry in the Roadmap's "More Roadmap actions" menu (Fizzy #2211):
 * "Remove AI Recommended Items" and the dialog it opens.
 *
 * The item exists only for someone who can update stories, with the
 * lifecycle flag on, and while the capability engine has not HIDDEN it — the
 * engine hides it when no batch has an eligible item left. An absent gate
 * (gating off, still loading) is not hidden: the item shows and the removal
 * door refuses an empty batch on its own.
 *
 * At top level this uses only local state and the capability gate — no query
 * and no session — so the Roadmap's suites need no new mocks.
 */

import { TrashIcon } from "lucide-react";
import { useTranslations } from "next-intl";
import { type ReactNode, useMemo, useState } from "react";
import { useCapabilityGate } from "../capability-gates/useCapabilityGates";
import { RemoveAiBatchDialog } from "./RemoveAiBatchDialog";
import type { RoadmapBlock } from "./roadmap-entry/entry-point-states";
import type { RoadmapActionItem } from "./roadmap-entry/roadmap-action-items";

export function useRemoveAiRecommendedAction({
	projectId,
	roadmap,
}: {
	projectId: string;
	roadmap: RoadmapBlock | undefined;
}): { item: RoadmapActionItem | null; overlay: ReactNode } {
	const t = useTranslations("projects.stories.aiRecommended.removeDialog");
	const { hidden } = useCapabilityGate("roadmap.remove-ai-recommended");
	const [open, setOpen] = useState(false);

	const available =
		roadmap?.aiRecommendedLifecycleEnabled === true &&
		roadmap.canUpdateStories &&
		!hidden;
	const label = t("menuItem");

	const item = useMemo<RoadmapActionItem | null>(
		() =>
			available
				? {
						id: "remove-ai-recommended",
						label,
						icon: TrashIcon,
						onSelect: () => setOpen(true),
						disabledReason: null,
					}
				: null,
		[available, label],
	);

	// Keyed on `open` alone: a finished removal can turn the gate HIDDEN while
	// its result is still on screen.
	return {
		item,
		overlay: open ? (
			<RemoveAiBatchDialog
				projectId={projectId}
				onClose={() => setOpen(false)}
			/>
		) : null,
	};
}
