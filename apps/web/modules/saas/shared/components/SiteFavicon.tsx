"use client";

import { cn } from "@ui/lib";
import { type ReactNode, useEffect, useMemo, useState } from "react";

type Props = {
	/** Any URL on the brand's site; only the hostname is used. */
	url?: string | null;
	/** Accessible name for the mark, also the source of the letter fallback. */
	name: string;
	size?: number;
	className?: string;
	/** Drawn when no favicon can be loaded. Defaults to the name's initial. */
	fallback?: ReactNode;
};

/*
 * A crisp mark first: Google's favicon service returns the site's icon at
 * 64px, which holds up in a 28px tile where a raw /favicon.ico is often a
 * 16px bitmap. The origin's own favicon stays as the fallback, then the
 * caller's fallback, then the initial. Same approach as McpServerIcon; this
 * is the brand-agnostic version for any provider that has a website.
 */
function faviconCandidates(url?: string | null): string[] {
	if (!url) {
		return [];
	}
	try {
		const parsed = new URL(url);
		return [
			`https://www.google.com/s2/favicons?domain=${parsed.hostname}&sz=64`,
			`${parsed.origin}/favicon.ico`,
		];
	} catch {
		return [];
	}
}

export function SiteFavicon({
	url,
	name,
	size = 28,
	className,
	fallback,
}: Props) {
	const candidates = useMemo(() => faviconCandidates(url), [url]);
	const [attempt, setAttempt] = useState(0);
	useEffect(() => {
		setAttempt(0);
	}, [candidates]);
	const src = candidates[attempt];
	// No forced white plate: most favicons ship their own square, and a white
	// pad around a dark one reads as a border. The mark fills the frame; a
	// hairline and the card surface behind it carry transparent ones.
	const frame =
		"flex shrink-0 items-center justify-center overflow-hidden rounded-lg border border-border/60 bg-card";

	if (src) {
		return (
			<span
				className={cn(frame, className)}
				style={{ width: size, height: size }}
			>
				{/* biome-ignore lint/performance/noImgElement: favicons come from arbitrary third-party domains and are not suitable for next/image config */}
				<img
					src={src}
					alt={name}
					width={size}
					height={size}
					onError={() => setAttempt((prev) => prev + 1)}
					className="size-full object-cover"
				/>
			</span>
		);
	}
	return (
		<span
			role="img"
			aria-label={name}
			className={cn(frame, "text-muted-foreground", className)}
			style={{ width: size, height: size }}
		>
			{fallback ?? (
				<span className="text-xs font-semibold">
					{name.trim().charAt(0).toUpperCase()}
				</span>
			)}
		</span>
	);
}
