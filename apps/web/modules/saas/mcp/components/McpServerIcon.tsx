"use client";

import { cn } from "@ui/lib";
import { ServerIcon } from "lucide-react";
import { useEffect, useMemo, useState } from "react";

type Props = {
	name?: string | null;
	iconUrl?: string | null;
	docsUrl?: string | null;
	repositoryUrl?: string | null;
	defaultUrl?: string | null;
	size?: number;
	className?: string;
	imageClassName?: string;
	fallbackClassName?: string;
};

function toOriginFavicon(url?: string | null) {
	if (!url) {
		return null;
	}

	try {
		const parsed = new URL(url);
		return `${parsed.origin}/favicon.ico`;
	} catch {
		return null;
	}
}

function isCodeHostUrl(url?: string | null) {
	if (!url) {
		return false;
	}

	try {
		const hostname = new URL(url).hostname.toLowerCase();
		return [
			"github.com",
			"www.github.com",
			"gitlab.com",
			"www.gitlab.com",
		].includes(hostname);
	} catch {
		return false;
	}
}

export function McpServerIcon({
	name,
	iconUrl,
	docsUrl,
	repositoryUrl,
	defaultUrl,
	size = 40,
	className,
	imageClassName,
	fallbackClassName,
}: Props) {
	const candidates = useMemo(() => {
		return [
			iconUrl,
			toOriginFavicon(defaultUrl),
			!isCodeHostUrl(docsUrl) ? toOriginFavicon(docsUrl) : null,
			!isCodeHostUrl(repositoryUrl)
				? toOriginFavicon(repositoryUrl)
				: null,
		].filter((value, index, values): value is string => {
			return Boolean(value) && values.indexOf(value) === index;
		});
	}, [defaultUrl, docsUrl, iconUrl, repositoryUrl]);

	const [attemptIndex, setAttemptIndex] = useState(0);

	useEffect(() => {
		setAttemptIndex(0);
	}, [candidates]);

	const currentSrc = candidates[attemptIndex];
	const initial = (name || "?").trim().charAt(0).toUpperCase();

	if (currentSrc) {
		return (
			// biome-ignore lint/performance/noImgElement: external registry icons come from arbitrary domains and are not suitable for next/image config
			<img
				src={currentSrc}
				alt=""
				width={size}
				height={size}
				onError={() => setAttemptIndex((prev) => prev + 1)}
				className={cn(
					"shrink-0 rounded-xl border border-border/60 bg-white/95 object-contain p-1.5 shadow-sm dark:bg-white/92",
					className,
					imageClassName,
				)}
			/>
		);
	}

	return (
		<div
			className={cn(
				"flex shrink-0 items-center justify-center rounded-xl border border-border/60 bg-white/95 text-muted-foreground shadow-sm dark:bg-white/92",
				className,
				fallbackClassName,
			)}
			style={{ width: size, height: size }}
			aria-hidden="true"
		>
			{name ? (
				<span className="text-sm font-semibold">{initial}</span>
			) : (
				<ServerIcon className="h-4.5 w-4.5" />
			)}
		</div>
	);
}
