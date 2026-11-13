/**
 * Confidential-term filter for outbound web research.
 *
 * Text the document generator sends to a search or page-reading provider must
 * not name the organization, the project or its client. The endpoint builds a
 * matcher from those names (`load-confidential-terms.ts`) and refuses any
 * query or URL the matcher hits. A refusal names the kind of match, never the
 * matched value.
 *
 * Matching rules:
 * - text and terms are folded the same way: compatibility-normalized,
 *   lower-cased, accents and invisible format characters removed, so
 *   "Crème" matches "creme" and a zero-width space hides nothing;
 * - a match has no letter or digit directly before or after it, so "Fabric"
 *   does not match "fabrication";
 * - a name's words are its runs of letters and digits; a multi-word name
 *   matches as a phrase whose words may be separated by anything else
 *   ("Contoso, Inc." matches "contoso inc" and "contoso/inc"), and also
 *   written together ("Example Org" matches "exampleorg");
 * - a single word, or a name written together, shorter than five letters is
 *   ignored, so a short name does not block ordinary words;
 * - a domain matches literally, as itself or as the end of a subdomain.
 */

export type ConfidentialTermKind =
	| "organization_name"
	| "organization_slug"
	| "project_name"
	| "client_name"
	| "client_domain"
	| "member_email_domain";

export interface ConfidentialTermSources {
	organizationName?: string | null;
	organizationSlug?: string | null;
	projectName?: string | null;
	clientName?: string | null;
	/** The client's website, as stored (`https://host`) or a bare host. */
	clientWebsite?: string | null;
	memberEmails?: readonly (string | null | undefined)[];
}

export type ConfidentialMatcher = readonly {
	kind: ConfidentialTermKind;
	pattern: RegExp;
}[];

const MIN_TERM_LENGTH = 5;

/**
 * Mail providers anyone can sign up with. A member's address there says
 * nothing about the organization, and blocking the domain would refuse
 * ordinary queries that mention it.
 */
const PUBLIC_MAIL_DOMAINS: ReadonlySet<string> = new Set([
	"aol.com",
	"fastmail.com",
	"gmail.com",
	"gmx.com",
	"gmx.net",
	"googlemail.com",
	"hey.com",
	"hotmail.com",
	"icloud.com",
	"live.com",
	"mac.com",
	"mail.com",
	"me.com",
	"msn.com",
	"outlook.com",
	"pm.me",
	"proton.me",
	"protonmail.com",
	"tutanota.com",
	"yahoo.com",
	"yandex.com",
	"yandex.ru",
	"ymail.com",
	"zoho.com",
]);

const NAME_BOUNDARY_BEFORE = "(?<![\\p{L}\\p{N}])";
const NAME_BOUNDARY_AFTER = "(?![\\p{L}\\p{N}])";
// A hyphen continues a host label, so "my-example.com" is another domain.
const DOMAIN_BOUNDARY_BEFORE = "(?<![\\p{L}\\p{N}-])";
const DOMAIN_BOUNDARY_AFTER = "(?![\\p{L}\\p{N}-])";
const WORD_SEPARATOR = "[^\\p{L}\\p{N}]+";
const WORD_SPLIT = new RegExp(WORD_SEPARATOR, "u");

function normalize(text: string): string {
	return text
		.normalize("NFKD")
		.replace(/[\p{M}\p{Cf}]+/gu, "")
		.normalize("NFKC")
		.toLowerCase();
}

// The `u` flag rejects needless escapes such as `\-`, so only syntax
// characters are escaped.
function escapeRegExp(text: string): string {
	return text.replace(/[.*+?^${}()|[\]\\/]/g, "\\$&");
}

function namePatterns(name: string | null | undefined): string[] {
	if (!name) {
		return [];
	}
	const words = normalize(name)
		.split(WORD_SPLIT)
		.filter((word) => word.length > 0);
	const joined = words.join("");
	// Words hold only letters and digits, so they need no regex escaping.
	const bodies: string[] = [];
	if (words.length > 1) {
		bodies.push(words.join(WORD_SEPARATOR));
	}
	// The length floor keeps a short single word, or a short name written
	// together, from blocking ordinary words; a phrase is distinctive anyway.
	if (joined.length >= MIN_TERM_LENGTH) {
		bodies.push(joined);
	}
	return bodies.map(
		(body) => `${NAME_BOUNDARY_BEFORE}${body}${NAME_BOUNDARY_AFTER}`,
	);
}

function normalizeDomain(domain: string | null | undefined): string | null {
	if (!domain) {
		return null;
	}
	const host = normalize(domain.trim())
		.replace(/\.$/, "")
		.replace(/^www\./, "");
	return host.includes(".") && host.length >= MIN_TERM_LENGTH ? host : null;
}

function domainPattern(domain: string): string {
	return `${DOMAIN_BOUNDARY_BEFORE}${escapeRegExp(domain)}${DOMAIN_BOUNDARY_AFTER}`;
}

function websiteHost(website: string | null | undefined): string | null {
	if (!website) {
		return null;
	}
	const value = website.trim();
	for (const candidate of [value, `https://${value}`]) {
		try {
			return normalizeDomain(new URL(candidate).hostname);
		} catch {
			// Not a URL as stored; try it as a bare host.
		}
	}
	return null;
}

function emailDomain(email: string | null | undefined): string | null {
	const at = email?.lastIndexOf("@") ?? -1;
	if (!email || at < 0) {
		return null;
	}
	const domain = normalizeDomain(email.slice(at + 1));
	return domain && !PUBLIC_MAIL_DOMAINS.has(domain) ? domain : null;
}

export function buildConfidentialMatcher(
	sources: ConfidentialTermSources,
): ConfidentialMatcher {
	const entries: { kind: ConfidentialTermKind; source: string }[] = [];
	const addNames = (kind: ConfidentialTermKind, name?: string | null) => {
		for (const source of namePatterns(name)) {
			entries.push({ kind, source });
		}
	};
	const addDomain = (kind: ConfidentialTermKind, domain: string | null) => {
		if (domain) {
			entries.push({ kind, source: domainPattern(domain) });
		}
	};

	addNames("organization_name", sources.organizationName);
	addNames("organization_slug", sources.organizationSlug);
	addNames("project_name", sources.projectName);
	addNames("client_name", sources.clientName);
	addDomain("client_domain", websiteHost(sources.clientWebsite));
	for (const email of sources.memberEmails ?? []) {
		addDomain("member_email_domain", emailDomain(email));
	}

	const seen = new Set<string>();
	return entries
		.filter(({ source }) => {
			if (seen.has(source)) {
				return false;
			}
			seen.add(source);
			return true;
		})
		.map(({ kind, source }) => ({
			kind,
			pattern: new RegExp(source, "u"),
		}));
}

const MAX_DECODE_PASSES = 3;

/**
 * `text` with its percent-escapes undone, so an encoded name is still found.
 * Each run of escapes is decoded on its own, and a run that is not valid
 * UTF-8 still has its ASCII escapes decoded, so one stray "%" cannot keep
 * the rest encoded. A few passes undo double encoding ("%2520").
 */
function percentDecoded(text: string): string {
	let current = text;
	for (let pass = 0; pass < MAX_DECODE_PASSES; pass++) {
		const next = current.replace(/(?:%[0-9a-f]{2})+/gi, (run) => {
			try {
				return decodeURIComponent(run);
			} catch {
				return run.replace(/%([0-7][0-9a-f])/gi, (_, hex: string) =>
					String.fromCharCode(Number.parseInt(hex, 16)),
				);
			}
		});
		if (next === current) {
			break;
		}
		current = next;
	}
	return current;
}

/**
 * The kind of the first confidential term found in `text`, as written or
 * percent-decoded, or null.
 */
export function findConfidentialMatch(
	text: string,
	matcher: ConfidentialMatcher,
): ConfidentialTermKind | null {
	const variants = new Set([
		normalize(text),
		normalize(percentDecoded(text)),
	]);
	for (const { kind, pattern } of matcher) {
		for (const variant of variants) {
			if (pattern.test(variant)) {
				return kind;
			}
		}
	}
	return null;
}
