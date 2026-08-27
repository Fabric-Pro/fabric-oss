"use client";

/**
 * The route into chat-channel setup, for the cards that can only SELECT
 * channels.
 *
 * Three project-settings cards let a project tick which already-linked
 * Teams/Slack channels receive something — release notes, review alerts,
 * topic suggestions — and none of them can link a channel. Linking lives in
 * Settings → Knowledge, on the Teams/Slack monitor cards.
 *
 * Each card used to carry its own copy of a button, rendered ONLY in its
 * empty-state branch. That is the branch a project with channels never
 * renders, so the moment a project linked its first channel it lost every
 * route to a second — the state most projects are in, and the one that was
 * reported.
 */

import { Button } from "@ui/components/button";
import { PlusIcon } from "lucide-react";

/**
 * Scroll anchor for {@link scrollToChatMonitors}.
 *
 * Deliberately NOT the `data-onboarding-target="settings-chat-monitors"` that
 * sits on the same element. That attribute belongs to the Get Started registry
 * and is drift-tested against it; borrowing it would give one attribute two
 * owners, and a rename would stay green on the side that has a test while
 * breaking this navigation, which does not. Two attributes on one element is
 * the cheaper duplication.
 */
export const CHAT_MONITORS_SECTION_ID = "project-settings-chat-monitors";

function prefersReducedMotion(): boolean {
	return (
		window.matchMedia?.("(prefers-reduced-motion: reduce)")?.matches ===
		true
	);
}

/**
 * Bring the Teams/Slack monitor cards into view.
 *
 * Must run AFTER the Knowledge tab has rendered — the anchor does not exist
 * until that tab is mounted, so calling this in the same handler that switches
 * the tab silently does nothing.
 */
export function scrollToChatMonitors(): void {
	document.getElementById(CHAT_MONITORS_SECTION_ID)?.scrollIntoView({
		block: "start",
		behavior: prefersReducedMotion() ? "auto" : "smooth",
	});
}

/**
 * Renders nothing without `onNavigate`. The prop is optional because not every
 * host can switch settings tabs, and a button that navigates nowhere is worse
 * than no button — it reads as a broken feature rather than an absent one.
 */
export function ConnectChatChannelButton({
	onNavigate,
	className,
}: {
	onNavigate?: () => void;
	className?: string;
}) {
	if (!onNavigate) {
		return null;
	}

	return (
		<Button
			variant="outline"
			size="sm"
			className={className}
			onClick={onNavigate}
		>
			<PlusIcon className="size-4" aria-hidden="true" />
			Connect a channel
		</Button>
	);
}
