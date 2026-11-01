"use client";

import { findBrandColor } from "@repo/utils/brand-colors";
import { createContext, type PropsWithChildren, useEffect } from "react";

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
	useEffect(() => {
		const root = document.documentElement;
		const explicitBrand =
			brandColor && brandColor !== "red"
				? findBrandColor(brandColor)
				: null;
		// Defaults to Warm Bright Orange when no explicit non-red organization brand is set.
		const colorValues = explicitBrand ?? {
			hex: "#bc3e0b",
			hue: "17",
			saturation: "89%",
			lightness: "39%",
			ink: "#bc3e0b",
			inkDark: "#ff8547",
		};

		/*
		 * The Databricks DuBois design system uses Warm Bright Orange (#BC3E0B
		 * in light mode, #FF8547 in dark mode) for primary controls, focus
		 * rings, and links by default. When an organization configures an
		 * explicit brand colour, it tints the accent variables, focus ring,
		 * and link ink while leaving --primary on Warm Bright Orange. When no
		 * explicit brand is configured, remove inline overrides so :root and
		 * .dark in theme.css stay live across theme switches.
		 */
		if (explicitBrand) {
			root.style.setProperty("--ring", explicitBrand.hex);
			root.style.setProperty("--fab-accent-fill", explicitBrand.hex);
			root.style.setProperty("--fab-accent", explicitBrand.inkDark);
			// Ink tracks the explicit org brand too. CSS picks between these by
			// theme, so a light/dark toggle needs no re-render here.
			root.style.setProperty("--primary-ink-light", explicitBrand.ink);
			root.style.setProperty("--primary-ink-dark", explicitBrand.inkDark);
		} else {
			root.style.removeProperty("--primary-ink-light");
			root.style.removeProperty("--primary-ink-dark");
			root.style.removeProperty("--fab-accent-fill");
			root.style.removeProperty("--fab-accent");
			root.style.removeProperty("--ring");
		}

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
			// Cleanup - remove inline overrides so theme.css(:root / .dark) owns the tokens
			root.style.removeProperty("--primary-ink-light");
			root.style.removeProperty("--primary-ink-dark");
			root.style.removeProperty("--fab-accent-fill");
			root.style.removeProperty("--fab-accent");
			root.style.removeProperty("--ring");
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
