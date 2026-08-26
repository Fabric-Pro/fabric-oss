"use client";

import {
	createContext,
	type PropsWithChildren,
	useEffect,
	useRef,
} from "react";

/**
 * Pick the label colour for a filled brand control: whichever of near-white or
 * near-black actually clears WCAG 2.1 AA (4.5:1) on that fill.
 *
 * Computed rather than stored per brand so a brand added later cannot ship with an
 * illegible label. Seven of the eight brands here need the DARK ink — white on them
 * measures 3.30-4.47:1 — and only `red` takes the light one. Nothing in between
 * works: `#111110`, the ink `--secondary-foreground` uses, leaves `indigo` and
 * `purple` short of the floor, so the dark candidate is pure black.
 *
 * Enforced by `apps/web/__tests__/org-brand-palette-contrast.test.ts`.
 */
const LIGHT_INK = "#fff7f7";
const DARK_INK = "#000000";

function relativeLuminance(hex: string): number {
	const raw = hex.replace("#", "");
	const channel = (offset: number) => {
		const value = Number.parseInt(raw.slice(offset, offset + 2), 16) / 255;
		return value <= 0.03928
			? value / 12.92
			: ((value + 0.055) / 1.055) ** 2.4;
	};
	return 0.2126 * channel(0) + 0.7152 * channel(2) + 0.0722 * channel(4);
}

function contrastRatio(a: string, b: string): number {
	const [lighter, darker] = [relativeLuminance(a), relativeLuminance(b)].sort(
		(x, y) => y - x,
	);
	return ((lighter as number) + 0.05) / ((darker as number) + 0.05);
}

export function readableForegroundFor(fillHex: string): string {
	return contrastRatio(fillHex, DARK_INK) >= contrastRatio(fillHex, LIGHT_INK)
		? DARK_INK
		: LIGHT_INK;
}

// Brand color to hex and HSL values for CSS variables
// Each color includes: hex (for --primary) and hsl components. The label colour
// is DERIVED via `readableForegroundFor` rather than stored — it used to be a
// hardcoded "#ffffff" (and one "#fef3f2") on every entry, which failed AA on seven
// of the eight fills.
const brandColorValues: Record<
	string,
	{
		hex: string;
		hue: string;
		saturation: string;
		lightness: string;
		/** Brand colour as INK on a surface — links and small text. Solved per
		 * brand to clear WCAG 2.1 AA (>=4.5:1) against the worst-case surface in
		 * each theme; a single lightness does not work across hues (indigo fails
		 * where teal passes, and vice versa). */
		ink: string;
		inkDark: string;
	}
> = {
	teal: {
		hex: "#0d9488",
		hue: "173",
		saturation: "80%",
		lightness: "40%",
		ink: "#0e7c6f",
		inkDark: "#19e6ce",
	},
	blue: {
		hex: "#3b82f6",
		hue: "217",
		saturation: "91%",
		lightness: "60%",
		ink: "#0a5adb",
		inkDark: "#3780f6",
	},
	purple: {
		hex: "#8b5cf6",
		hue: "271",
		saturation: "81%",
		lightness: "56%",
		ink: "#7616d0",
		inkDark: "#ab62ef",
	},
	pink: {
		hex: "#ec4899",
		hue: "330",
		saturation: "81%",
		lightness: "60%",
		ink: "#d01673",
		inkDark: "#eb3d94",
	},
	orange: {
		hex: "#ea580c",
		hue: "25",
		saturation: "95%",
		lightness: "53%",
		ink: "#b84f05",
		inkDark: "#f96b06",
	},
	green: {
		hex: "#16a34a",
		hue: "142",
		saturation: "71%",
		lightness: "45%",
		ink: "#157e3c",
		inkDark: "#25da67",
	},
	red: {
		hex: "#dc2626",
		hue: "0",
		saturation: "84%",
		lightness: "60%",
		ink: "#d31212",
		inkDark: "#ef4848",
	},
	indigo: {
		hex: "#6366f1",
		hue: "239",
		saturation: "84%",
		lightness: "67%",
		ink: "#1216d3",
		inkDark: "#7779f3",
	},
};

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
		const colorKey = brandColor || "red"; // Default to crimson red (matches brand)
		const colorValues = brandColorValues[colorKey] || brandColorValues.red;

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

		// Override the primary color (affects buttons and primary UI elements)
		root.style.setProperty("--primary", colorValues.hex);
		root.style.setProperty(
			"--primary-foreground",
			readableForegroundFor(colorValues.hex),
		);
		root.style.setProperty("--ring", colorValues.hex);
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
