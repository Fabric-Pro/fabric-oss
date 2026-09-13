"use client";

import { config } from "@repo/config";
import { Avatar, AvatarFallback, AvatarImage } from "@ui/components/avatar";
import { cn } from "@ui/lib";
import { useMemo } from "react";

/**
 * One or two letters standing in for a logo.
 *
 * Two words give two initials ("Tech Fabric" → "TF"); one word gives its first
 * letter. Punctuation-only or empty names fall back to a single mark so the
 * frame is never blank.
 */
export function organizationMonogram(name: string): string {
	const words = name
		.split(/[\s\-_/·.]+/)
		.map((word) => word.replace(/[^\p{L}\p{N}]/gu, ""))
		.filter(Boolean);
	if (words.length === 0) {
		return "·";
	}
	if (words.length === 1) {
		return words[0].slice(0, 1).toUpperCase();
	}
	return (words[0][0] + words[words.length - 1][0]).toUpperCase();
}

/**
 * Pick black or white ink for a solid fill of `color`, by relative luminance.
 * Accepts #rgb / #rrggbb; anything else falls back to white ink.
 */
export function inkForFill(color: string): "#ffffff" | "#111111" {
	const hex = color.trim().replace(/^#/, "");
	const full =
		hex.length === 3
			? hex
					.split("")
					.map((c) => c + c)
					.join("")
			: hex;
	if (!/^[0-9a-f]{6}$/i.test(full)) {
		return "#ffffff";
	}
	const channel = (i: number) => {
		const v = Number.parseInt(full.slice(i, i + 2), 16) / 255;
		return v <= 0.03928 ? v / 12.92 : ((v + 0.055) / 1.055) ** 2.4;
	};
	const luminance =
		0.2126 * channel(0) + 0.7152 * channel(2) + 0.0722 * channel(4);
	return luminance > 0.45 ? "#111111" : "#ffffff";
}

/**
 * The organization's logo, or its monogram until one is uploaded.
 *
 * The fallback used to be a generated pattern coloured from CSS variables read
 * at runtime; those resolve to empty strings in the browser, so every
 * organization without a logo got the same flat grey blob. A monogram on a
 * solid primary fill with its paired foreground reads as the organization's
 * mark in every theme — including an organization whose brand palette makes
 * `--primary` itself pale, where a tint-and-ink pairing washed out. Pass
 * `brandColor` (a hex colour) to fill with the organization's own colour; the
 * ink is chosen by luminance so it stays legible on any brand.
 */
export const OrganizationLogo = ({
	name,
	logoUrl,
	brandColor,
	className,
	ref,
}: React.ComponentProps<typeof Avatar> & {
	name: string;
	logoUrl?: string | null;
	brandColor?: string | null;
	className?: string;
}) => {
	const logoSrc = useMemo(
		() =>
			logoUrl
				? logoUrl.startsWith("http")
					? logoUrl
					: `/image-proxy/${config.storage.bucketNames.avatars}/${logoUrl}`
				: undefined,
		[logoUrl],
	);
	const monogram = useMemo(() => organizationMonogram(name), [name]);

	return (
		<Avatar ref={ref} className={cn("rounded-md", className)}>
			<AvatarImage src={logoSrc} alt="" className="object-cover" />
			<AvatarFallback
				delayMs={logoSrc ? 300 : 0}
				aria-label={name}
				className="rounded-md bg-primary font-mono font-medium text-primary-foreground [font-size:calc(var(--monogram-size,2rem)*0.4)] leading-none tracking-tight"
				style={
					brandColor
						? {
								backgroundColor: brandColor,
								color: inkForFill(brandColor),
							}
						: undefined
				}
			>
				{monogram}
			</AvatarFallback>
		</Avatar>
	);
};

OrganizationLogo.displayName = "OrganizationLogo";
