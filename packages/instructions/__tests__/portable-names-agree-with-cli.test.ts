/**
 * The server and the CLI must refuse the same FILE NAMES.
 *
 * These are two separate implementations on purpose. `@fabricorg/cli` is
 * published to npm and `@repo/instructions` is private, so the CLI cannot
 * import this package and carries its own copy of the portable-name rules and
 * the collision key. That is a deliberate duplication, and duplication drifts.
 *
 * What drift costs here is asymmetric, which is why this test exists rather
 * than a comment. A name the SERVER accepts and the CLI refuses produces a
 * published version that stores fine and then refuses to install — as a whole
 * manifest, for everyone who pulls it, with no way to fix it from the CLI. A
 * name the CLI accepts and the server refuses is a push that fails with a
 * confusing message. Both are contract bugs; only the first is a trap.
 *
 * Scope is NAMES, not whole-path syntax, because the two guards legitimately
 * differ there: the server NORMALISES separators, `./` prefixes and repeated
 * slashes (a browser folder upload on Windows hands it `\\`), while the CLI
 * refuses them outright, since by then the string is about to become a write
 * on somebody's disk and normalising a hostile path is how traversal gets in.
 *
 * The CLI module is imported by relative path: adding `@repo/instructions` to
 * the CLI's manifest — even as a devDependency — is what must not happen.
 */

import { describe, expect, it } from "vitest";
import {
	checkRelativePath,
	collisionKey as cliCollisionKey,
} from "../../cli/src/lib/instructions/paths";
import {
	collisionKey,
	validatePortableName,
	validateRelativePath,
} from "../src/paths";

/** Names both sides must ACCEPT. */
const PORTABLE = [
	"AGENTS.md",
	"CLAUDE.md",
	"SKILL.md",
	// A space INSIDE a name is fine; only a trailing one is not.
	"getting started.md",
	// Non-ASCII is fine. It is the two SPELLINGS of it that collide.
	"café.md",
	// Only COM1..COM9 are devices. COM10 is an ordinary name, and refusing it
	// would be a rule the CLI and the server could drift on in the quiet
	// direction.
	"COM10.md",
	// Starts with the letters of a device name and is not one.
	"connection.md",
	"nullable.ts",
	// Characters that LOOK risky and are perfectly legal: refusing them
	// would be a rule the two sides could drift on in the quiet direction.
	"a'b.md",
	"a(b).md",
	"a[b].md",
	"a&b.md",
	"a#b.md",
	"a%b.md",
	"a,b.md",
	"a;b.md",
	"a=b.md",
	"a+b.md",
	"a!b.md",
	"@scoped-rule.md",
	"a$b.md",
	"a~b.md",
	"a^b.md",
	"a`b.md",
	"a{b}.md",
];

/** Names both sides must REFUSE. */
const UNPORTABLE = [
	// Windows device names, with and without an extension, any case.
	"CON.md",
	"nul.txt",
	"NUL",
	"com1",
	"LPT9.md",
	"AUX",
	"prn.json",
	// Windows strips these, so the name opens a different file.
	"AGENTS.md.",
	"AGENTS.md ",
	// Every character Windows refuses in a filename. A colon also addresses
	// an NTFS alternate data stream, which is a write to a file nobody named.
	"AGENTS.md:stream",
	"a<b.md",
	"a>b.md",
	'a"b.md',
	"a|b.md",
	"a?b.md",
	"a*b.md",
	// Traversal and emptiness, for completeness: the two sides agree here
	// already and this is what stops that agreement being lost silently.
	"..",
	".",
	"",
];

/**
 * Does the SERVER accept this name, on its own and nested?
 *
 * Both halves, because the CLI's single `checkRelativePath` answers both
 * questions at once while the server asks them separately — structurally on
 * the way in, portably about the files a version will actually keep.
 */
function serverAccepts(name: string): boolean {
	const own = validateRelativePath(name);
	const nested = validateRelativePath(`docs/${name}`);
	return (
		own.ok &&
		nested.ok &&
		validatePortableName(own.path).ok &&
		validatePortableName(nested.path).ok
	);
}

/** Does the CLI accept this name, on its own and nested? */
function cliAccepts(name: string): boolean {
	return checkRelativePath(name).ok && checkRelativePath(`docs/${name}`).ok;
}

describe("portable file names", () => {
	it.each(PORTABLE)("both sides accept %j", (name) => {
		expect(serverAccepts(name)).toBe(true);
		expect(cliAccepts(name)).toBe(true);
	});

	it.each(UNPORTABLE)("both sides refuse %j", (name) => {
		expect(serverAccepts(name)).toBe(false);
		expect(cliAccepts(name)).toBe(false);
	});
});

describe("collision key", () => {
	// The pair lowercasing alone does not catch: same name, two Unicode
	// normalisations, one file on macOS.
	const NFC = "café.md";
	const NFD = "café.md";

	it("is the same function on both sides", () => {
		for (const input of [...PORTABLE, NFC, NFD, "README.md"]) {
			expect(collisionKey(input)).toBe(cliCollisionKey(input));
		}
	});

	it("gives the two spellings of one file the same key", () => {
		expect(NFC).not.toBe(NFD);
		expect(collisionKey(NFC)).toBe(collisionKey(NFD));
	});

	it("still folds case", () => {
		expect(collisionKey("README.md")).toBe(collisionKey("readme.md"));
	});
});
