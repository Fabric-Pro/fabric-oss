"use client";

import { useFeatureFlag } from "@saas/shared/components/FeatureFlagProvider";
import { Badge } from "@ui/components/badge";

/**
 * Says that Publishing Suite is still work in progress (Fizzy #2348, FR5).
 *
 * Renders nothing once `PUBLISHING_SUITE_BETA_LABEL` is turned off, which is
 * how the marker retires at general availability — an admin-console change,
 * not a release. It answers only "should we say this is unfinished"; whether
 * the feature is reachable at all is `PUBLISHING_SUITE`, resolved per
 * organization, and this component deliberately never consults it: it renders
 * inside surfaces that already exist only when the feature does.
 *
 * Amber rather than the primary rose: the design system reserves `--highlight`
 * for warnings and emphasis, and the primary colour is what active states and
 * calls to action use — a "Beta" chip in it would read as something to click.
 */
export function PublishingBetaBadge() {
	const showBetaLabel = useFeatureFlag("PUBLISHING_SUITE_BETA_LABEL");

	if (!showBetaLabel) {
		return null;
	}

	return (
		<Badge
			variant="warning"
			// The visible text is the whole message, so it needs no separate
			// label — but it sits beside a heading, and without the title a
			// screen-reader user hears a bare "Beta" with nothing tying it to
			// what is unfinished.
			title="Publishing Suite is a work in progress"
		>
			Beta
		</Badge>
	);
}
