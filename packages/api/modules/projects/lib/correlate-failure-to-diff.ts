/**
 * Which of the changed files plausibly broke this test.
 *
 * The honest raw material behind a red pipeline is "these 47 files changed
 * between the last run where this test passed and the run where it didn't".
 * Handed over unranked that is not evidence, it is a haystack — and it is worse
 * than useless to the model writing the root-cause hypothesis, which will
 * happily narrate a confident story about whichever file it happened to read
 * first.
 *
 * So this ranks, using the signals a person triaging actually reaches for: the
 * test's own spec file changed (nearly always the answer); a changed file's
 * name overlaps the words in the test's name; or nothing overlaps at all, in
 * which case the file is dropped rather than padded into the list. A ranked
 * list that still contains every changed file has ranked nothing.
 *
 * The rule doing the most work is the demotion of lockfile, config, docs and CI
 * churn. Those files change on almost every commit, so they correlate with
 * *every* failure — which is precisely what makes them worthless as evidence,
 * and precisely why an unweighted similarity score floats them to the top and
 * buries the one file that mattered.
 *
 * Pure and deterministic — no clock, no randomness, no I/O. The same diff and
 * the same test always produce the same ranking, so two people reading one
 * finding are reading the same suspects.
 */

/** Beyond this the list stops being a shortlist and goes back to being a diff. */
const MAX_CORRELATED_FILES = 10;

/** Below this a token is an initialism or a fragment, not a subject. */
const MIN_TOKEN_LENGTH = 3;

/** The changed file is *about* the thing under test. */
const STEM_MATCH_WEIGHT = 0.35;

/** The changed file merely lives in the right neighbourhood. */
const DIRECTORY_MATCH_WEIGHT = 0.15;

/** Ceiling for name overlap; 1 is reserved for the test's own spec file. */
const CORRELATION_CEILING = 0.9;

/**
 * What churn keeps of its score.
 *
 * Chosen so the arithmetic, not a comment, guarantees the ordering: the best a
 * churn file can reach is `CORRELATION_CEILING * CHURN_DEMOTION` = 0.09, which
 * is below the 0.15 a single directory match earns. Churn therefore cannot
 * outrank a real match however many words of the test name it happens to echo.
 */
const CHURN_DEMOTION = 0.1;

/** Words that appear in test names everywhere and so distinguish nothing. */
const STOPWORDS = [
	"and",
	"are",
	"but",
	"can",
	"case",
	"cases",
	"correctly",
	"does",
	"expect",
	"expects",
	"for",
	"from",
	"given",
	"has",
	"have",
	"into",
	"its",
	"must",
	"not",
	"returns",
	"should",
	"that",
	"the",
	"then",
	"this",
	"when",
	"will",
	"with",
];

/** Path segments that appear in every repo and so distinguish nothing. */
const PATH_NOISE = [
	"app",
	"components",
	"e2e",
	"index",
	"lib",
	"spec",
	"src",
	"test",
	"tests",
	"utils",
];

/**
 * One ignore set for both sides. A test name saying "test" and a directory
 * called `test` are the same non-signal, and keeping two lists in step would be
 * a promise nothing enforces. Tokens shorter than {@link MIN_TOKEN_LENGTH} are
 * dropped by length, so they are deliberately absent here.
 */
const IGNORED_TOKENS = new Set([...STOPWORDS, ...PATH_NOISE]);

/**
 * Files that change on almost every commit.
 *
 * The CI entries are the three paths Fabric's own pipeline templates write, so
 * a project that accepted a generated config sees its own scaffolding demoted
 * rather than blamed. Deliberately narrow otherwise: an over-broad churn list
 * hides real evidence, which is the same failure in the opposite direction.
 */
const CHURN_PATTERNS = [
	/(^|\/)package(-lock)?\.json$/,
	/(^|\/)(pnpm-lock\.yaml|yarn\.lock|bun\.lockb)$/,
	/\.md$/,
	/^\.github\//,
	/(^|\/)\.gitlab-ci\.yml$/,
	/(^|\/)azure-pipelines\.yml$/,
];

/**
 * Extensions that make a classname a file path.
 *
 * An explicit list rather than "contains a dot": JUnit reports a classname as
 * `com.acme.CheckoutSpec`, which a naive extension test would read as a file
 * called `CheckoutSpec` in a directory called `com.acme`.
 */
const SOURCE_EXTENSIONS = [
	".cjs",
	".cs",
	".go",
	".java",
	".js",
	".jsx",
	".kt",
	".mjs",
	".php",
	".py",
	".rb",
	".ts",
	".tsx",
];

export interface FailureCorrelationInput {
	/** e.g. "checkout applies the discount" */
	testName: string;
	/** e.g. "e2e/checkout.spec.ts" or "CheckoutSpec" — may be null */
	classname?: string | null;
	/** The linked test case's automation file path, when one is recorded. */
	specFilePath?: string | null;
	/** Repo-relative paths changed between baseline and failing commit. */
	changedFiles: string[];
}

export interface CorrelatedFile {
	path: string;
	/** 0..1. Higher = more likely related. */
	score: number;
	/** Why it scored — shown to a human, so it must read as a reason. */
	reason: string;
}

/**
 * POSIX separators and no leading `./`, but original case — tokenising happens
 * on this form, and case-folding first would weld `DiscountService` into one
 * unmatchable word.
 */
function toPosixPath(path: string): string {
	return path
		.trim()
		.replace(/\\/g, "/")
		.replace(/^\.?\//, "");
}

/**
 * Comparison form: case-folded on top of {@link toPosixPath}. Used only for
 * matching — the returned `path` is always the caller's original string, so it
 * still lines up with the diff it came from.
 */
function normalisePath(path: string): string {
	return toPosixPath(path).toLowerCase();
}

function tokenise(text: string): string[] {
	return (
		text
			// A JUnit classname arrives as one word — `CheckoutSpec`, never
			// `checkout spec` — so splitting on separators alone would leave the
			// commonest classname shape unmatchable against `checkout/discount.ts`.
			.replace(/([a-z0-9])([A-Z])/g, "$1 $2")
			.toLowerCase()
			.split(/[^a-z0-9]+/)
			.filter(
				(token) =>
					token.length >= MIN_TOKEN_LENGTH &&
					!IGNORED_TOKENS.has(token),
			)
	);
}

function isChurn(normalisedPath: string): boolean {
	return CHURN_PATTERNS.some((pattern) => pattern.test(normalisedPath));
}

function looksLikePath(classname: string): boolean {
	const normalised = normalisePath(classname);
	return (
		normalised.includes("/") ||
		SOURCE_EXTENSIONS.some((extension) => normalised.endsWith(extension))
	);
}

/**
 * Whether a changed file and a recorded spec path are the same file.
 *
 * Matched on a segment boundary rather than by equality: a runner reports paths
 * relative to its own working directory (`e2e/checkout.spec.ts`) while the diff
 * is relative to the repo root (`apps/web/e2e/checkout.spec.ts`). Demanding
 * equality would drop the single strongest signal there is in every monorepo.
 */
function isSameFile(changedPath: string, specPath: string): boolean {
	if (changedPath === specPath) {
		return true;
	}
	const [longer, shorter] =
		changedPath.length > specPath.length
			? [changedPath, specPath]
			: [specPath, changedPath];
	return longer.endsWith(`/${shorter}`);
}

/** Scores are read by people, so keep them to two decimals. */
function round(score: number): number {
	return Math.round(score * 100) / 100;
}

function quoteList(tokens: string[]): string {
	return tokens.map((token) => `"${token}"`).join(", ");
}

function describeOverlap(
	stemMatches: string[],
	directoryMatches: string[],
): string {
	if (stemMatches.length === 0) {
		return `Its path shares ${quoteList(directoryMatches)} with the test, though the filename does not.`;
	}
	if (directoryMatches.length === 0) {
		return `Its filename shares ${quoteList(stemMatches)} with the test.`;
	}
	return `Its filename shares ${quoteList(stemMatches)} with the test, and its path also shares ${quoteList(directoryMatches)}.`;
}

/**
 * Every word the test identifies itself by: the name a human wrote, the suite
 * it belongs to, and the automation file it is recorded against. The spec file
 * contributes here as well as to the exact-match tier, so a test whose own file
 * did not change still gets credit for the module it lives in.
 */
function collectTestTokens(input: FailureCorrelationInput): Set<string> {
	return new Set([
		...tokenise(input.testName),
		...tokenise(input.classname ?? ""),
		...tokenise(input.specFilePath ?? ""),
	]);
}

/**
 * The paths that would mean "the test's own file changed". `classname` counts
 * only when it is a path — `CheckoutSpec` is a suite name, not a file.
 */
function collectOwnSpecPaths(input: FailureCorrelationInput): string[] {
	const paths: string[] = [];
	const specFilePath = input.specFilePath?.trim();
	if (specFilePath) {
		paths.push(normalisePath(specFilePath));
	}
	const classname = input.classname?.trim();
	if (classname && looksLikePath(classname)) {
		paths.push(normalisePath(classname));
	}
	return paths;
}

function comparePaths(a: string, b: string): number {
	if (a === b) {
		return 0;
	}
	return a < b ? -1 : 1;
}

/**
 * Rank the changed files by how likely each is to have caused this failure.
 * Returns only files that scored, best first, capped at
 * {@link MAX_CORRELATED_FILES}.
 */
export function correlateFailureToDiff(
	input: FailureCorrelationInput,
): CorrelatedFile[] {
	const testTokens = collectTestTokens(input);
	const ownSpecPaths = collectOwnSpecPaths(input);
	const correlated: CorrelatedFile[] = [];

	for (const changedFile of input.changedFiles) {
		const posix = toPosixPath(changedFile);
		const normalised = posix.toLowerCase();
		if (normalised.length === 0) {
			continue;
		}

		if (ownSpecPaths.some((specPath) => isSameFile(normalised, specPath))) {
			correlated.push({
				path: changedFile,
				score: 1,
				reason: "This is the test's own spec file, and it changed between the last passing run and this failure.",
			});
			continue;
		}

		const separator = posix.lastIndexOf("/");
		const stemTokens = tokenise(posix.slice(separator + 1));
		const directoryTokens = tokenise(
			separator === -1 ? "" : posix.slice(0, separator),
		);

		const stemMatches = stemTokens.filter((token) => testTokens.has(token));
		// A word matched in the filename is not also credited to the directory —
		// `checkout/checkout.ts` overlaps on one word, not two.
		const directoryMatches = directoryTokens.filter(
			(token) => testTokens.has(token) && !stemMatches.includes(token),
		);
		if (stemMatches.length === 0 && directoryMatches.length === 0) {
			continue;
		}

		const overlap = Math.min(
			stemMatches.length * STEM_MATCH_WEIGHT +
				directoryMatches.length * DIRECTORY_MATCH_WEIGHT,
			CORRELATION_CEILING,
		);
		const churn = isChurn(normalised);
		const reason = describeOverlap(
			[...new Set(stemMatches)].sort(),
			[...new Set(directoryMatches)].sort(),
		);

		correlated.push({
			path: changedFile,
			score: round(churn ? overlap * CHURN_DEMOTION : overlap),
			reason: churn
				? `${reason} Ranked low: lockfiles, config, docs and CI files change on almost every commit, so they match every failure equally.`
				: reason,
		});
	}

	return (
		correlated
			// Ties broken on the path rather than left to sort stability, so the ranking
			// cannot depend on the engine or on the order the diff listed its files.
			.sort((a, b) => b.score - a.score || comparePaths(a.path, b.path))
			.slice(0, MAX_CORRELATED_FILES)
	);
}
