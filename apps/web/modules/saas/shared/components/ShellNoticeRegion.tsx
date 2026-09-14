"use client";

import {
	MfaSetupBanner,
	useMfaNoticeVisible,
} from "@saas/shared/components/MfaSetupBanner";
import { isFullBleedRoute } from "@saas/shared/lib/shell-layout";
import { usePathname } from "next/navigation";
import { useTranslations } from "next-intl";
import { Fragment, type ReactNode } from "react";

/**
 * The app shell's notice stack.
 *
 * Before this existed, every global notice picked its own CSS position and
 * z-index at its own mount point, so nothing ordered them, nothing spaced them,
 * and two of them could land in the same rectangle. This region owns placement
 * for all of them instead.
 *
 * It sits in normal flow and carries NO z-index. An in-flow sibling cannot
 * cover it, so there is nothing to out-rank; where the page paints its own
 * viewport-fixed chrome the region yields instead of competing (see
 * `isFullBleedRoute`). Staying out of the viewport's top corner also keeps it
 * clear of the guided tour's cards and of the Sonner toaster, which renders at
 * a z-index no banner could win against.
 *
 * Tier order (Fizzy #2489):
 *   1. system messages that precede a forced action — the Backstop banner,
 *      which keeps its own `sticky` mount ABOVE this region so it cannot
 *      scroll out of view before a forced reload;
 *   2. security;
 *   3. product setup and onboarding — registered, no member yet.
 */

export interface ShellNotice {
	id: string;
	node: ReactNode;
}

/**
 * The presentational half: one labelled landmark, one gap, nothing at all when
 * there is nothing to show.
 *
 * Split out from the region so the tier ordering stays testable while the
 * region has a single real member — and so the empty case is a property of this
 * component rather than an accident of how its children happen to render.
 *
 * Spacing lives here, never threaded into a member's `className`: members
 * compose primitives whose own `cva` already owns padding, and passing `p-*`
 * through such a primitive shrinks its padding instead of adding a gap. That
 * trap is recorded in
 * `docs/solutions/design-patterns/moving-a-floating-element-into-normal-flow.md`.
 */
export function ShellNoticeStack({ notices }: { notices: ShellNotice[] }) {
	const t = useTranslations();

	if (notices.length === 0) {
		return null;
	}

	return (
		<aside
			aria-label={t("app.shellNotices.ariaLabel")}
			// `shrink-0` because the full-height routes put this column in a
			// `h-full overflow-hidden` flex container, where a shrinkable child
			// is compressed instead of reserving its height.
			className="flex shrink-0 flex-col gap-3 pt-4 pb-2"
		>
			{notices.map((notice) => (
				<Fragment key={notice.id}>{notice.node}</Fragment>
			))}
		</aside>
	);
}

export function ShellNoticeRegion() {
	const pathname = usePathname();

	// These routes paint their own `fixed inset-y-0` chrome with no z-index of
	// its own, so an in-flow notice would render behind it AND reserve height
	// the fixed page ignores. The region yields instead.
	//
	// Accepted tradeoff, not an oversight: the security nudge WAS visible here
	// before, as a z-50 overlay covering the editor. Giving that up costs
	// reach for a user who enters on one of these routes and never leaves it.
	// It is acceptable because the nudge is snoozable, server-backed and
	// reinstated, it returns on any navigation away, and the hard 2FA gate
	// (`shouldEnforceOrgTwoFactor`) is a separate mechanism this does not
	// touch. Revisit by giving these pages their own in-flow mount, not by
	// restoring an overlay.
	//
	// Gating here rather than inside also means such a route does not mount
	// the members' queries at all.
	if (isFullBleedRoute(pathname)) {
		return null;
	}

	return <ShellNoticeRegionMembers />;
}

function ShellNoticeRegionMembers() {
	// Asked before rendering — see `useMfaNoticeVisible` for why.
	const securityNoticeVisible = useMfaNoticeVisible();

	const notices: ShellNotice[] = [];

	if (securityNoticeVisible) {
		notices.push({ id: "security", node: <MfaSetupBanner /> });
	}

	return <ShellNoticeStack notices={notices} />;
}
