"use client";

/**
 * Visual identity for an agent or a model — the avatar and the vendor logo.
 *
 * Both were private to the Nexus composer, which is also the only surface that
 * offers an agent/model picker today. The unified agent interface puts that
 * picker in front of every surface, so the identity primitives have to be
 * reachable from the shared chat components rather than from one page.
 *
 * Presentational only: no queries, no chat state. Moved verbatim so this stays
 * a relocation rather than a rewrite.
 */

import { cn } from "@ui/lib";
import Image from "next/image";
import { useState } from "react";

const AVATAR_PALETTE = [
	"bg-blue-500",
	"bg-emerald-500",
	"bg-violet-500",
	"bg-orange-500",
	"bg-rose-500",
	"bg-cyan-500",
	"bg-amber-500",
	"bg-indigo-500",
	"bg-teal-500",
	"bg-pink-500",
];

export function AgentAvatar({
	name,
	size = "md",
}: {
	name: string;
	size?: "sm" | "md" | "lg";
}) {
	let hash = 0;
	for (const c of name) {
		hash = (hash << 5) - hash + c.charCodeAt(0);
	}
	const color = AVATAR_PALETTE[Math.abs(hash) % AVATAR_PALETTE.length];
	const initial = name.charAt(0).toUpperCase();
	const sizeClass =
		size === "sm"
			? "size-6 text-[10px]"
			: size === "lg"
				? "size-10 text-base"
				: "size-8 text-sm";

	return (
		<div
			className={cn(
				"rounded-full flex items-center justify-center text-white font-semibold shrink-0",
				color,
				sizeClass,
			)}
		>
			{initial}
		</div>
	);
}

const VENDOR_FAVICON_URLS: Record<string, string> = {
	Anthropic: "https://anthropic.com/favicon.ico",
	OpenAI: "https://openai.com/favicon.ico",
	Google: "https://www.google.com/favicon.ico",
	"Mistral AI": "https://mistral.ai/favicon.ico",
	Mistral: "https://mistral.ai/favicon.ico",
	Meta: "https://ai.meta.com/favicon.ico",
	xAI: "https://x.ai/favicon.ico",
	DeepSeek: "https://www.deepseek.com/favicon.ico",
	Groq: "https://groq.com/favicon.ico",
	Cohere: "https://cohere.com/favicon.ico",
	"Together AI": "https://www.together.ai/favicon.ico",
	"Fireworks AI": "https://fireworks.ai/favicon.ico",
	Perplexity: "https://www.perplexity.ai/favicon.ico",
	Cerebras: "https://cerebras.ai/favicon.ico",
	Replicate: "https://replicate.com/favicon.ico",
	HuggingFace: "https://huggingface.co/favicon.ico",
	Cloudflare: "https://cloudflare.com/favicon.ico",
};

export function VendorLogo({
	vendor,
	size = 36,
}: {
	vendor: string;
	size?: number;
}) {
	const [failed, setFailed] = useState(false);
	const src = VENDOR_FAVICON_URLS[vendor];

	if (src && !failed) {
		return (
			<Image
				src={src}
				alt={vendor}
				width={size}
				height={size}
				onError={() => setFailed(true)}
				className="shrink-0 rounded-xl border border-border/60 bg-white object-contain p-1 shadow-sm"
				style={{ width: size, height: size }}
				unoptimized
			/>
		);
	}
	// Fallback to hash-based color avatar (circular)
	return (
		<AgentAvatar
			name={vendor}
			size={size >= 40 ? "lg" : size >= 28 ? "md" : "sm"}
		/>
	);
}
