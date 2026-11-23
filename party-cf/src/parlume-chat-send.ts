import type { ParlumeChatProposal } from "./parlume-chat";
import {
	type ParlumeTurnPostHeader,
	parseParlumeTurnPostHeader,
} from "./parlume-post-templates";
import { isRecord } from "./parlume-stream-auth";

// The worker's `?action=chat` body: a post for the answer it is giving, or a
// change it proposed.

const MAX_OUTBOUND_CHARS = 8_000;
const MAX_TURN_ID_CHARS = 128;
const MAX_PROPOSAL_SPOKEN_CHARS = 1_000;
const MAX_PROPOSAL_URL_CHARS = 2_048;
/** The most of a header's asker or request the bridge takes; it quotes less. */
const MAX_HEADER_CHARS = 4_000;

/** What a proposal post carries besides its chat text. */
interface ProposalInput extends ParlumeChatProposal {
	/** What `say` reads aloud. */
	spoken: string;
}

function boundedText(value: unknown, max: number): string | null {
	if (typeof value !== "string") {
		return null;
	}
	const text = value.trim();
	return text && text.length <= max ? text : null;
}

function fabricUrl(value: unknown): string | null {
	const url = boundedText(value, MAX_PROPOSAL_URL_CHARS);
	return url && /^https?:\/\/\S+$/i.test(url) ? url : null;
}

function parseProposal(value: unknown): ProposalInput | null {
	if (!isRecord(value)) {
		return null;
	}
	const actionId = boundedText(value.actionId, MAX_TURN_ID_CHARS);
	const spoken = boundedText(value.spoken, MAX_PROPOSAL_SPOKEN_CHARS);
	const confirmUrl = fabricUrl(value.confirmUrl);
	const dismissUrl = fabricUrl(value.dismissUrl);
	return actionId && spoken && confirmUrl && dismissUrl
		? { actionId, spoken, confirmUrl, dismissUrl }
		: null;
}

export function parseParlumeChatSendBody(body: unknown): {
	message: string;
	proposal: ProposalInput | null;
	turnId: string | null;
	voiceGeneration: number | null;
	final: boolean;
	/** The typed request is answered by a post already made; post nothing. */
	close: boolean;
	/** The recap: one paragraph, without an answer's formatting. */
	plain: boolean;
	/** What the post is for its turn, and who asked: its first two lines. */
	header: ParlumeTurnPostHeader | null;
} | null {
	if (!isRecord(body)) {
		return null;
	}
	const proposal =
		body.proposal === undefined ? null : parseProposal(body.proposal);
	const close =
		body.close === true &&
		body.final === true &&
		body.proposal === undefined;
	const message = body.message;
	if (
		(body.proposal !== undefined && !proposal) ||
		typeof message !== "string" ||
		(message.trim() === "" && !close) ||
		message.length > MAX_OUTBOUND_CHARS
	) {
		return null;
	}
	return {
		message,
		proposal,
		turnId:
			typeof body.turnId === "string" &&
			body.turnId.length > 0 &&
			body.turnId.length <= MAX_TURN_ID_CHARS
				? body.turnId
				: null,
		voiceGeneration:
			typeof body.voiceGeneration === "number" &&
			Number.isSafeInteger(body.voiceGeneration)
				? body.voiceGeneration
				: null,
		final: body.final === true,
		close,
		plain: body.plain === true && !proposal,
		header:
			proposal || body.plain === true
				? null
				: parseParlumeTurnPostHeader(body.header, MAX_HEADER_CHARS),
	};
}
