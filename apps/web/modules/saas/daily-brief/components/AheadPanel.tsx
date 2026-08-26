import type { AheadItem } from "@repo/database";

export interface AheadPanelProps {
	items: AheadItem[];
}

const KIND_LABEL: Record<AheadItem["kind"], string> = {
	upcoming_meeting: "Meeting",
	story_about_to_transition: "Transition soon",
	proposal_expiring: "Proposal expiring",
};

function formatOccursAt(d: Date): string {
	const date = d instanceof Date ? d : new Date(d);
	const now = Date.now();
	const deltaMs = date.getTime() - now;
	if (Math.abs(deltaMs) < 60 * 60 * 1000) {
		return "now";
	}
	const deltaHours = deltaMs / (60 * 60 * 1000);
	if (deltaHours > 0 && deltaHours < 24) {
		return `in ${Math.round(deltaHours)}h`;
	}
	if (deltaHours <= 0 && deltaHours > -24) {
		return `${Math.abs(Math.round(deltaHours))}h ago`;
	}
	return date.toLocaleDateString(undefined, {
		weekday: "short",
		hour: "numeric",
		minute: "2-digit",
	});
}

export function AheadPanel({ items }: AheadPanelProps) {
	if (items.length === 0) {
		return null;
	}
	return (
		<section
			aria-label="Ahead"
			className="rounded-2xl border border-border bg-muted/40 p-6"
		>
			<span className="editorial-label">Ahead</span>
			<ul className="mt-4 divide-y divide-border/60">
				{items.map((it) => (
					<li
						key={`${it.kind}-${it.targetCuid ?? it.title}`}
						className="flex items-baseline justify-between py-2"
					>
						<div className="min-w-0">
							<span className="mr-3 font-mono text-[10px] uppercase tracking-wider text-muted-foreground">
								{KIND_LABEL[it.kind]}
							</span>
							<a
								href={it.fabricLink}
								className="text-sm hover:underline"
							>
								{it.title}
							</a>
							{it.context ? (
								<span className="ml-2 text-xs text-muted-foreground">
									{it.context}
								</span>
							) : null}
						</div>
						<span className="ml-3 shrink-0 text-xs text-muted-foreground">
							{formatOccursAt(it.occursAt)}
						</span>
					</li>
				))}
			</ul>
		</section>
	);
}
