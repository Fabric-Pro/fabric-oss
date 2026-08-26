import type { Storyline } from "@repo/database";

export interface StorylinesPanelProps {
	storylines: Storyline[];
}

export function StorylinesPanel({ storylines }: StorylinesPanelProps) {
	if (storylines.length === 0) {
		return null;
	}

	return (
		<section
			aria-label="In flight"
			className="rounded-2xl border border-border bg-card p-6"
		>
			<span className="editorial-label">In flight</span>
			<ul className="mt-4 space-y-5">
				{storylines.map((s) => (
					<li
						key={s.storyCuid ?? s.headline}
						className="border-l-2 border-primary/40 pl-4"
					>
						<div className="flex items-baseline gap-2">
							{s.storyIdentifier ? (
								<span className="font-mono text-xs text-muted-foreground">
									{s.storyIdentifier}
								</span>
							) : null}
							<h3 className="font-serif text-lg leading-snug">
								{s.headline}
							</h3>
						</div>
						<p className="mt-2 text-sm leading-relaxed text-foreground/80">
							{s.narrative}
						</p>
						{s.relatedItems.length > 0 ? (
							<p className="mt-1 text-xs text-muted-foreground">
								{s.relatedItems.length} related{" "}
								{s.relatedItems.length === 1 ? "item" : "items"}
							</p>
						) : null}
					</li>
				))}
			</ul>
		</section>
	);
}
