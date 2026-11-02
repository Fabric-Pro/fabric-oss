/**
 * The cover letter's blocks on the Proposal's print page (Fizzy #2946):
 * which of Main's nodes the letter takes from the body, and its paragraphs
 * in their roles. The page around them is `build-cover-html`'s
 * `letterHtml`. Each block is drawn by the body's own walk, so the letter's
 * prose, lists, figures and footnotes print as a section's do.
 */

import { PROPOSAL_PRINT_CLASSES } from "@repo/utils/proposal-artifact/proposal-theme";
import type { Nodes, Paragraph } from "mdast";
import type { LetterContent } from "./build-cover-html";
import {
	type CoverLetter,
	type LetterRole,
	letterRoles,
} from "./document-content";

const PRINT = PROPOSAL_PRINT_CLASSES;

/** The class each role of a cover letter's paragraphs prints with. */
const LETTER_ROLE_CLASSES: Readonly<Record<LetterRole, string>> = {
	date: PRINT.letterDate,
	subject: PRINT.letterSubject,
	signer: PRINT.letterSigner,
	signerRole: PRINT.letterSignerRole,
};

/** The body's walk, as the letter draws its blocks with it. */
export interface LetterBlockWriter {
	/** A block as a section prints it. */
	flow(node: Nodes): string;
	/** A paragraph's figure, or its inline HTML. */
	paragraphContent(node: Paragraph): { figure: string } | { inline: string };
}

/** The letter's heading and blocks, which the body leaves out. */
export function letterNodes(letter: CoverLetter | null): Set<Nodes> {
	return new Set<Nodes>(letter ? [letter.heading, ...letter.nodes] : []);
}

/**
 * The cover letter's blocks. Its date, subject line, signer and the line
 * under the signer each carry their role's class; every other block prints
 * as it would in a section.
 */
export function letterContent(
	letter: CoverLetter,
	writer: LetterBlockWriter,
): LetterContent {
	const roles = letterRoles(letter.nodes);
	const html = letter.nodes
		.map((node) => {
			const role =
				node.type === "paragraph" ? roles.get(node) : undefined;
			if (node.type !== "paragraph" || role === undefined) {
				return writer.flow(node);
			}
			const content = writer.paragraphContent(node);
			if ("figure" in content) {
				return content.figure;
			}
			return content.inline.trim() === ""
				? ""
				: `<p class="${LETTER_ROLE_CLASSES[role]}">${content.inline}</p>`;
		})
		.join("");
	return { label: letter.label, html };
}
