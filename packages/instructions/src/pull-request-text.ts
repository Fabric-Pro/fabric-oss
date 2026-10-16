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

/**
 * Stops an `@name`, `@org/team` or `@<id>` in a pull request's title or
 * description from notifying anyone: a proposer's note is opened in the
 * repository under the Fabric app's identity, and a mention in it would page
 * a person or a whole team on the proposer's say-so.
 *
 * A zero-width space after an `@` that could start a mention, and only that one.
 * GitHub, GitLab and Azure DevOps read `@` as a mention at the start of the text
 * or after a character outside `[A-Za-z0-9_]`, and only when a name (or, for
 * Azure DevOps, `<id>`) follows; an address such as `dev@example.com` is not a
 * mention, and a space inside it would break copying it and its `mailto:`
 * link, so it stays byte-identical. The space is what all three providers need and
 * the other candidates are not: each recognises a mention by the characters
 * that follow the `@` in the rendered text, so a character between them ends
 * it, and the text still reads as a literal `@`. A backslash escape
 * (`\@`) and an entity (`&#64;`) both render to a plain `@` before the
 * provider looks for mentions, so GitHub and GitLab still notify; a code span
 * would change how the note looks. Applied after the secret scan, like
 * `escapeMarkdown`, and to the title and description only: the commit message
 * stays plain text.
 */
export function neutraliseMentions(s: string): string {
	return s.replace(/(?<![A-Za-z0-9_])@(?=[A-Za-z0-9_<])/g, "@\u200b");
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
		title: escapeMarkdown(neutraliseMentions(title)),
		body: escapeMarkdown(neutraliseMentions(body)),
		message,
	};
}

/** The longest commit message a direct commit accepts, first line included. */
export const DIRECT_COMMIT_MESSAGE_MAX_CHARS = 5000;
/** The longest first line (the commit's subject) a direct commit accepts. */
export const DIRECT_COMMIT_SUBJECT_MAX_CHARS = 300;

// biome-ignore lint/suspicious/noControlCharactersInRegex: matching control characters is the point: a commit message carries none but tab and newline.
const TEXT_CONTROLS = /[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f-\u009f]/g;

/** A line that spells Fabric's own `Fabric-Commit` trailer, in any case and with any spacing before the colon. */
const SPOOFED_COMMIT_TRAILER = /^[ \t]*Fabric-Commit[ \t]*:/im;

/**
 * A commit message as a commit carries it: line endings normalised, controls
 * other than tab and newline removed, trailing space trimmed, runs of blank
 * lines collapsed. Every check on a message (a credential, a trailer of
 * Fabric's own) runs on this form, so nothing can hide in what is removed.
 */
export function normaliseCommitMessage(raw: string): string {
	return raw
		.replace(/\r\n?/g, "\n")
		.replace(TEXT_CONTROLS, "")
		.split("\n")
		.map((line) => line.replace(/[ \t]+$/, ""))
		.join("\n")
		.replace(/\n{3,}/g, "\n\n")
		.trim();
}

export type RenderedDirectCommitText =
	| {
			ok: true;
			author: PullRequestIdentity;
			committer: {
				name: typeof PULL_REQUEST_COMMITTER_NAME;
				email: string;
			};
			/** Plain text, no trailing newline, the caller's own words. */
			message: string;
	  }
	| { ok: false; code: "MESSAGE_EMPTY" | "MESSAGE_TOO_LONG" }
	| { ok: false; code: "MESSAGE_REJECTED" }
	| { ok: false; code: "ATTRIBUTION_REJECTED" };

/**
 * The commit message and identities of a direct commit, rendered once at
 * admission (Fizzy #2878 §10) with the attribution every Fabric commit has:
 * the member's display name, normalised and replaced by the fixed fallback
 * when shaped like an address, a URL or a token, with the deployment's
 * `noreply@` address, and `Fabric` as committer. Fabric holds no
 * provider-verified email for a member, and a real address would be published
 * into a possibly public repository.
 *
 * The message is the committer's own words, kept plain text: line endings
 * normalised, controls other than tab and newline removed, trailing space
 * trimmed. It is scanned for secrets BEFORE anything else, and a hit refuses
 * it (`MESSAGE_REJECTED`) without quoting it, because an error body is logged
 * and shown. A message with a line that begins `Fabric-Commit:` is refused the
 * same way: that trailer is Fabric's own, appended after the message so a retry
 * can find its commit again, and a committer's own line of that shape would
 * let a lookup mistake another commit for one of Fabric's. A name that
 * survives the fallback with a hit refuses attribution.
 */
export function renderDirectCommitText(input: {
	message: string;
	proposerName: string;
	mailFrom: string;
}): RenderedDirectCommitText {
	const message = normaliseCommitMessage(input.message);
	const subject = message.split("\n", 1)[0] ?? "";
	if (subject === "") {
		return { ok: false, code: "MESSAGE_EMPTY" };
	}
	if (
		message.length > DIRECT_COMMIT_MESSAGE_MAX_CHARS ||
		subject.length > DIRECT_COMMIT_SUBJECT_MAX_CHARS
	) {
		return { ok: false, code: "MESSAGE_TOO_LONG" };
	}
	if (hasHit(message) || SPOOFED_COMMIT_TRAILER.test(message)) {
		return { ok: false, code: "MESSAGE_REJECTED" };
	}

	const domain = mailDomainOf(input.mailFrom);
	if (domain === null) {
		return { ok: false, code: "ATTRIBUTION_REJECTED" };
	}
	const email = `noreply@${domain}`;
	const proposer = normaliseName(input.proposerName);
	const proposerName = unsafeName(proposer)
		? FALLBACK_PROPOSER_NAME
		: proposer;
	if (hasHit(proposerName)) {
		return { ok: false, code: "ATTRIBUTION_REJECTED" };
	}
	return {
		ok: true,
		author: { name: proposerName, email },
		committer: { name: PULL_REQUEST_COMMITTER_NAME, email },
		message,
	};
}

/** The trailer that names the memory write a commit belongs to; a retry finds its commit by it. */
export const MEMORY_WRITE_TRAILER = "Fabric-Memory-Write";
/** The trailer that names the agent (the OAuth client) a memory write came through. */
export const MEMORY_WRITE_AGENT_TRAILER = "Fabric-Agent";

/**
 * A line that spells one of Fabric's own commit trailers (`Fabric-Commit`,
 * `Fabric-Memory-Write`, `Fabric-Agent`), in any case and with any spacing
 * before the colon. A caller's message may not carry one: the trailers are
 * appended after the message, and a retry finds its commit by them.
 */
const RESERVED_TRAILER_LINE =
	/^[ \t]*Fabric-(?:Commit|Memory-Write|Agent)[ \t]*:/im;

/** Whether `message` has a line that spells one of Fabric's own commit trailers. */
export function hasReservedTrailerLine(message: string): boolean {
	return RESERVED_TRAILER_LINE.test(message);
}

/** An id this codebase issues: what a trailer value may be. */
const TRAILER_ID = /^[A-Za-z0-9_-]{8,64}$/;

/** An OAuth client id as the `Fabric-Agent` trailer carries it: the safe characters of it, at most 64. */
export function agentTrailerValue(clientId: string | null | undefined): string {
	return (clientId ?? "").replace(/[^A-Za-z0-9._-]/g, "").slice(0, 64);
}

export type RenderedMemoryWriteText =
	| {
			ok: true;
			author: PullRequestIdentity;
			committer: {
				name: typeof PULL_REQUEST_COMMITTER_NAME;
				email: string;
			};
			/** The caller's own words, normalised: no trailers, no trailing newline. */
			message: string;
			/** The first line of `message`. */
			subject: string;
			/** `message` after its first line, trimmed; empty when there is none. */
			body: string;
			/** `message`, a blank line, then the trailers, ending in a newline. */
			commitMessage: string;
	  }
	| { ok: false; code: "MESSAGE_EMPTY" | "MESSAGE_TOO_LONG" }
	| { ok: false; code: "MESSAGE_REJECTED" }
	| { ok: false; code: "ATTRIBUTION_REJECTED" };

/**
 * The commit message and identities of a Living Memory write (ADR-022), with
 * the attribution every Fabric commit has (`renderDirectCommitText`): the
 * member's display name and the deployment's `noreply@` address as author,
 * `Fabric` as committer, and the same refusals (an empty or over-long message,
 * a credential in it). A message with a line that spells one of Fabric's own
 * trailers is refused too, since the trailers are Fabric's: appended after the
 * message, they are how a retry recognises its commit, and the caller's own
 * line of that shape would let a lookup mistake another commit for it. The
 * check runs on the normalised message, so a control character cannot hide one.
 */
export function renderMemoryWriteText(input: {
	message: string;
	proposerName: string;
	mailFrom: string;
	writeId: string;
	agentId?: string | null;
}): RenderedMemoryWriteText {
	if (!TRAILER_ID.test(input.writeId)) {
		throw new Error("A memory write's trailer id is not an issued id");
	}
	const rendered = renderDirectCommitText(input);
	if (!rendered.ok) {
		return rendered;
	}
	if (hasReservedTrailerLine(rendered.message)) {
		return { ok: false, code: "MESSAGE_REJECTED" };
	}
	const [subject = "", ...rest] = rendered.message.split("\n");
	const agent = agentTrailerValue(input.agentId);
	return {
		ok: true,
		author: rendered.author,
		committer: rendered.committer,
		message: rendered.message,
		subject,
		body: rest.join("\n").trim(),
		commitMessage: [
			rendered.message,
			"",
			`${MEMORY_WRITE_TRAILER}: ${input.writeId}`,
			...(agent === ""
				? []
				: [`${MEMORY_WRITE_AGENT_TRAILER}: ${agent}`]),
			"",
		].join("\n"),
	};
}

/** The longest first line of a reverted commit quoted in a revert's subject. */
export const REVERT_QUOTED_SUBJECT_MAX_CHARS = 200;

/**
 * The message of a revert commit, as git writes one: `Revert "<subject>"`,
 * then `This reverts commit <sha>.`. The subject is the reverted commit's own
 * first line, which is repository text, not the reverter's: its controls are
 * removed, it is cut at `REVERT_QUOTED_SUBJECT_MAX_CHARS`, and when it is empty
 * or holds what looks like a credential it is not quoted at all (`Revert
 * commit <short sha>`), so a revert never copies a secret out of a message and
 * into a new commit.
 */
export function renderRevertCommitMessage(input: {
	subject: string;
	sha: string;
}): string {
	const subject = Array.from(
		input.subject.replace(TEXT_CONTROLS, "").replace(/\s+/g, " ").trim(),
	)
		.slice(0, REVERT_QUOTED_SUBJECT_MAX_CHARS)
		.join("");
	const first =
		subject === "" || hasHit(subject)
			? `Revert commit ${input.sha.slice(0, 7)}`
			: `Revert "${subject}"`;
	return `${first}\n\nThis reverts commit ${input.sha}.`;
}
