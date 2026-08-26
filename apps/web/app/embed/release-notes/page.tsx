import { getEmbedReleaseNotes } from "@marketing/release-notes/lib/embed-release-notes";
import { ReleaseNotesListPublic } from "@marketing/release-notes/components/ReleaseNotesListPublic";
import { resolveReleaseWidgetParams } from "@marketing/shared/lib/embed-params";
import { NewsletterForm } from "@marketing/shared/components/NewsletterForm";
import { logger } from "@repo/logs";
import { cn } from "@ui/lib";
import type { Metadata } from "next";
import { NextIntlClientProvider } from "next-intl";
import { getLocale, getMessages, getTranslations } from "next-intl/server";
import { notFound } from "next/navigation";
import type { CSSProperties } from "react";

// Public per-project iframe fragment — keep it out of the index. CSP
// (`frame-ancestors *` + the `x-embed-route` privacy boundary) is applied to all
// of `/embed/*` by the proxy, so it is NOT re-implemented here.
export const metadata: Metadata = {
	title: "Release notes",
	robots: { index: false, follow: false },
};

// serif → the editorial serif family; everything else (system/inter) → the sans
// stack. `font` is allowlisted by resolveReleaseWidgetParams, so this is a fixed
// class, never attacker-controlled CSS.
function fontClass(font: "system" | "inter" | "serif"): string {
	return font === "serif" ? "font-serif" : "font-sans";
}

export default async function ReleaseNotesEmbedPage({
	searchParams,
}: {
	searchParams: Promise<Record<string, string | string[] | undefined>>;
}) {
	const sp = await searchParams;
	const raw = sp.t;
	const token =
		typeof raw === "string" ? raw : Array.isArray(raw) ? raw[0] : undefined;
	// The opaque token IS the tenant bind; without it there is nothing to resolve.
	if (!token) {
		notFound();
	}

	// Resolve SERVER-SIDE only. getEmbedReleaseNotes returns null for an unknown
	// token, but its underlying resolve can THROW on a hard DB blip — that must
	// 404 the iframe, not bubble a 500/stack into a third-party page. Keep the
	// catch tight around the resolve and call notFound() AFTER, so TS sees `data`
	// as definitely assigned (notFound() throws, so the catch path never returns).
	let data: Awaited<ReturnType<typeof getEmbedReleaseNotes>>;
	try {
		data = await getEmbedReleaseNotes(token);
	} catch (error) {
		// Keep the external 404 (anti-oracle) but record the failure so a token-resolve/DB
		// outage isn't invisible. Never log the raw bearer token.
		logger.error("embed release-notes token resolve failed", error);
		notFound();
	}
	// Unknown token (null) or a disabled widget → 404. An ENABLED widget with zero
	// sends is a VALID empty state (the feed renders its emptyLabel).
	if (!data || !data.enabled) {
		notFound();
	}

	// Every value here is already validated/clamped (accent is hex-or-null, radius
	// is a clamped int, width is "100%" or a clamped int string, theme/font/density
	// are allowlisted), so feeding them into inline styles/classes is injection-safe.
	// Theme comes from the URL params baked into the snippet by the owner's settings
	// (Task 11), NOT from the stored data.theme/accent/config — the snippet URL is the
	// source of truth, so changing settings requires re-copying the snippet.
	const params = resolveReleaseWidgetParams(sp);
	const [messages, locale, t] = await Promise.all([
		getMessages(),
		getLocale(),
		getTranslations(),
	]);

	// accent maps to the design-system --primary token (CTA/link/active color);
	// radius maps to --radius. Both scoped to the iframe subtree via the wrapper.
	const style: CSSProperties = {
		...(params.accent ? { ["--primary" as string]: params.accent } : {}),
		["--radius" as string]: `${params.radius}px`,
	};
	// width: "100%" passes through; a numeric string gets the px suffix.
	const maxWidth = params.width === "100%" ? "100%" : `${params.width}px`;

	// `dark` on the wrapper scopes the dark CSS variables to the iframe subtree,
	// independent of any html-level theme class. No `min-h-screen`: content height
	// is intrinsic, and the host iframe is fixed-height (560) per the generated
	// snippet, so overflow scrolls internally — a postMessage auto-resize is a
	// deferred follow-up. `min-h-screen` would force a 560px-tall near-blank box for
	// the empty state.
	return (
		<NextIntlClientProvider locale={locale} messages={messages}>
			<div
				style={style}
				className={cn(
					"bg-background p-4 text-foreground",
					fontClass(params.font),
					params.theme === "dark" && "dark",
					params.density === "compact" && "text-sm",
				)}
			>
				<div className="mx-auto" style={{ maxWidth }}>
					<ReleaseNotesListPublic
						sends={data.sends}
						locale={locale}
						emptyLabel={t("releaseNotes.empty")}
						fallbackHeadline={t("releaseNotes.fallbackHeadline")}
					/>
					<div className="mt-6">
						<NewsletterForm token={token} />
					</div>
				</div>
			</div>
		</NextIntlClientProvider>
	);
}
