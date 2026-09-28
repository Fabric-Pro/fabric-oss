"use client";

import { resolveBrandColor } from "@repo/utils/brand-colors";
import {
	createContext,
	type PropsWithChildren,
	useEffect,
	useRef,
} from "react";

// The brand palette and its contrast helpers live in `@repo/utils/brand-colors`
// so the Glossy renderer uses the same values. `readableForegroundFor` stays
// re-exported here for the existing palette contrast test and callers.
export { readableForegroundFor } from "@repo/utils/brand-colors";

interface OrganizationThemeContextValue {
	brandColor: string | null;
}

const OrganizationThemeContext = createContext<OrganizationThemeContextValue>({
	brandColor: null,
});

interface OrganizationThemeProviderProps extends PropsWithChildren {
	brandColor?: string | null;
}

export function OrganizationThemeProvider({
	children,
	brandColor,
}: OrganizationThemeProviderProps) {
	// Store original values to restore on cleanup
	const originalPrimary = useRef<string | null>(null);
	const originalPrimaryForeground = useRef<string | null>(null);
	const originalRing = useRef<string | null>(null);

	useEffect(() => {
		const root = document.documentElement;
		// Defaults to the crimson red (matches brand) for a missing or unknown name.
		const colorValues = resolveBrandColor(brandColor);

		// Store original values on first run
		if (originalPrimary.current === null) {
			originalPrimary.current = getComputedStyle(root)
				.getPropertyValue("--primary")
				.trim();
			originalPrimaryForeground.current = getComputedStyle(root)
				.getPropertyValue("--primary-foreground")
				.trim();
			originalRing.current = getComputedStyle(root)
				.getPropertyValue("--ring")
				.trim();
		}

		/*
		 * The design system keeps the primary control neutral (off-white on
		 * black); an organisation's brand colour is the thread, not the
		 * button. It tints the accent variables, the active bar, the ink and
		 * the focus ring, and leaves --primary alone.
		 */
		root.style.setProperty("--ring", colorValues.hex);
		root.style.setProperty("--fab-accent-fill", colorValues.hex);
		root.style.setProperty("--fab-accent", colorValues.inkDark);
		// Ink tracks the brand too. CSS picks between these by theme, so a
		// light/dark toggle needs no re-render here.
		root.style.setProperty("--primary-ink-light", colorValues.ink);
		root.style.setProperty("--primary-ink-dark", colorValues.inkDark);

		// Set the organization accent color as CSS variables
		root.style.setProperty("--org-accent-h", colorValues.hue);
		root.style.setProperty("--org-accent-s", colorValues.saturation);
		root.style.setProperty("--org-accent-l", colorValues.lightness);
		root.style.setProperty(
			"--org-accent",
			`hsl(${colorValues.hue} ${colorValues.saturation} ${colorValues.lightness})`,
		);
		// Lighter variant for backgrounds
		root.style.setProperty(
			"--org-accent-light",
			`hsl(${colorValues.hue} ${colorValues.saturation} 95%)`,
		);
		// Darker variant for hover states
		root.style.setProperty(
			"--org-accent-dark",
			`hsl(${colorValues.hue} ${colorValues.saturation} 35%)`,
		);

		return () => {
			// Cleanup - restore original values
			if (originalPrimary.current) {
				root.style.setProperty("--primary", originalPrimary.current);
			}
			if (originalPrimaryForeground.current) {
				root.style.setProperty(
					"--primary-foreground",
					originalPrimaryForeground.current,
				);
			}
			// Ink has no pre-existing inline value to restore — it is only ever
			// set here — so remove it and let theme.css supply the fallback.
			root.style.removeProperty("--primary-ink-light");
			root.style.removeProperty("--primary-ink-dark");
			root.style.removeProperty("--fab-accent-fill");
			root.style.removeProperty("--fab-accent");
			if (originalRing.current) {
				root.style.setProperty("--ring", originalRing.current);
			}
			// Reset org-accent variables
			root.style.removeProperty("--org-accent-h");
			root.style.removeProperty("--org-accent-s");
			root.style.removeProperty("--org-accent-l");
			root.style.removeProperty("--org-accent");
			root.style.removeProperty("--org-accent-light");
			root.style.removeProperty("--org-accent-dark");
		};
	}, [brandColor]);

	return (
		<OrganizationThemeContext.Provider
			value={{ brandColor: brandColor || null }}
		>
			{children}
		</OrganizationThemeContext.Provider>
	);
}
