"use client";

import { formatDistanceToNow } from "date-fns";
import Link from "next/link";
import type { ReactNode } from "react";

const CARD_CLASS_NAME =
	"group flex h-full w-full flex-col gap-3 rounded-lg border border-border bg-card p-5 text-left transition-colors hover:bg-accent focus-visible:outline-none focus-visible:ring-[3px] focus-visible:ring-ring";

/**
 * One page an agent wrote, as a card in a list: what it is called, what it
 * shows, when it last changed. The whole card opens the page: a link when it has
 * a place of its own, a button when it opens in the list.
 *
 * Inside a link the title is a heading; inside a button it is plain text, since
 * a button holds phrasing content only.
 */
export function FrameSummaryCard({
	label,
	title,
	description,
	updatedAt,
	badges,
	href,
	onOpen,
}: {
	/** Editorial label above the title: where the page lives. */
	label: string;
	title: string;
	description?: string;
	updatedAt: string;
	badges?: ReactNode;
} & (
	| { href: string; onOpen?: undefined }
	| { href?: undefined; onOpen: () => void }
)) {
	const Title = href ? "h3" : "span";
	const Description = href ? "p" : "span";
	const content = (
		<>
			<span className="app-editorial-label">{label}</span>
			<Title className="line-clamp-2 block font-serif text-xl leading-snug text-foreground">
				{title}
			</Title>
			<Description className="line-clamp-3 block text-sm leading-6 text-muted-foreground">
				{description || "No description yet."}
			</Description>
			<span className="mt-auto flex flex-wrap items-center justify-between gap-2 pt-2 text-xs text-muted-foreground">
				<span>
					Updated{" "}
					{formatDistanceToNow(new Date(updatedAt), {
						addSuffix: true,
					})}
				</span>
				{badges}
			</span>
		</>
	);

	return href ? (
		<Link href={href} className={CARD_CLASS_NAME}>
			{content}
		</Link>
	) : (
		<button type="button" onClick={onOpen} className={CARD_CLASS_NAME}>
			{content}
		</button>
	);
}
