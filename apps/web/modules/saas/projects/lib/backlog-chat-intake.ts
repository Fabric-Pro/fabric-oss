import type { EngagementProfile } from "@repo/database";
import { getEngagementProfileConfig } from "@repo/database/src/engagement-profiles";

/**
 * How the backlog chat opens for a given engagement profile (plan Slice 6).
 *
 * Under EXPLORE (`intakeMode: "conversation"`) the chat is the intake: no
 * document, no tech stack, no integrations required. The opening message
 * asks for the hunch and the analysis runs in "explore" mode, which
 * proposes the first spikes and reflects the inferred vision back.
 *
 * Pure so the empty state and the analysis mode can be unit-tested.
 */
export type BacklogChatIntake =
	| {
			intakeMode: "explore";
			/** Opening assistant message for the empty chat. */
			initialMessage: string;
			suggestions: Array<{ title: string; message: string }>;
	  }
	| { intakeMode: "standard" };

export const EXPLORE_EMPTY_STATE_MESSAGE =
	"Describe the hunch. I'll propose the first spikes.";

export function resolveBacklogChatIntake(
	profile: EngagementProfile | null | undefined,
	projectName?: string,
): BacklogChatIntake {
	if (!profile) {
		return { intakeMode: "standard" };
	}
	if (getEngagementProfileConfig(profile).intakeMode !== "conversation") {
		return { intakeMode: "standard" };
	}
	const name = projectName ? ` for **${projectName}**` : "";
	return {
		intakeMode: "explore",
		initialMessage: `${EXPLORE_EMPTY_STATE_MESSAGE} Tell me what you want to build${name}, who it is for and what you are unsure about — no document needed.`,
		suggestions: [
			{
				title: "Start from a hunch",
				message:
					"Here is the idea I want to explore. Propose the first spikes that would teach us the most.",
			},
		],
	};
}

/**
 * Whether the backlog view should open the chat by itself (plan Slice 6:
 * "the project opens on a conversation, not a form").
 *
 * Only under a conversation-intake profile (EXPLORE), only once the project
 * and its backlog are known, and only while the backlog is empty: a project
 * with work in it is past intake, and forcing the panel open on every visit
 * would get in the way of the board.
 */
export function shouldAutoOpenBacklogChat(input: {
	profile: EngagementProfile | null | undefined;
	backlogLoaded: boolean;
	storyCount: number;
}): boolean {
	if (!input.profile || !input.backlogLoaded) {
		return false;
	}
	if (
		getEngagementProfileConfig(input.profile).intakeMode !== "conversation"
	) {
		return false;
	}
	return input.storyCount === 0;
}
