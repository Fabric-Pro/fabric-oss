/**
 * The pull request's title and description and the commit's message and
 * identities, rendered once at admission (Fizzy #2563 spec §5.2, Decision 17)
 * and frozen into `pullRequestContext`, so every retry builds the same commit.
 *
 * The order is the security property. Names are normalised and, when shaped
 * like an address, a URL or a token (or empty), replaced by a fixed fallback.
 * Then the raw note and names, and the complete unescaped text, are scanned
 * BEFORE any Markdown escaping, because escaping inserts backslashes that
 * split a pattern such as a GitHub token's prefix (spec §13.3). A hit in the
 * note refuses the note, naming its field; a hit that survives the fallback
 * outside the note refuses attribution, which admission records as a BLOCKED row
 * (`ATTRIBUTION_REJECTED`). Only then are the title and body escaped; the
 * commit message stays plain text.
 */
import type { ProposalNote } from "./proposal-note";
import { scanTextForSecrets } from "./secrets";

export const FALLBACK_PROPOSER_NAME = "a Fabric user";
export const FALLBACK_PROJECT_NAME = "a Fabric project";
export const PULL_REQUEST_COMMITTER_NAME = "Fabric";

// biome-ignore lint/suspicious/noControlCharactersInRegex: matching control characters is the point: they are stripped from display names.
const CONTROLS = /[\u0000-\u001f\u007f-\u009f]/g;

/** NFC, CR, LF and controls removed, trimmed, at most 100 code points (spec §5.2 step 1). */
export function normaliseName(s: string): string {
	return Array.from(s.normalize("NFC").replace(CONTROLS, "").trim())
		.slice(0, 100)
		.join("");
}

/** Address-, URL- or token-shaped, or empty: never used as written (spec §5.2 step 2). */
export function unsafeName(s: string): boolean {
	return (
		s === "" ||
		s.includes("@") ||
		s.includes("://") ||
		scanTextForSecrets(s).length > 0
	);
}

/** Literal Markdown: each of \ ` * _ # > [ ] < | escaped, leading whitespace collapsed (spec §5.2 step 5). */
export function escapeMarkdown(s: string): string {
	return s.replace(/[\\`*_#>[\]<|]/g, "\\$&").replace(/^[ \t]+/gm, "");
}

const MAIL_DOMAIN = /^[a-z0-9.-]+\.[a-z]{2,}$/i;

/**
 * The deployment's mail domain: the text after the last `@` of
 * `config.mails.from`, a trailing `>` removed (plan Decision 10). Null when
 * it is not a plain domain.
 */
export function mailDomainOf(mailFrom: string): string | null {
	const at = mailFrom.lastIndexOf("@");
	if (at < 0) {
		return null;
	}
	const domain = mailFrom
		.slice(at + 1)
		.trim()
		.replace(/>$/, "");
	return MAIL_DOMAIN.test(domain) ? domain : null;
}

export type PullRequestIdentity = { name: string; email: string };

export type RenderedPullRequestText =
	| {
			ok: true;
			author: PullRequestIdentity;
			committer: {
				name: typeof PULL_REQUEST_COMMITTER_NAME;
				email: string;
			};
			title: string;
			body: string;
			message: string;
	  }
	| { ok: false; code: "NOTE_REJECTED"; field: "title" | "body" }
	| { ok: false; code: "ATTRIBUTION_REJECTED" };

function hasHit(text: string): boolean {
	return scanTextForSecrets(text).length > 0;
}

export function renderPullRequestText(input: {
	note: ProposalNote;
	proposerName: string;
	projectName: string;
	fileCount: number;
	mailFrom: string;
}): RenderedPullRequestText {
	const noteTitle = input.note.title ?? "";
	const noteBody = input.note.body ?? "";
	// The raw note first: its hit is the proposer's to fix.
	if (hasHit(noteTitle)) {
		return { ok: false, code: "NOTE_REJECTED", field: "title" };
	}
	if (hasHit(noteBody)) {
		return { ok: false, code: "NOTE_REJECTED", field: "body" };
	}

	const domain = mailDomainOf(input.mailFrom);
	if (domain === null) {
		return { ok: false, code: "ATTRIBUTION_REJECTED" };
	}
	const email = `noreply@${domain}`;

	// A raw name's hit is removed by the fallback; only a hit that survives
	// it, in the composed text below, refuses attribution.
	const proposer = normaliseName(input.proposerName);
	const project = normaliseName(input.projectName);
	const proposerName = unsafeName(proposer)
		? FALLBACK_PROPOSER_NAME
		: proposer;
	const projectName = unsafeName(project) ? FALLBACK_PROJECT_NAME : project;

	const files = input.fileCount === 1 ? "1 file" : `${input.fileCount} files`;
	const title =
		noteTitle.trim() === ""
			? `Update coding instructions (${files})`
			: noteTitle;
	const footer = `Opened from Fabric project ${projectName} by ${proposerName}`;
	const body = [...(noteBody === "" ? [] : [noteBody]), "---", footer].join(
		"\n\n",
	);
	const message = noteBody === "" ? title : `${title}\n\n${noteBody}`;

	// The note was clean, so a hit here came from the names or the footer.
	if (
		hasHit(title) ||
		hasHit(body) ||
		hasHit(message) ||
		hasHit(proposerName)
	) {
		return { ok: false, code: "ATTRIBUTION_REJECTED" };
	}

	return {
		ok: true,
		author: { name: proposerName, email },
		committer: { name: PULL_REQUEST_COMMITTER_NAME, email },
		title: escapeMarkdown(title),
		body: escapeMarkdown(body),
		message,
	};
}
