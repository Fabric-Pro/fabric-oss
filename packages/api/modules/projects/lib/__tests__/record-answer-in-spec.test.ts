import { beforeEach, describe, expect, it, vi } from "vitest";

/**
 * Only the Prisma client singleton is faked. `recordAnswerInSpec`,
 * `updateStoryDescriptionUnderLock` and `updateStory` all run for real against
 * it, so the concurrency assertions below exercise the production call
 * sequence — the lock statement, the re-read and the compare-and-set — rather
 * than a re-statement of it. Everything else `@repo/database` exports is kept.
 */
const { dbMock } = vi.hoisted(() => ({
	dbMock: { $transaction: vi.fn() },
}));

vi.mock("@repo/database/prisma/client", async (importOriginal) => ({
	...(await importOriginal<Record<string, unknown>>()),
	db: dbMock,
}));

import {
	appendPendingDecision,
	countPendingDecisions,
	PENDING_DECISIONS_HEADING,
	recordAnswerInSpec,
} from "../record-answer-in-spec";

// The decoration the editor emits when a user highlights / bolds / demotes the
// appendix heading. Derived from the shared constant so a wording change to the
// heading can't leave these fixtures silently testing a stale string.
const HEADING_TEXT = PENDING_DECISIONS_HEADING.replace(/^#+\s+/, "");
const HIGHLIGHTED_HEADING = `## <mark data-color="#fef08a">${HEADING_TEXT}</mark>`;
const BOLDED_HEADING = `## **${HEADING_TEXT}**`;
const DEMOTED_HEADING = `### ${HEADING_TEXT}`;

/**
 * Every heading line that reads as the pending-decisions appendix, decoration
 * and demotion included — so a "did we stamp a duplicate?" assertion can't be
 * fooled by the very markup that caused the duplicate.
 */
function headingLines(markdown: string): string[] {
	return markdown
		.split("\n")
		.filter((line) => /^#{2,6} .*Resolved Decisions/.test(line));
}

describe("appendPendingDecision", () => {
	it("creates the pending-decisions section when absent", () => {
		const out = appendPendingDecision(
			"# Feature\n\nSome body.",
			"Should MFA be mandatory?",
			"Yes, mandatory for all.",
		);
		expect(out).toContain("# Feature\n\nSome body.");
		expect(out).toContain(PENDING_DECISIONS_HEADING);
		expect(out).toContain("- **Q:** Should MFA be mandatory?");
		expect(out).toContain("**Decided:** Yes, mandatory for all.");
		// Section is appended at the end, after the existing body.
		expect(out.indexOf("Some body.")).toBeLessThan(
			out.indexOf(PENDING_DECISIONS_HEADING),
		);
	});

	it("appends to the existing section instead of duplicating the heading", () => {
		const first = appendPendingDecision("# F", "Q1?", "A1");
		const second = appendPendingDecision(first, "Q2?", "A2");
		const headingCount = second.split(PENDING_DECISIONS_HEADING).length - 1;
		expect(headingCount).toBe(1);
		expect(second).toContain("Q1?");
		expect(second).toContain("Q2?");
	});

	it("handles an empty/blank description", () => {
		const out = appendPendingDecision("", "Q?", "A");
		expect(out.startsWith(PENDING_DECISIONS_HEADING)).toBe(true);
		expect(out).toContain("- **Q:** Q?");
	});

	it("trims question and answer text", () => {
		const out = appendPendingDecision(null, "  Q?  ", "  A  ");
		expect(out).toContain("- **Q:** Q?\n  **Decided:** A");
	});

	// -------------------------------------------------------------------------
	// Decorated headings. Highlighting the appendix heading in the editor used
	// to hide it from the raw `.includes()`, so every further answer stamped a
	// second appendix.
	// -------------------------------------------------------------------------

	it("appends under a HIGHLIGHTED appendix heading instead of duplicating it", () => {
		const base = `# F\n\nBody.\n\n${HIGHLIGHTED_HEADING}\n\n- **Q:** Q1?\n  **Decided:** A1`;
		const out = appendPendingDecision(base, "Q2?", "A2");
		expect(out).toBe(`${base}\n- **Q:** Q2?\n  **Decided:** A2`);
		// The decoration survives untouched, and no plain heading was stamped.
		expect(headingLines(out)).toHaveLength(1);
		expect(out).not.toContain(PENDING_DECISIONS_HEADING);
		expect(out).toContain(HIGHLIGHTED_HEADING);
	});

	it("appends under a BOLDED appendix heading instead of duplicating it", () => {
		const base = `# F\n\n${BOLDED_HEADING}\n\n- **Q:** Q1?\n  **Decided:** A1`;
		const out = appendPendingDecision(base, "Q2?", "A2");
		expect(out).toBe(`${base}\n- **Q:** Q2?\n  **Decided:** A2`);
		expect(headingLines(out)).toHaveLength(1);
	});

	it("treats a DEMOTED ### appendix heading as existing (substring predicate)", () => {
		const base = `# F\n\n${DEMOTED_HEADING}\n\n- **Q:** Q1?\n  **Decided:** A1`;
		const out = appendPendingDecision(base, "Q2?", "A2");
		expect(out).toBe(`${base}\n- **Q:** Q2?\n  **Decided:** A2`);
		expect(headingLines(out)).toHaveLength(1);
	});

	it("converges to ONE appendix across repeated answers on a decorated spec", () => {
		let spec = `# F\n\nBody.\n\n${HIGHLIGHTED_HEADING}\n\n- **Q:** Q1?\n  **Decided:** A1`;
		spec = appendPendingDecision(spec, "Q2?", "A2");
		spec = appendPendingDecision(spec, "Q3?", "A3");
		expect(headingLines(spec)).toHaveLength(1);
		expect(countPendingDecisions(spec)).toBe(3);
	});
});

/**
 * Backs the "X New Decisions" indicator (#B): counts answers in the pending
 * appendix. Up on answer, back to 0 once a refresh dissolves the appendix.
 */
describe("countPendingDecisions", () => {
	it("returns 0 for empty / null / no appendix", () => {
		expect(countPendingDecisions(null)).toBe(0);
		expect(countPendingDecisions(undefined)).toBe(0);
		expect(countPendingDecisions("")).toBe(0);
		expect(
			countPendingDecisions("# Feature\n\n## Must Haves\n- Do the thing"),
		).toBe(0);
	});

	it("counts bullets and increments as answers are appended", () => {
		let spec = appendPendingDecision("# Login\n\nBody.", "Q1?", "A1");
		expect(countPendingDecisions(spec)).toBe(1);
		spec = appendPendingDecision(spec, "Q2?", "A2");
		spec = appendPendingDecision(spec, "Q3?", "A3");
		expect(countPendingDecisions(spec)).toBe(3);
	});

	it("returns 0 once the appendix is dissolved by a refresh", () => {
		const withAppendix = appendPendingDecision("# F\n\nBody.", "Q1?", "A1");
		expect(countPendingDecisions(withAppendix)).toBe(1);
		expect(
			countPendingDecisions("# F\n\nBody, now mentioning the decision."),
		).toBe(0);
	});

	it("does not count a trailing H2 section after the appendix", () => {
		const spec = `${appendPendingDecision("# F\n\nBody.", "Q1?", "A1")}\n\n## Other\n- not a question`;
		expect(countPendingDecisions(spec)).toBe(1);
	});

	// -------------------------------------------------------------------------
	// Decorated headings. A highlighted heading used to make this return 0,
	// blanking the "X New Decisions" indicator while the answers were still
	// sitting in the spec.
	// -------------------------------------------------------------------------

	it("counts bullets under a HIGHLIGHTED appendix heading", () => {
		const spec = `# F\n\nBody.\n\n${HIGHLIGHTED_HEADING}\n\n- **Q:** Q1?\n  **Decided:** A1\n- **Q:** Q2?\n  **Decided:** A2`;
		expect(countPendingDecisions(spec)).toBe(2);
	});

	it("counts bullets under a BOLDED appendix heading", () => {
		const spec = `# F\n\n${BOLDED_HEADING}\n\n- **Q:** Q1?\n  **Decided:** A1`;
		expect(countPendingDecisions(spec)).toBe(1);
	});

	it("counts bullets under a DEMOTED ### appendix heading", () => {
		const spec = `# F\n\n${DEMOTED_HEADING}\n\n- **Q:** Q1?\n  **Decided:** A1`;
		expect(countPendingDecisions(spec)).toBe(1);
	});

	it("still stops at a following H2 when the appendix heading is decorated", () => {
		const spec = `# F\n\n${HIGHLIGHTED_HEADING}\n\n- **Q:** Q1?\n  **Decided:** A1\n\n## Other\n- **Q:** not counted`;
		expect(countPendingDecisions(spec)).toBe(1);
	});

	it("slices from the real offset when multi-byte content precedes the heading", () => {
		// The offset must be measured against the ORIGINAL text — normalizing
		// the document first would shift every position after an emoji or a
		// stripped tag and slice the section body in the wrong place.
		const spec = `# Ünïcødé 🎯 féatüre\n\nBödy with 🚀 emoji.\n\n${HIGHLIGHTED_HEADING}\n\n- **Q:** Q1?\n  **Decided:** A1\n- **Q:** Q2?\n  **Decided:** A2`;
		expect(countPendingDecisions(spec)).toBe(2);
	});
});

// ---------------------------------------------------------------------------
// The WRITE. Two answers submitted seconds apart used to both append onto the
// same base text (the procedure read `description` before calling in, outside
// the write's transaction), so the later write silently dropped the earlier
// bullet while its Decision Log entry still read "Resolved".
// ---------------------------------------------------------------------------

const STORY_ID = "story-1";
const PROJECT_ID = "project-1";

const baseParams = {
	storyId: STORY_ID,
	projectId: PROJECT_ID,
	tenantFilter: { organizationId: "org-1", userId: "user-1" },
	lastEditedByName: "Ada Lovelace",
};

/**
 * Same story, same call shape, personal tenant. The XOR rule makes
 * `organizationId: null` a distinct tenant rather than "no tenant", so the
 * locked write path has to be exercised in both contexts.
 */
const personalParams = {
	...baseParams,
	tenantFilter: { organizationId: null, userId: "user-1" },
};

interface Harness {
	/** Ordered log of every statement the production path issued. */
	calls: string[];
	/**
	 * Every `FOR UPDATE` statement issued. `matched` is whether its predicate
	 * actually selected the stored row — a lock whose `id`/`projectId` pairing
	 * misses locks nothing, exactly as in Postgres.
	 */
	lockStatements: Array<{
		sql: string;
		values: unknown[];
		matched: boolean;
	}>;
	/** `where` of the description re-read, one entry per transaction. */
	readWheres: unknown[];
	/** `where` of the guarded compare-and-set, one entry per transaction. */
	writeWheres: unknown[];
	/** `data` of every FeatureVersion snapshot row written. */
	snapshots: Array<Record<string, unknown>>;
	/** The single stored row, as the writes leave it. */
	row: { description: string | null; version: number };
}

/**
 * The columns a raw `WHERE "col" = ${value}` statement constrains, paired with
 * the value bound to each, so the fake can apply the lock's OWN predicate
 * instead of assuming it hit the row. A predicate that stops naming
 * `"projectId"` therefore stops being scoped here too.
 */
function rawWhere(
	strings: TemplateStringsArray,
	values: unknown[],
): Record<string, unknown> {
	const where: Record<string, unknown> = {};
	values.forEach((value, index) => {
		const column = strings[index]?.match(/"(\w+)"\s*=\s*$/)?.[1];
		if (column) {
			where[column] = value;
		}
	});
	return where;
}

/**
 * Does this `where` select the one stored row? Only the tenant-isolating pair
 * is modelled, and a predicate that OMITS one of them matches — that is the
 * point: dropping `projectId` makes another project's request find the row,
 * which is what the cross-project test below fails on.
 */
function matchesStoredRow(
	where: unknown,
	row: { id: string; projectId: string },
): boolean {
	const predicate = (where ?? {}) as Record<string, unknown>;
	return (
		(predicate.id === undefined || predicate.id === row.id) &&
		(predicate.projectId === undefined ||
			predicate.projectId === row.projectId)
	);
}

/**
 * A one-row stand-in for `user_story` that models the TWO database behaviors
 * these tests turn on:
 *
 *   - `FOR UPDATE` makes a second transaction wait for the first to commit
 *     before it reads. Without that queue the "two concurrent answers" test
 *     would prove nothing about the fix.
 *   - Statements honour their own `where`. A fake that returned the row
 *     whatever it was asked for would let the tenant-isolation assertions prove
 *     only that a `projectId` was PASSED, never that it was enforced.
 */
function installFakeDb(
	initialDescription: string | null,
	options: { writeMatches?: boolean } = {},
): Harness {
	const writeMatches = options.writeMatches ?? true;
	const row = {
		id: STORY_ID,
		projectId: PROJECT_ID,
		description: initialDescription,
		version: 1,
		updatedAt: new Date("2026-01-01T00:00:00.000Z"),
		lastEditedAt: new Date("2026-01-01T00:00:00.000Z"),
		title: "Feature",
		acceptanceCriteria: null,
		size: null,
		storyPoints: null,
		labels: [] as string[],
		assigneeId: null,
		statusId: "status-1",
		draftingStage: "DRAFT",
		maturationStatus: null,
		kind: "FEATURE",
		needsMoreInfo: false,
		coverageOverrideReason: null,
		coverageOverrideById: null,
		coverageOverrideAt: null,
		priority: "P2_MEDIUM",
		roadmapOrder: 0,
		externalId: null,
		externalMcpServerId: null,
	};
	const harness: Harness = {
		calls: [],
		lockStatements: [],
		readWheres: [],
		writeWheres: [],
		snapshots: [],
		row,
	};

	// Whoever holds the row lock; the next `FOR UPDATE` waits on this.
	let lockQueue: Promise<void> = Promise.resolve();

	dbMock.$transaction.mockImplementation(
		async (run: (tx: unknown) => Promise<unknown>) => {
			let commit!: () => void;
			const committed = new Promise<void>((resolve) => {
				commit = resolve;
			});
			const tx = {
				$queryRaw: async (
					strings: TemplateStringsArray,
					...values: unknown[]
				) => {
					harness.calls.push("lock");
					const matched = matchesStoredRow(
						rawWhere(strings, values),
						row,
					);
					harness.lockStatements.push({
						sql: strings.join("?"),
						values,
						matched,
					});
					// A predicate that selects no row locks nothing: it neither
					// waits on the current holder nor makes the next waiter wait.
					if (!matched) {
						return [];
					}
					const waitFor = lockQueue;
					lockQueue = waitFor.then(() => committed);
					await waitFor;
					return [row.id];
				},
				userStory: {
					findUnique: async (args: {
						where: unknown;
						select?: Record<string, unknown>;
					}) => {
						const isDescriptionRead =
							!!args.select &&
							Object.keys(args.select).length === 1 &&
							args.select.description === true;
						harness.calls.push(
							isDescriptionRead
								? "read:description"
								: args.select
									? "read:story"
									: "reload",
						);
						if (isDescriptionRead) {
							harness.readWheres.push(args.where);
						}
						if (!matchesStoredRow(args.where, row)) {
							return null;
						}
						return { ...row, status: null, tasks: [] };
					},
					updateMany: async (args: {
						where: Record<string, unknown>;
						data: Record<string, unknown>;
					}) => {
						harness.calls.push("write");
						harness.writeWheres.push(args.where);
						if (
							!writeMatches ||
							!matchesStoredRow(args.where, row) ||
							args.where.version !== row.version
						) {
							return { count: 0 };
						}
						if (typeof args.data.description === "string") {
							row.description = args.data.description;
						}
						row.version += 1;
						return { count: 1 };
					},
				},
				featureVersion: {
					createMany: async (args: {
						data: Array<Record<string, unknown>>;
					}) => {
						harness.calls.push("snapshot");
						harness.snapshots.push(...args.data);
						return { count: args.data.length };
					},
				},
			};
			try {
				return await run(tx);
			} finally {
				// COMMIT — releases the row lock for the next waiter.
				commit();
			}
		},
	);

	return harness;
}

describe("recordAnswerInSpec", () => {
	beforeEach(() => {
		vi.clearAllMocks();
	});

	it("takes the row lock BEFORE re-reading the description, in one transaction", async () => {
		const harness = installFakeDb("# F\n\nBody.");

		await recordAnswerInSpec({
			...baseParams,
			question: "Q1?",
			answer: "A1",
		});

		expect(dbMock.$transaction).toHaveBeenCalledTimes(1);
		// The mechanism, not just the result: lock first, THEN the read the
		// appended text is computed from. A read before the lock — or outside the
		// transaction, as the procedure used to do — is the defect itself.
		expect(harness.calls.slice(0, 2)).toEqual(["lock", "read:description"]);
		expect(harness.calls).toContain("write");

		const [lock] = harness.lockStatements;
		expect(lock.sql).toMatch(/FOR UPDATE/);
		// Tenant isolation rides on the id + projectId pairing; the lock is ADDED
		// to that predicate, never substituted for it.
		expect(lock.sql).toContain('"projectId"');
		expect(lock.values).toEqual([STORY_ID, PROJECT_ID]);
		expect(harness.readWheres).toEqual([
			{ id: STORY_ID, projectId: PROJECT_ID },
		]);
	});

	it("keeps the story-id + project-id predicate on the guarded write", async () => {
		const harness = installFakeDb("# F");

		await recordAnswerInSpec({
			...baseParams,
			question: "Q1?",
			answer: "A1",
		});

		expect(harness.writeWheres).toEqual([
			{ id: STORY_ID, projectId: PROJECT_ID, version: 1 },
		]);
	});

	it("writes a FeatureVersion snapshot, because the write changes description", async () => {
		const harness = installFakeDb("# F");

		await recordAnswerInSpec({
			...baseParams,
			question: "Q1?",
			answer: "A1",
		});

		// `updateStory` takes its version branch for a description change: the
		// story version increments and a snapshot row lands. The file used to
		// document the opposite.
		expect(harness.calls).toContain("snapshot");
		expect(harness.row.version).toBe(2);
	});

	it("lands BOTH answers when two are issued concurrently", async () => {
		const harness = installFakeDb("# F\n\nBody.");

		await Promise.all([
			recordAnswerInSpec({
				...baseParams,
				question: "Q1?",
				answer: "A1",
			}),
			recordAnswerInSpec({
				...baseParams,
				question: "Q2?",
				answer: "A2",
			}),
		]);

		const final = harness.row.description ?? "";
		expect(final).toContain("- **Q:** Q1?\n  **Decided:** A1");
		expect(final).toContain("- **Q:** Q2?\n  **Decided:** A2");
		expect(countPendingDecisions(final)).toBe(2);
		// Second answer computed against the FIRST one's committed text, so there
		// is one appendix rather than two competing rewrites of the same base.
		expect(final.split(PENDING_DECISIONS_HEADING).length - 1).toBe(1);
		expect(dbMock.$transaction).toHaveBeenCalledTimes(2);
	});

	it("produces exactly one bullet, formatting unchanged, for a single answer", async () => {
		const harness = installFakeDb("# F\n\nBody.");

		await recordAnswerInSpec({
			...baseParams,
			question: "  Should MFA be mandatory?  ",
			answer: "  Yes, for all.  ",
		});

		expect(harness.row.description).toBe(
			`# F\n\nBody.\n\n${PENDING_DECISIONS_HEADING}\n\n- **Q:** Should MFA be mandatory?\n  **Decided:** Yes, for all.`,
		);
		expect(countPendingDecisions(harness.row.description)).toBe(1);
	});

	it("throws when a conflict survives the lock instead of reporting success", async () => {
		// The lock makes a lost race an anomaly rather than routine, so it must
		// reach the caller as a failure — `answerQuestion` maps it to CONFLICT.
		installFakeDb("# F", { writeMatches: false });

		await expect(
			recordAnswerInSpec({
				...baseParams,
				question: "Q1?",
				answer: "A1",
			}),
		).rejects.toMatchObject({ name: "StoryVersionConflictError" });
	});

	it("locks nothing and writes nothing when the project does not own the story", async () => {
		// The enforcement side of the id + projectId pairing the tests above
		// assert is PASSED. A caller scoped to another project names a real
		// story id; every statement on the path must miss the row, so the
		// request dies on the re-read rather than appending to somebody else's
		// spec.
		const harness = installFakeDb("# F\n\nBody.");
		const before = harness.row.description;

		await expect(
			recordAnswerInSpec({
				...baseParams,
				projectId: "project-2",
				question: "Q1?",
				answer: "A1",
			}),
		).rejects.toThrow(/Story not found/);

		const [lock] = harness.lockStatements;
		expect(lock.values).toEqual([STORY_ID, "project-2"]);
		expect(lock.matched).toBe(false);
		expect(harness.calls).not.toContain("write");
		expect(harness.calls).not.toContain("snapshot");
		expect(harness.row.description).toBe(before);
		expect(harness.row.version).toBe(1);
	});

	it("takes the same lock → read → guarded write path in PERSONAL context", async () => {
		// `organizationId: null` is a tenant, not the absence of one, so the
		// locked write path owes the same proof there as in an organization.
		const harness = installFakeDb("# F\n\nBody.");

		await recordAnswerInSpec({
			...personalParams,
			question: "Q1?",
			answer: "A1",
		});

		expect(harness.calls.slice(0, 2)).toEqual(["lock", "read:description"]);
		expect(harness.lockStatements[0].values).toEqual([
			STORY_ID,
			PROJECT_ID,
		]);
		expect(harness.readWheres).toEqual([
			{ id: STORY_ID, projectId: PROJECT_ID },
		]);
		expect(harness.writeWheres).toEqual([
			{ id: STORY_ID, projectId: PROJECT_ID, version: 1 },
		]);
		expect(harness.row.description).toBe(
			`# F\n\nBody.\n\n${PENDING_DECISIONS_HEADING}\n\n- **Q:** Q1?\n  **Decided:** A1`,
		);

		// The snapshot carries the personal tenant through: a null
		// organizationId, never a borrowed one.
		expect(harness.snapshots).toHaveLength(1);
		expect(harness.snapshots[0]).toMatchObject({
			storyId: STORY_ID,
			version: 1,
			organizationId: null,
			userId: "user-1",
			// The PRE-answer body — what makes the answer revertible.
			description: "# F\n\nBody.",
		});
	});
});
