import { formatDate, formatDistance, parseISO } from "date-fns";
import type { ChangelogItem } from "../types";

export function ChangelogSection({ items }: { items: ChangelogItem[] }) {
	return (
		<section id="changelog">
			<div className="mx-auto grid w-full max-w-xl grid-cols-1 gap-4 text-left">
				{items?.map((item, i) => {
					const parsedDate = parseISO(item.date);
					return (
						<div key={i} className="rounded-xl border bg-card p-6">
							<time
								className="inline-block rounded-full border border-highlight/50 px-2 py-0.5 font-semibold text-highlight text-xs"
								dateTime={parsedDate.toISOString()}
								title={formatDate(parsedDate, "yyyy-MM-dd")}
							>
								{formatDistance(parsedDate, new Date(), {
									addSuffix: true,
								})}
							</time>
							<ul className="mt-4 list-disc space-y-2 pl-6">
								{item.changes.map((change, j) => (
									<li key={j}>{change}</li>
								))}
							</ul>
						</div>
					);
				})}
			</div>
		</section>
	);
}
