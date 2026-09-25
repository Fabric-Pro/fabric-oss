/**
 * The note a proposer attaches to a suggested change (Fizzy #2563 spec §5.1
 * step 6, Decision 17): `{ title?, body? }`, stored as `proposalNote` for both
 * destinations. For a REPOSITORY proposal it becomes the pull request's title
 * and description and the commit message (`pull-request-text.ts`).
 *
 * Both fields are NFC-normalised first and measured after, so a decomposed
 * "é" counts once: the title in code points (one line, at most 120), the body
 * in UTF-8 bytes (at most 4096). NUL and lone surrogates are refused because
 * neither survives a git commit message or a provider API as written. A
 * failure names only the field (`NOTE_REJECTED`, spec §5.3), never the text.
 */
import { z } from "zod";

export const PROPOSAL_NOTE_TITLE_MAX_CODE_POINTS = 120;
export const PROPOSAL_NOTE_BODY_MAX_BYTES = 4096;

const LONE_SURROGATE =
	/[\uD800-\uDBFF](?![\uDC00-\uDFFF])|(?<![\uD800-\uDBFF])[\uDC00-\uDFFF]/;

function wellFormed(value: string): boolean {
	return !value.includes("\u0000") && !LONE_SURROGATE.test(value);
}

const nfc = z.string().transform((value) => value.normalize("NFC"));

const title = nfc
	.refine(wellFormed, { message: "The title contains an invalid character" })
	.refine((value) => !/[\r\n]/.test(value), {
		message: "The title must be one line",
	})
	.refine(
		(value) =>
			Array.from(value).length <= PROPOSAL_NOTE_TITLE_MAX_CODE_POINTS,
		{ message: "The title is too long" },
	);

const body = nfc
	.refine(wellFormed, {
		message: "The description contains an invalid character",
	})
	.refine(
		(value) =>
			new TextEncoder().encode(value).length <=
			PROPOSAL_NOTE_BODY_MAX_BYTES,
		{ message: "The description is too long" },
	);

export type ProposalNote = { title?: string; body?: string };

export const proposalNoteSchema: z.ZodType<ProposalNote> = z.object({
	title: title.optional(),
	body: body.optional(),
});
