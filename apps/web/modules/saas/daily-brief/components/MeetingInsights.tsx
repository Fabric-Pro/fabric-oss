import type { MeetingItem } from "@repo/database";

export interface MeetingInsightsProps {
	meeting: Pick<MeetingItem, "decisions" | "actionItems" | "openQuestions">;
}

export function MeetingInsights({ meeting }: MeetingInsightsProps) {
	const { decisions = [], actionItems = [], openQuestions = [] } = meeting;
	const hasAny =
		decisions.length > 0 ||
		actionItems.length > 0 ||
		openQuestions.length > 0;
	if (!hasAny) {
		return null;
	}

	return (
		<div className="mt-3 space-y-3 text-sm">
			{decisions.length > 0 && (
				<div>
					<span className="editorial-label">Decisions</span>
					<ul className="mt-1 list-disc space-y-1 pl-5">
						{decisions.map((d, i) => (
							<li key={`dec-${i}`}>
								{d.text}
								{d.relatedStoryIdentifier ? (
									<span className="ml-2 font-mono text-xs text-muted-foreground">
										({d.relatedStoryIdentifier})
									</span>
								) : null}
							</li>
						))}
					</ul>
				</div>
			)}

			{actionItems.length > 0 && (
				<div>
					<span className="editorial-label">Action items</span>
					<ul className="mt-1 list-disc space-y-1 pl-5">
						{actionItems.map((a, i) => (
							<li key={`act-${i}`}>
								{a.text}
								{a.tentativeOwnerName ? (
									<span className="ml-2 text-xs text-muted-foreground">
										— {a.tentativeOwnerName}
									</span>
								) : null}
								{a.dueHint ? (
									<span className="ml-1 text-xs text-muted-foreground">
										({a.dueHint})
									</span>
								) : null}
							</li>
						))}
					</ul>
				</div>
			)}

			{openQuestions.length > 0 && (
				<div>
					<span className="editorial-label">Open questions</span>
					<ul className="mt-1 list-disc space-y-1 pl-5">
						{openQuestions.map((q, i) => (
							<li key={`q-${i}`}>{q.text}</li>
						))}
					</ul>
				</div>
			)}
		</div>
	);
}
