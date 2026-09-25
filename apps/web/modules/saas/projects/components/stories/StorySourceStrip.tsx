import type { UserStory } from "../../lib/stories/types";

/**
 * F-171 reporter strip (REQ-8, REQ-15): a slim strip below the action bar that
 * shows where a work item came from. A bug shows it whenever any reporter field
 * is set; any other kind shows it once it has a source link, so a feature
 * approved from a Teams or Slack proposal links back to its conversation as
 * visibly as a bug does. Hidden otherwise (legacy items created before F-171,
 * and items entered by hand).
 */
export function StorySourceStrip({
	story,
}: {
	story: Pick<
		UserStory,
		"kind" | "reporterName" | "reporterSource" | "reporterSourceUrl"
	>;
}) {
	const isBug = story.kind === "BUG";
	const visible = isBug
		? Boolean(
				story.reporterName ||
					story.reporterSource ||
					story.reporterSourceUrl,
			)
		: Boolean(story.reporterSourceUrl);
	if (!visible) {
		return null;
	}
	return (
		<div className="flex items-center gap-3 px-6 py-1.5 border-b bg-muted/30 text-xs text-muted-foreground">
			{story.reporterSource && (
				<span className="inline-flex items-center gap-1 rounded-full bg-background px-2 py-0.5 font-medium uppercase tracking-wider text-[10px]">
					{isBug ? "Reported" : "Proposed"} via {story.reporterSource}
				</span>
			)}
			{story.reporterName && (
				<span>
					by{" "}
					<span className="text-foreground">
						{story.reporterName}
					</span>
				</span>
			)}
			{story.reporterSourceUrl && (
				<a
					href={story.reporterSourceUrl}
					target="_blank"
					rel="noreferrer"
					className="text-primary hover:underline"
				>
					View source conversation →
				</a>
			)}
		</div>
	);
}
