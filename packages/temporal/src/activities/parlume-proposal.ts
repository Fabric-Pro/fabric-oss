import {
	parlumeProposalFieldLabel,
	parlumeProposalValueLabel,
} from "@repo/utils/parlume-proposal-fields";
import { PARLUME_TITLE_KEYS } from "./parlume-action-policy";

/** How long a member has to confirm a proposed change. */
export const PARLUME_PROPOSAL_TTL_MS = 24 * 60 * 60 * 1000;

const MAX_REQUEST_CHARS = 120;
const MAX_FIELDS = 3;
const MAX_FIELD_VALUE_CHARS = 40;
const MAX_REASON_CHARS = 200;

function shortened(text: string, max: number): string {
	const trimmed = text.replace(/\s+/g, " ").trim();
	return trimmed.length > max ? `${trimmed.slice(0, max - 1)}…` : trimmed;
}

function shortFieldValue(value: unknown): string | null {
	if (typeof value === "number" || typeof value === "boolean") {
		return String(value);
	}
	if (typeof value !== "string") {
		return null;
	}
	const trimmed = value.trim();
	if (
		!trimmed ||
		trimmed.length > MAX_FIELD_VALUE_CHARS ||
		/[\r\n]/.test(trimmed) ||
		/https?:\/\/|www\./i.test(trimmed)
	) {
		return null;
	}
	return parlumeProposalValueLabel(trimmed);
}

/**
 * At most three short arguments of a proposed change, as "Field: value". The
 * title is already in the change's own line; ids, long text and addresses are
 * left for the action page, which shows every argument.
 */
export function parlumeProposalFields(args: Record<string, unknown>): string[] {
	const fields: string[] = [];
	for (const [key, value] of Object.entries(args)) {
		if (
			PARLUME_TITLE_KEYS.includes(key) ||
			/(?:^|[_-])ids?$|Ids?$/.test(key)
		) {
			continue;
		}
		const shown = shortFieldValue(value);
		if (shown !== null) {
			fields.push(`${parlumeProposalFieldLabel(key)}: ${shown}`);
		}
		if (fields.length === MAX_FIELDS) {
			break;
		}
	}
	return fields;
}

/** The "proposed change" post, without the tag the bridge puts first. */
export function parlumeProposalText(input: {
	summary: string;
	projectName: string;
	asker: string | null;
	request: string;
	args: Record<string, unknown>;
	confirmUrl: string;
	dismissUrl: string;
}): string {
	const fields = parlumeProposalFields(input.args);
	return [
		"**Proposed change** · not made yet",
		`${input.summary} in ${input.projectName}`,
		`Asked by ${input.asker ?? "someone in the meeting"}: “${shortened(input.request, MAX_REQUEST_CHARS)}”`,
		...(fields.length > 0 ? [fields.join(" · ")] : []),
		`[Confirm in Fabric](${input.confirmUrl}) · [Dismiss](${input.dismissUrl})`,
		"Only a signed-in project member can confirm. Open for 24 hours.",
	].join("\n");
}

/** What `say` reads aloud for a proposal. */
export function parlumeProposalSpoken(summary: string): string {
	return `Proposed change, not made yet: ${summary}. A signed-in project member can confirm it in Fabric.`;
}

const PARLUME_CHANGE_DONE_SCOPE =
	"Only this change was made. Anything else the request asked for, such as syncing it to a PM tool or assigning it, is not done.";

/**
 * What the confirming member's change did, for the meeting chat. A request
 * can ask for more than the one change proposed ("create the bug, then sync
 * it and assign it"), so the post says this change alone was made and names
 * the parts a confirmation never does: syncing and assigning.
 */
export function parlumeChangeDoneText(input: {
	member: string;
	tag: string | null;
	summary: string;
	item: { label: string; url: string } | null;
	actionUrl: string;
}): string {
	return [
		`**Done** · ${input.member} confirmed ${input.tag ?? "a proposed change"}`,
		input.summary,
		PARLUME_CHANGE_DONE_SCOPE,
		input.item
			? `[Open ${input.item.label}](${input.item.url})`
			: `[Details](${input.actionUrl})`,
	].join("\n");
}

/**
 * A confirmed change that did not happen, or whose outcome Fabric could not
 * confirm, for the meeting chat.
 */
export function parlumeChangeNotMadeText(input: {
	tag: string | null;
	summary: string;
	projectName: string;
	reason: string;
	outcomeUnknown: boolean;
	actionUrl: string;
}): string {
	const heading = input.outcomeUnknown
		? "**Outcome unknown**"
		: "**Change not made**";
	return [
		input.tag ? `${heading} · ${input.tag}` : heading,
		`${input.summary} in ${input.projectName}`,
		shortened(input.reason, MAX_REASON_CHARS),
		`[Details](${input.actionUrl})`,
	].join("\n");
}
