/**
 * The derive transaction and the folder upload must refuse the same TREES.
 *
 * `createInstructionTreeGuard` in `prisma/queries/instructions.ts` is a copy
 * of `createTreeCollisionGuard` in `packages/instructions/src/paths.ts`,
 * because this package does not depend on `@repo/instructions` and the
 * check has to run inside the transaction that sees the base's rows. Same
 * arrangement as the CLI's copy of the portable-name rules, and the same
 * asymmetric cost if the two drift: a tree the DERIVE path accepts and the
 * upload path refuses is a published version that installs for nobody, and
 * only the derive path can produce it — a single-file edit against a base
 * the upload path never saw as a whole.
 *
 * So every sequence below is run through both guards and the verdicts are
 * compared step by step. The canonical module is imported by relative path
 * on purpose: adding `@repo/instructions` to this package's manifest — even
 * as a devDependency — is what must not happen.
 */

import { describe, expect, it, vi } from "vitest";
import {
	createTreeCollisionGuard,
	type TreeCollision,
} from "../../instructions/src/paths";

// `instructions.ts` pulls in the Prisma client module. Its client is lazy,
// but the mock keeps this test free of generated-client and adapter imports
// it does not exercise.
vi.mock("../prisma/client", () => ({
	db: {},
	Prisma: { PrismaClientKnownRequestError: class extends Error {} },
}));

import { createInstructionTreeGuard } from "../prisma/queries/instructions";

/**
 * Path sequences, in the order they are added. Each one exercises a rule
 * the two guards could drift on: file over directory, directory over file,
 * a deep prefix, a name prefix that is NOT a directory, key folding on a
 * directory name, an exact duplicate, and a refused path that must NOT be
 * recorded (so the path after it is judged against the tree without it).
 */
const SEQUENCES: string[][] = [
	["docs/a.md", "docs"],
	["docs", "docs/a.md"],
	[".claude/agents", ".claude/agents/a.md"],
	[".claude/agents/a.md", ".claude/agents"],
	["docs/a.md", "docs.md", "doc", "do"],
	["Docs/a.md", "docs"],
	["docs", "DOCS/a.md"],
	["café/a.md", "café"],
	["CLAUDE.md", "claude.md"],
	// Accepted, refused, valid: `docs` is refused and therefore not a file,
	// so `docs/b.md` still joins the tree.
	["docs/a.md", "docs", "docs/b.md"],
	// Accepted, refused, refused: `docs` IS a file, so both descendants fail.
	["docs", "docs/a.md", "docs/b.md"],
	// A refused duplicate leaves the first spelling as the directory owner.
	["docs/a.md", "Docs/A.md", "docs"],
	// So does a second file under the same directory: the FIRST file that
	// made `docs` a directory is the one the conflict is reported against.
	["docs/a.md", "docs/b.md", "docs"],
	["a/b/c/d.md", "a/b/c", "a/b", "a", "a/b/c/d.md"],
];

/** The canonical guard's verdict, reduced to what both guards report. */
function canonical(collision: TreeCollision | null) {
	if (collision === null) {
		return null;
	}
	return collision.kind === "duplicate"
		? { kind: "duplicate" }
		: { kind: "file-directory", conflictsWith: collision.conflictsWith };
}

/** This package's verdict, reduced the same way. */
function local(
	conflict: ReturnType<ReturnType<typeof createInstructionTreeGuard>["put"]>,
) {
	if (conflict === null) {
		return null;
	}
	return conflict.kind === "duplicate"
		? { kind: "duplicate" }
		: { kind: "file-directory", conflictsWith: conflict.conflictsWith };
}

describe("createInstructionTreeGuard agrees with createTreeCollisionGuard", () => {
	it.each(SEQUENCES)("judges %j alike as a sequence of puts", (...paths) => {
		const theirs = createTreeCollisionGuard();
		const ours = createInstructionTreeGuard();

		expect(paths.map((p) => local(ours.put(p)))).toEqual(
			paths.map((p) => canonical(theirs.add(p))),
		);
	});

	// An inherited row is recorded without being checked, which the
	// canonical guard has no notion of. Where the base is itself a valid
	// tree — every row accepted by the canonical guard — recording it must
	// leave a put judged exactly as the canonical guard judges the same
	// path added last.
	it.each(
		SEQUENCES.filter((paths) => {
			const guard = createTreeCollisionGuard();
			return paths.slice(0, -1).every((p) => guard.add(p) === null);
		}),
	)("judges the last of %j alike when the rest is inherited", (...paths) => {
		const base = paths.slice(0, -1);
		const candidate = paths[paths.length - 1] as string;

		const theirs = createTreeCollisionGuard();
		for (const p of base) {
			theirs.add(p);
		}
		const ours = createInstructionTreeGuard();
		for (const p of base) {
			ours.inherit(p);
		}

		expect(local(ours.put(candidate))).toEqual(
			canonical(theirs.add(candidate)),
		);
	});

	it("does not record a refused put, so a later valid path is still accepted", () => {
		const ours = createInstructionTreeGuard();
		expect(ours.put("docs/a.md")).toBeNull();
		expect(ours.put("docs")).toMatchObject({ kind: "file-directory" });
		expect(ours.put("docs/b.md")).toBeNull();
	});
});
