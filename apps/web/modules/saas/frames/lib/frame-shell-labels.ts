import type { FrameSurfaceName } from "./frame-tool-types";

const SURFACE_LABELS: Record<FrameSurfaceName, string> = {
	artifact: "Artifact",
	workspace: "Workspace",
};

/**
 * What a frame shell calls the page it shows: the label above its title, whether
 * the plain "Frame"/"Slideshow" badge is needed beside it, and how its loading
 * line reads. A page on a surface is named by the surface; any other is named
 * by what it is, or by being shared.
 */
export function frameShellLabels({
	surface,
	headerMode,
}: {
	surface?: FrameSurfaceName;
	headerMode: "authenticated" | "public";
}): { eyebrow: string; showKindBadge: boolean; loading: string } {
	if (surface) {
		const label = SURFACE_LABELS[surface];
		return {
			eyebrow: label,
			showKindBadge: false,
			loading: `Loading ${label.toLowerCase()}…`,
		};
	}
	return {
		eyebrow:
			headerMode === "public" ? "Shared Frame" : "Interactive content",
		showKindBadge: true,
		loading: "Loading interactive frame…",
	};
}
