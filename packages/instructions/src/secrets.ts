import { globToRegExp } from "./ignore";
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
 * same `globToRegExp`, but with an explicit any-depth prefix on every entry:
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
	re: globToRegExp(pattern),
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
		if (candidate.re.test(key)) {
			return candidate.pattern;
		}
	}
	return null;
}

// Order matters only for which rule name is reported when two match one line.
export const SECRET_RULES: ReadonlyArray<{
	id: string;
	label: string;
	pattern: RegExp;
}> = [
	{
		id: "private-key-block",
		label: "Private key block",
		pattern: /-----BEGIN (?:RSA |EC |DSA |OPENSSH |PGP )?PRIVATE KEY-----/,
	},
	{
		id: "aws-access-key",
		label: "AWS access key id",
		pattern: /\b(?:AKIA|ASIA)[0-9A-Z]{16}\b/,
	},
	{
		id: "github-token",
		label: "GitHub token",
		pattern: /\bgh[pousr]_[A-Za-z0-9]{36,}\b/,
	},
	{
		id: "slack-token",
		label: "Slack token",
		pattern: /\bxox[baprs]-[0-9]{10,}-[0-9A-Za-z-]{10,}/,
	},
	{
		id: "anthropic-key",
		label: "Anthropic API key",
		pattern: /\bsk-ant-[A-Za-z0-9_-]{20,}/,
	},
	{
		id: "openai-key",
		label: "OpenAI API key",
		pattern: /\bsk-(?:proj-)?[A-Za-z0-9_-]{20,}/,
	},
	{
		id: "google-api-key",
		label: "Google API key",
		pattern: /\bAIza[0-9A-Za-z_-]{35,}\b/,
	},
	{
		id: "jwt",
		label: "JSON Web Token",
		pattern:
			/\beyJ[A-Za-z0-9_-]{8,}\.eyJ[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{8,}\b/,
	},
	{
		id: "bearer-header",
		label: "Bearer token in a header",
		pattern: /\bBearer\s+(?!\$|\$\{|<)[A-Za-z0-9._~+/=-]{30,}\b/,
	},
	{
		id: "azure-devops-pat",
		label: "Azure DevOps personal access token",
		pattern:
			/\b(?:AZURE_DEVOPS_PAT|ADO_PAT|SYSTEM_ACCESSTOKEN|VSTS_PAT)\s*[:=]\s*["']?(?!\$|\$\{|<)[a-z0-9]{52}\b/i,
	},
	{
		id: "connection-string-password",
		label: "Password in a connection string",
		pattern: /\b(?:Password|Pwd)=(?!\$|\$\{|<)[^;\s"']{8,}/i,
	},
	{
		id: "generic-assignment",
		label: "Credential assigned inline",
		pattern:
			/(?<![A-Za-z0-9])[A-Za-z0-9_.-]*(?:api[_-]?key|secret|token|password|passwd|pat)\b\s*[:=]\s*["']?(?!\$|\$\{|<|\*\*\*|process\.env|os\.environ|\$\()[A-Za-z0-9_\-+/=]{24,}["']?\s*$/im,
	},
	{
		// The rule above needs 24 characters, which ordinary passwords rarely
		// reach. A shorter value still counts as a credential when it is at
		// least 8 characters and contains a digit: that keeps plain words
		// ("password: required", "token: expired") and the placeholders
		// excluded above out, while "password: 123abcdraja" is caught.
		id: "short-credential-assignment",
		label: "Password or key assigned inline",
		pattern:
			/(?<![A-Za-z0-9])[A-Za-z0-9_.-]*(?:api[_-]?key|secret|token|password|passwd|pat)\b\s*[:=]\s*["']?(?!\$|\$\{|<|\*\*\*|process\.env|os\.environ|\$\()(?=[A-Za-z0-9_\-+/=!@#%^&*.]*[0-9])[A-Za-z0-9_\-+/=!@#%^&*.]{8,}["']?\s*$/im,
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
			if (rule.pattern.test(line)) {
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
