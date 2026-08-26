"use client";

import {
	CONSENT_DECISION_FIELD,
	CONSENT_FORM_ACTION,
	CONSENT_RETURN_TO_FIELD,
	type ConsentDecision,
} from "@shared/lib/consent";
import { Button } from "@ui/components/button";

// Typed so the values the form posts cannot drift from the decisions
// `/api/consent` knows how to record.
const ALLOW_ANALYTICS: ConsentDecision = "analytics";
const DECLINE: ConsentDecision = "decline";

/**
 * Pre-consent analytics prompt.
 *
 * Rendered on EVERY non-embed surface, including the authenticated `/app`
 * shell. That is deliberate: the PostHog provider tags product-surface page
 * views (`surface: "product"`), so analytics runs in-app too and consent must
 * be obtainable there — gating the prompt to marketing pages would leave
 * signed-in visitors permanently un-asked, and therefore permanently untracked
 * once the default flipped to denied.
 *
 * The two buttons are a real form submit to `/api/consent`, not bare `onClick`
 * handlers. When the page is hydrated the click handler cancels the submit and
 * the decision is applied in place; when the client bundle never runs — a
 * blocked script, an extension interfering with React's event delegation, a
 * crashed provider — the browser posts the form and the server records the
 * decision. Without that fallback an unhydrated banner is undismissable while
 * still looking alive, because its hover, focus and active styles are pure CSS.
 *
 * Styling follows the marketing reference: warm card surface, editorial
 * uppercase label with the thin accent bar, and the shared `editorial` /
 * `editorial-ghost` button variants rather than bespoke inline classes.
 */
export function ConsentBanner({
	onAllowAnalytics,
	onDecline,
	returnTo,
}: {
	onAllowAnalytics: () => void;
	onDecline: () => void;
	returnTo?: string;
}) {
	const handle = (apply: () => void) => (event: React.MouseEvent) => {
		// Reaching this handler proves the page is hydrated, so keep the
		// in-place update and suppress the native full-page form navigation.
		event.preventDefault();
		apply();
	};

	return (
		<aside
			aria-label="Analytics preferences"
			aria-live="polite"
			className="motion-safe:fade-in motion-safe:slide-in-from-bottom-2 fixed inset-x-3 bottom-3 z-[100] mx-auto max-w-3xl border border-border bg-card p-5 text-foreground shadow-lg motion-safe:animate-in motion-safe:duration-300"
		>
			<p className="app-editorial-label">Your privacy</p>

			<p className="mt-3 text-sm leading-6 text-muted-foreground">
				TechFabric uses privacy-conscious product analytics to learn
				which Fabric pages and documentation are useful. We do not
				record session replays or turn anonymous visits into sales
				leads.
			</p>

			<form
				action={CONSENT_FORM_ACTION}
				method="post"
				aria-label="Analytics consent options"
				className="mt-5 flex flex-wrap gap-3"
			>
				<input
					type="hidden"
					name={CONSENT_RETURN_TO_FIELD}
					value={returnTo ?? ""}
				/>
				<Button
					type="submit"
					name={CONSENT_DECISION_FIELD}
					value={ALLOW_ANALYTICS}
					variant="editorial"
					className="min-h-11"
					onClick={handle(onAllowAnalytics)}
				>
					Allow analytics
				</Button>
				<Button
					type="submit"
					name={CONSENT_DECISION_FIELD}
					value={DECLINE}
					variant="editorial-ghost"
					className="min-h-11"
					onClick={handle(onDecline)}
				>
					Decline
				</Button>
			</form>
		</aside>
	);
}
