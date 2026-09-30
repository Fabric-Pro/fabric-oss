import { compileGlob, foldRegExpCase } from "./ignore";
import { canonicalKey } from "./kinds";

export type SecretHit = { rule: string; line: number };

/**
 * File names that are credential stores by construction, rejected on the
 * NAME alone — before a single byte is downloaded, and regardless of whether
 * the content scan would have found a recognizable rule hit inside.
 *
 * Content rules cannot carry this weight on their own. A `.env` holding
 * `DB_PASSWORD=hunter2` matches no rule in `SECRET_RULES` (too short, no
 * recognizable prefix), a DER-encoded `.p12` or `.kdbx` is not text at all,
 * and a `.pem` holding a certificate *chain* is indistinguishable from one
 * holding a key until you parse it. None of those belong in a snapshot that
 * is then served to every coding agent on the project, so the name is
 * treated as sufficient grounds by itself.
 *
 * Written in the same glob syntax as the ignore layers and compiled with the
 * same `compileGlob`, but with an explicit any-depth prefix on every entry:
 * unlike an ignore rule, which is a user's statement about their own tree
 * layout, a credential file is exactly as dangerous nested three directories
 * down as it is at the root.
 */
export const SECRET_FILE_PATTERNS: readonly string[] = [
	"**/.env",
	"**/.env.*",
	"**/*.pem",
	"**/*.key",
	"**/*.p12",
	"**/*.pfx",
	"**/*.jks",
	"**/*.kdbx",
	"**/.netrc",
	"**/.npmrc",
	"**/.pypirc",
	"**/id_rsa",
	"**/id_dsa",
	"**/id_ecdsa",
	"**/id_ed25519",
];

const COMPILED_SECRET_FILE_PATTERNS = SECRET_FILE_PATTERNS.map((pattern) => ({
	pattern,
	matcher: compileGlob(pattern),
}));

/**
 * The first `SECRET_FILE_PATTERNS` entry this path matches, or null.
 *
 * Returns the PATTERN, never the path: callers persist the result as a
 * rejection detail, and a pattern is a stable rule id while a path is user
 * content.
 */
/**
 * Committed templates that document variable names, never values.
 *
 * SUFFIX semantics, deliberately, not an exact set of four file names:
 * `.env.production.example` and `.env.credentials.dist` are exempt too. A
 * template is a template whatever environment it describes, and teams name
 * them per environment as a matter of course; matching only the bare
 * `.env.example` would reject the per-environment ones on their name alone and
 * teach people that the tab refuses ordinary repositories.
 *
 * What the exemption costs, stated plainly: it is a name-gate exemption only.
 * The file is still downloaded, still hashed, and still run through
 * `scanTextForSecrets` like every other text file, so anything the rules
 * recognize in it is still a rejection. What escapes is a value no rule
 * recognizes — a short application password, say — sitting in a file someone
 * named `.env.production.example`. That is the same exposure as the same value
 * in `notes.md`, which the name gate has never covered either; the name gate
 * exists for files that are credential stores BY CONSTRUCTION, and a committed
 * template is by construction the opposite.
 *
 * The suffix must follow a `.env.` prefix, so `.env` itself and
 * `.env.production` are still rejected — only a name that ANNOUNCES itself as a
 * template is exempt.
 */
const ENV_TEMPLATE_SUFFIXES = [".example", ".sample", ".template", ".dist"];

export function isSecretFileName(path: string): string | null {
	const key = canonicalKey(path);
	const base = key.slice(key.lastIndexOf("/") + 1);
	if (
		base.startsWith(".env.") &&
		ENV_TEMPLATE_SUFFIXES.some((suffix) => base.endsWith(suffix))
	) {
		return null;
	}
	for (const candidate of COMPILED_SECRET_FILE_PATTERNS) {
		if (candidate.matcher.test(key)) {
			return candidate.pattern;
		}
	}
	return null;
}

type SecretRule = {
	id: string;
	label: string;
	matches: (line: string) => boolean;
};

const fromPattern = (
	id: string,
	label: string,
	pattern: RegExp,
): SecretRule => ({ id, label, matches: (line) => pattern.test(line) });

const WHITESPACE = /\s/;
const WORD_CHAR = /[A-Za-z0-9_]/;

/** What a RegExp's `$` accepts under the `m` flag, besides the end of input. */
function isLineTerminator(char: string): boolean {
	return char === "\n" || char === "\r" || char === " " || char === " ";
}

function isAssignmentSeparator(char: string): boolean {
	return char === ":" || char === "=";
}

function isQuote(char: string): boolean {
	return char === '"' || char === "'";
}

/**
 * The words that make an assignment a credential assignment, upper-cased, in
 * the spelling `foldRegExpCase` produces: `api[_-]?key|secret|token|password|
 * passwd|pat`, matched case-insensitively.
 */
const ASSIGNMENT_KEYWORDS: readonly string[] = [
	"API_KEY",
	"API-KEY",
	"APIKEY",
	"SECRET",
	"TOKEN",
	"PASSWORD",
	"PASSWD",
	"PAT",
];

/** Placeholders a value must not start with: `$`, `<`, `***`, `process.env`, `os.environ`. */
const PLACEHOLDER_PREFIXES: readonly string[] = [
	"$",
	"<",
	"***",
	"PROCESS.ENV",
	"OS.ENVIRON",
];

function textAtMatches(text: string, index: number, upper: string): boolean {
	if (index + upper.length > text.length) {
		return false;
	}
	for (let i = 0; i < upper.length; i++) {
		if (foldRegExpCase(text.charAt(index + i)) !== upper.charAt(i)) {
			return false;
		}
	}
	return true;
}

function startsWithPlaceholder(line: string, index: number): boolean {
	return PLACEHOLDER_PREFIXES.some((prefix) =>
		textAtMatches(line, index, prefix),
	);
}

/** The index before any run of whitespace that ends at `index`. */
function skipWhitespaceBackward(line: string, index: number): number {
	let i = index;
	while (i > 0 && WHITESPACE.test(line.charAt(i - 1))) {
		i--;
	}
	return i;
}

/** Whether a credential keyword, then optional whitespace, ends at `index`. */
function keywordPrecedes(line: string, index: number): boolean {
	const end = skipWhitespaceBackward(line, index);
	return ASSIGNMENT_KEYWORDS.some((keyword) =>
		textAtMatches(line, end - keyword.length, keyword),
	);
}

type AssignmentShape = {
	valueChars: Uint8Array;
	minLength: number;
	requiresDigit: boolean;
};

/** One flag per ASCII code: a scan over megabytes must not run a RegExp per character. */
function asciiTable(pattern: RegExp): Uint8Array {
	const table = new Uint8Array(128);
	for (let code = 0; code < 128; code++) {
		table[code] = pattern.test(String.fromCharCode(code)) ? 1 : 0;
	}
	return table;
}

const LONG_ASSIGNMENT: AssignmentShape = {
	valueChars: asciiTable(/[A-Za-z0-9_\-+/=]/),
	minLength: 24,
	requiresDigit: false,
};

const SHORT_ASSIGNMENT: AssignmentShape = {
	valueChars: asciiTable(/[A-Za-z0-9_\-+/=!@#%^&*.]/),
	minLength: 8,
	requiresDigit: true,
};

function isValueChar(shape: AssignmentShape, line: string, index: number) {
	return shape.valueChars[line.charCodeAt(index)] === 1;
}

/**
 * Whether a credential assignment ends its line at `end` (the end of input,
 * or a line terminator).
 *
 * This replaces two regular expressions of the form
 *
 *   (?<![A-Za-z0-9])[A-Za-z0-9_.-]*(?:KEYWORD)\b\s*[:=]\s*["']?(?!PLACEHOLDER)
 *   VALUE{min,}["']?\s*$     (flags: im)
 *
 * which were quadratic on one long line: a match may only end at the end of
 * the line, so every keyword occurrence re-walked the whole run of value
 * characters after it, and the unbounded identifier prefix was re-walked from
 * every start. Both exist only to be satisfied, never to be reported, and the
 * verdict they give is this, which costs one pass over each line segment:
 *
 *  - The prefix and the look-behind add nothing. For a keyword at any index,
 *    the start of the maximal `[A-Za-z0-9_.-]` run around it satisfies the
 *    look-behind (the character before a maximal run is not in the run's
 *    class, and every member of that class but `_ . -` is alphanumeric, and
 *    those are excluded by the run being maximal), and the prefix then spans
 *    the rest of the run. So only the keyword followed by `\b` matters, and
 *    `\b` holds wherever the keyword is followed by whitespace or a
 *    separator, since a keyword ends in a word character.
 *  - `["']?\s*$` pins the match to a line end. The value therefore ends at
 *    the trailing whitespace of a segment with one optional quote removed,
 *    and is a suffix of the maximal run of value characters that ends there.
 *    Under the `m` flag a lone `\r`, U+2028 or U+2029 ends a line too, so the
 *    segments are split on those as well.
 *  - A value's start is either the start of that run, preceded by an optional
 *    quote, whitespace and a separator, or it follows a `=` inside the run
 *    (the long class contains `=`), with the keyword and whitespace
 *    before that `=`. Nothing else can precede a value character.
 */
function endsWithCredentialAssignment(
	line: string,
	end: number,
	shape: AssignmentShape,
): boolean {
	let trimmed = end;
	while (
		trimmed > 0 &&
		WHITESPACE.test(line.charAt(trimmed - 1)) &&
		!isLineTerminator(line.charAt(trimmed - 1))
	) {
		trimmed--;
	}
	const valueEnd =
		trimmed > 0 && isQuote(line.charAt(trimmed - 1))
			? trimmed - 1
			: trimmed;
	let runStart = valueEnd;
	while (runStart > 0 && isValueChar(shape, line, runStart - 1)) {
		runStart--;
	}
	if (valueEnd - runStart < shape.minLength) {
		return false;
	}
	let lastDigit = -1;
	if (shape.requiresDigit) {
		for (let i = valueEnd - 1; i >= runStart; i--) {
			const code = line.charCodeAt(i);
			if (code >= 48 && code <= 57) {
				lastDigit = i;
				break;
			}
		}
		if (lastDigit < 0) {
			return false;
		}
	}
	const valueFrom = (start: number) =>
		!startsWithPlaceholder(line, start) &&
		lastDigit >= (shape.requiresDigit ? start : -1);

	const beforeRun =
		runStart > 0 && isQuote(line.charAt(runStart - 1))
			? [runStart, runStart - 1]
			: [runStart];
	for (const at of beforeRun) {
		const separator = skipWhitespaceBackward(line, at) - 1;
		if (
			separator >= 0 &&
			isAssignmentSeparator(line.charAt(separator)) &&
			keywordPrecedes(line, separator) &&
			valueFrom(runStart)
		) {
			return true;
		}
	}
	for (let q = runStart; q <= valueEnd - shape.minLength - 1; q++) {
		if (
			line.charAt(q) === "=" &&
			keywordPrecedes(line, q) &&
			valueFrom(q + 1)
		) {
			return true;
		}
	}
	return false;
}

function matchesCredentialAssignment(
	line: string,
	shape: AssignmentShape,
): boolean {
	let end = 0;
	for (;;) {
		while (end < line.length && !isLineTerminator(line.charAt(end))) {
			end++;
		}
		if (endsWithCredentialAssignment(line, end, shape)) {
			return true;
		}
		if (end >= line.length) {
			return false;
		}
		end++;
	}
}

const isBase64UrlChar = (char: string) => /[A-Za-z0-9_-]/.test(char);

/**
 * `\beyJ[A-Za-z0-9_-]{8,}\.eyJ[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{8,}\b`, without
 * its quadratic case: every `eyJ` start inside one long run (`eyJ-eyJ-...`)
 * re-walked that run to the same `.`. Anchoring on the `.eyJ` between the
 * header and the payload visits each run once.
 */
function matchesJwt(line: string): boolean {
	let from = 0;
	for (;;) {
		const dot = line.indexOf(".eyJ", from);
		if (dot < 0) {
			return false;
		}
		from = dot + 1;
		if (jwtAround(line, dot)) {
			return true;
		}
	}
}

function jwtAround(line: string, dot: number): boolean {
	let headerStart = dot;
	while (headerStart > 0 && isBase64UrlChar(line.charAt(headerStart - 1))) {
		headerStart--;
	}
	let hasHeader = false;
	for (let s = headerStart; s <= dot - 11; s++) {
		if (
			line.startsWith("eyJ", s) &&
			(s === 0 || !WORD_CHAR.test(line.charAt(s - 1)))
		) {
			hasHeader = true;
			break;
		}
	}
	if (!hasHeader) {
		return false;
	}
	const payloadStart = dot + 4;
	let payloadEnd = payloadStart;
	while (
		payloadEnd < line.length &&
		isBase64UrlChar(line.charAt(payloadEnd))
	) {
		payloadEnd++;
	}
	if (payloadEnd - payloadStart < 8 || line.charAt(payloadEnd) !== ".") {
		return false;
	}
	const signatureStart = payloadEnd + 1;
	let signatureEnd = signatureStart;
	while (
		signatureEnd < line.length &&
		isBase64UrlChar(line.charAt(signatureEnd))
	) {
		signatureEnd++;
	}
	for (let e = signatureStart + 8; e <= signatureEnd; e++) {
		const before = WORD_CHAR.test(line.charAt(e - 1));
		const after = e < line.length && WORD_CHAR.test(line.charAt(e));
		if (before !== after) {
			return true;
		}
	}
	return false;
}

// Order matters only for which rule name is reported when two match one line.
export const SECRET_RULES: ReadonlyArray<SecretRule> = [
	fromPattern(
		"private-key-block",
		"Private key block",
		/-----BEGIN (?:RSA |EC |DSA |OPENSSH |PGP )?PRIVATE KEY-----/,
	),
	fromPattern(
		"aws-access-key",
		"AWS access key id",
		/\b(?:AKIA|ASIA)[0-9A-Z]{16}\b/,
	),
	fromPattern(
		"github-token",
		"GitHub token",
		/\bgh[pousr]_[A-Za-z0-9]{36,}\b/,
	),
	fromPattern(
		"slack-token",
		"Slack token",
		/\bxox[baprs]-[0-9]{10,}-[0-9A-Za-z-]{10,}/,
	),
	fromPattern(
		"anthropic-key",
		"Anthropic API key",
		/\bsk-ant-[A-Za-z0-9_-]{20,}/,
	),
	fromPattern(
		"openai-key",
		"OpenAI API key",
		/\bsk-(?:proj-)?[A-Za-z0-9_-]{20,}/,
	),
	fromPattern(
		"google-api-key",
		"Google API key",
		/\bAIza[0-9A-Za-z_-]{35,}\b/,
	),
	{ id: "jwt", label: "JSON Web Token", matches: matchesJwt },
	fromPattern(
		"bearer-header",
		"Bearer token in a header",
		/\bBearer\s+(?!\$|\$\{|<)[A-Za-z0-9._~+/=-]{30,}\b/,
	),
	fromPattern(
		"azure-devops-pat",
		"Azure DevOps personal access token",
		/\b(?:AZURE_DEVOPS_PAT|ADO_PAT|SYSTEM_ACCESSTOKEN|VSTS_PAT)\s*[:=]\s*["']?(?!\$|\$\{|<)[a-z0-9]{52}\b/i,
	),
	fromPattern(
		"connection-string-password",
		"Password in a connection string",
		/\b(?:Password|Pwd)=(?!\$|\$\{|<)[^;\s"']{8,}/i,
	),
	{
		id: "generic-assignment",
		label: "Credential assigned inline",
		matches: (line) => matchesCredentialAssignment(line, LONG_ASSIGNMENT),
	},
	{
		// The rule above needs 24 characters, which ordinary passwords rarely
		// reach. A shorter value still counts as a credential when it is at
		// least 8 characters and contains a digit: that keeps plain words
		// ("password: required", "token: expired") and the placeholders
		// excluded above out, while "password: 123abcdraja" is caught.
		id: "short-credential-assignment",
		label: "Password or key assigned inline",
		matches: (line) => matchesCredentialAssignment(line, SHORT_ASSIGNMENT),
	},
];

/** A bounded scan's result: the hits it kept, and how many it found in all. */
export type SecretScan = { hits: SecretHit[]; total: number };

/**
 * One hit per matching line: the first rule that matches it, with its
 * 1-based line number — never the matched text.
 *
 * With `limit`, the scan keeps at most that many hits and only COUNTS the
 * rest (`total`). That is the bound a caller holding a budget needs: a dense
 * file — a credential assignment on every short line of a few megabytes —
 * would otherwise materialise hundreds of thousands of hit objects before
 * any cap downstream could drop them, and a worker scanning several such
 * files can run out of memory on every retry. `limit` may be 0, which still
 * answers whether the text has any hit at all, and how many. Without it the
 * scan keeps every hit, as it always has, for callers whose input is small.
 *
 * The overload without `limit` is declared LAST on purpose: `Parameters<>`
 * and `ReturnType<>` read the last signature, so a mock typed from this
 * function (`vi.mocked(scanTextForSecrets)`) keeps the original shape.
 */
export function scanTextForSecrets(
	text: string,
	options: { limit: number },
): SecretScan;
export function scanTextForSecrets(text: string): SecretHit[];
export function scanTextForSecrets(
	text: string,
	options?: { limit: number },
): SecretHit[] | SecretScan {
	const limit = options
		? Math.max(0, options.limit)
		: Number.POSITIVE_INFINITY;
	const hits: SecretHit[] = [];
	let total = 0;
	const lines = text.split(/\r?\n/);
	for (const [index, line] of lines.entries()) {
		for (const rule of SECRET_RULES) {
			if (rule.matches(line)) {
				total++;
				if (hits.length < limit) {
					hits.push({ rule: rule.id, line: index + 1 });
				}
				break;
			}
		}
	}
	return options ? { hits, total } : hits;
}
