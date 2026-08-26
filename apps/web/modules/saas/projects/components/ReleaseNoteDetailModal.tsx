"use client";

import type { NewsletterContent } from "@repo/database";
import { groupHighlightsByRelease } from "@repo/utils/group-highlights";
import {
	Dialog,
	DialogContent,
	DialogDescription,
	DialogHeader,
	DialogTitle,
} from "@ui/components/dialog";

type Props = {
	open: boolean;
	onOpenChange: (open: boolean) => void;
	content: NewsletterContent | null;
	/** Pre-formatted send date, shown under the headline (e.g. "Jun 17, 2026"). */
	dateLabel?: string;
};

/**
 * Read-only modal rendering a completed release note's full content. Mirrors the
 * grouping the email uses (`groupHighlightsByRelease`) so the in-app view matches
 * what subscribers received. The UI-kit Dialog provides focus-trap + labelling
 * (the headline is the `DialogTitle`); warm-paper styling via tokens only.
 */
export function ReleaseNoteDetailModal({
	open,
	onOpenChange,
	content,
	dateLabel,
}: Props) {
	// `content?.highlights` may be undefined/malformed (Prisma Json? with no runtime
	// validation); the util tolerates non-array input and returns [].
	const groups = groupHighlightsByRelease(content?.highlights as never);
	const multiRepo =
		new Set(groups.map((g) => g.repoFullName).filter(Boolean)).size > 1;
	// A non-null row that yields no headline and no renderable groups would show an
	// empty modal — surface a muted notice instead.
	const hasRenderableBody = Boolean(content?.headline) || groups.length > 0;

	return (
		<Dialog open={open} onOpenChange={onOpenChange}>
			<DialogContent className="max-w-2xl">
				<DialogHeader>
					{/* Editorial eyebrow with the thin red bar prefix */}
					<div className="flex items-center gap-2">
						<span
							aria-hidden="true"
							className="h-3 w-[3px] shrink-0 bg-primary"
						/>
						<span className="text-[11px] font-medium uppercase tracking-[0.2em] text-muted-foreground">
							Release Notes
						</span>
					</div>
					<DialogTitle className="font-serif text-2xl font-normal text-foreground">
						{content?.headline ?? "Release note"}
					</DialogTitle>
					{dateLabel ? (
						<DialogDescription>{dateLabel}</DialogDescription>
					) : null}
				</DialogHeader>

				{content ? (
					<div className="space-y-6">
						{!hasRenderableBody ? (
							<p className="text-sm text-muted-foreground">
								This release note&apos;s content is unavailable.
							</p>
						) : null}

						{content.intro ? (
							<p className="text-sm leading-relaxed text-foreground">
								{content.intro}
							</p>
						) : null}

						{groups.map((group, gi) => (
							<section
								key={`${gi}-${group.repoFullName}-${group.tag}`}
								className="space-y-3"
							>
								{group.tag ? (
									<div className="flex items-center gap-3">
										<span className="rounded-full bg-muted px-2 py-1 text-xs font-semibold text-primary">
											{group.tag}
										</span>
										{multiRepo && group.repoFullName ? (
											<span className="text-xs text-muted-foreground">
												{group.repoFullName
													.split("/")
													.pop()}
											</span>
										) : null}
										<div className="h-px flex-1 bg-border" />
									</div>
								) : null}
								<div className="space-y-3">
									{group.items.map((item, ii) => (
										<div
											key={`${ii}-${item.title}`}
											className="space-y-1"
										>
											<p className="text-sm font-semibold text-foreground">
												{item.title}
											</p>
											<p className="text-sm leading-relaxed text-muted-foreground">
												{item.description}
											</p>
										</div>
									))}
								</div>
							</section>
						))}
					</div>
				) : null}
			</DialogContent>
		</Dialog>
	);
}
