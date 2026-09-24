import { isEffectivelyBlank } from "./blank-content";

/**
 * The maximum length of a prompt body a user can save.
 *
 * The largest seeded system prompt today is roughly 22,600 characters, so
 * 50,000 leaves more than 2x headroom for real prompts while still capping
 * the cost of the worst case: a prompt this long can be bound as an
 * organization default, which puts it — and its ~12,500-token bill — in
 * front of every generation that runs under it. `INPUT_BOUNDS.text`
 * (200,000, in `packages/api/lib/zod-bounds.ts`) stays as the outer abuse
 * ceiling shared with every other free-text field; this is the tighter,
 * prompt-specific product limit.
 */
export const PROMPT_CONTENT_MAX_LENGTH = 50_000;

export const PROMPT_CONTENT_EMPTY_MESSAGE = "Prompt content cannot be empty";

/** The message shown when a prompt body exceeds {@link PROMPT_CONTENT_MAX_LENGTH}. */
export function promptContentTooLongMessage(length: number): string {
	return `Prompt content is ${length.toLocaleString("en-US")} characters; the maximum is ${PROMPT_CONTENT_MAX_LENGTH.toLocaleString("en-US")}.`;
}

/**
 * What is wrong with a prompt body, in one sentence a user can act on — or
 * `null` when there is nothing wrong with it.
 *
 * Shared by the server-side save guard (`assertSavablePromptContent`) and the
 * client-side editors, so the message a user sees while typing is the exact
 * message the save would fail with, never a paraphrase of it.
 */
export function promptContentProblem(content: string): string | null {
	if (isEffectivelyBlank(content)) {
		return PROMPT_CONTENT_EMPTY_MESSAGE;
	}
	if (content.length > PROMPT_CONTENT_MAX_LENGTH) {
		return promptContentTooLongMessage(content.length);
	}
	return null;
}
