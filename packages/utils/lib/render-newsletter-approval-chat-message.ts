/**
 * The release-notes REVIEW ALERT posted to a project's configured chat channels
 * (Fizzy #2203).
 *
 * Deliberately carries NO curated headline or body. The approval gate exists
 * because AI-curated notes may be inaccurate or may name flag-gated work that
 * has not shipped; broadcasting that draft to a team channel before a human
 * approves it partly defeats the gate this alert is attached to. Project name,
 * a count, and the link to act are enough to bring a reviewer in.
 *
 * Platform branching mirrors `renderNewsletterChatMessage`: Slack parses mrkdwn,
 * while Teams receives `contentType: "text"` from the Graph executor and parses
 * no markup at all, so it gets a bare URL.
 */
export function renderNewsletterApprovalChatMessage(input: {
	projectName: string;
	highlightCount: number;
	link: string;
	platform: "TEAMS" | "SLACK";
}): string {
	const { projectName, highlightCount, link, platform } = input;
	const isSlack = platform === "SLACK";
	const noun = highlightCount === 1 ? "highlight" : "highlights";
	const headline = `Release notes for ${projectName} are awaiting review`;
	const detail = `${highlightCount} ${noun} ready to approve or reject.`;

	if (isSlack) {
		return `*${headline}*\n${detail}\n<${link}|Review the release notes>`;
	}
	return `${headline}\n${detail}\nReview the release notes: ${link}`;
}
