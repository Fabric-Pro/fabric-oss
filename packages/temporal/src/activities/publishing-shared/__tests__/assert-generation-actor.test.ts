import { readdirSync, statSync } from "node:fs";
import { dirname, join, relative } from "node:path";
import { fileURLToPath } from "node:url";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { databaseValueImports, firstCallPosition } from "./_ast-guards";

/**
 * The shared point-of-use authorization re-check, and the guard that stops a
 * sixth content type shipping without it.
 *
 * The defect this file exists for: the five generation activities re-checked
 * `isCurrentOrgMember`, while the API gate that authorized the run had checked
 * `PUBLISHING_TOPIC_UPDATE` on the PROJECT — a ladder whose last rung is org
 * membership. A project-scoped guest passed the gate, had a GENERATING draft
 * row written, and was then refused here with a sentence that was untrue about
 * them. Deterministically, every time.
 */

const checkPublishingGenerationActor = vi.fn();
vi.mock("@repo/database", () => ({
	checkPublishingGenerationActor: (...a: unknown[]) =>
		checkPublishingGenerationActor(...a),
}));

const warn = vi.fn();
vi.mock("@repo/logs", () => ({
	logger: {
		info: vi.fn(),
		warn: (...a: unknown[]) => warn(...a),
		error: vi.fn(),
		debug: vi.fn(),
	},
}));

import { assertGenerationActorAuthorized } from "../assert-generation-actor";

const INPUT = {
	projectId: "proj-1",
	organizationId: "org-1",
	actorUserId: "user-1",
	activity: "generateCaseStudyActivity",
};

beforeEach(() => {
	vi.clearAllMocks();
});

describe("assertGenerationActorAuthorized", () => {
	it("asks about the PROJECT, passing the organization the run was queued under", async () => {
		checkPublishingGenerationActor.mockResolvedValue({ ok: true });

		await assertGenerationActorAuthorized(INPUT);

		// The argument bag, not merely "it was called". The whole defect was
		// that the re-check asked a different question than the gate, so which
		// question — and about which project — is the thing to pin. `activity`
		// is deliberately NOT forwarded: it is a log label, and a decision that
		// varied by content type would be a different function.
		expect(checkPublishingGenerationActor).toHaveBeenCalledWith({
			projectId: "proj-1",
			organizationId: "org-1",
			actorUserId: "user-1",
		});
	});

	it("says nothing and throws nothing when the actor is authorized", async () => {
		checkPublishingGenerationActor.mockResolvedValue({ ok: true });

		await expect(
			assertGenerationActorAuthorized(INPUT),
		).resolves.toBeUndefined();
		// A guard that logged on the happy path would drown its own signal.
		expect(warn).not.toHaveBeenCalled();
	});

	it("refuses a project that has left the organization, with BOTH the code and the words", async () => {
		checkPublishingGenerationActor.mockResolvedValue({
			ok: false,
			reason: "TENANT_MISMATCH",
			currentOrganizationId: "org-2",
		});

		// The message is asserted, not just the type. It is stored on the FAILED
		// draft row and rendered, and the previous wording ("AI actor is no
		// longer an org member") was asserted by NOTHING anywhere in the repo —
		// which is how it stayed false about guests for two phases.
		await expect(
			assertGenerationActorAuthorized(INPUT),
		).rejects.toMatchObject({
			type: "PUBLISHING_TENANT_MISMATCH",
			message:
				"This project moved to a different organization after the draft was started",
			nonRetryable: true,
		});
	});

	it("refuses an unauthorized actor, with BOTH the code and the words", async () => {
		checkPublishingGenerationActor.mockResolvedValue({
			ok: false,
			reason: "NOT_AUTHORIZED",
			currentOrganizationId: "org-1",
		});

		await expect(
			assertGenerationActorAuthorized(INPUT),
		).rejects.toMatchObject({
			type: "PUBLISHING_ACTOR_INVALID",
			message:
				"The account that started this draft is no longer authorized to generate on this project",
			nonRetryable: true,
		});
	});

	it("words both refusals in the THIRD person", async () => {
		// The panel renders the stored string to anyone who can see the tab, not
		// only to whoever pressed the button. "You no longer have permission" is
		// then false for most of its readers.
		for (const reason of ["TENANT_MISMATCH", "NOT_AUTHORIZED"]) {
			checkPublishingGenerationActor.mockResolvedValue({
				ok: false,
				reason,
				currentOrganizationId: "org-1",
			});

			const error = await assertGenerationActorAuthorized(INPUT).then(
				() => null,
				(e: unknown) => e as { message: string },
			);

			// Asserted BEFORE the wording check: `expect(undefined).not.toMatch()`
			// passes, so a version that stopped throwing would sail through the
			// line below it.
			expect(error?.message).toEqual(expect.any(String));
			expect(error?.message).not.toMatch(/\byou\b|\byour\b/i);
		}
	});

	it("logs the reason before throwing, so a refusal is visible to an operator", async () => {
		// Before this, the only production signal was the workflow's generic
		// "generation failed" line with no error type on it — a revoked actor
		// and a provider timeout looked identical in the logs.
		checkPublishingGenerationActor.mockResolvedValue({
			ok: false,
			reason: "TENANT_MISMATCH",
			currentOrganizationId: "org-2",
		});

		await assertGenerationActorAuthorized(INPUT).catch(() => {});

		expect(warn).toHaveBeenCalledTimes(1);
		expect(warn.mock.calls[0]?.[1]).toMatchObject({
			reason: "TENANT_MISMATCH",
			activity: "generateCaseStudyActivity",
			projectId: "proj-1",
			organizationId: "org-1",
			// The one field that makes the line worth reading: what the project
			// belongs to NOW.
			currentOrganizationId: "org-2",
		});
	});
});

describe("assert-generation-actor's own database surface", () => {
	it("imports ONE value from @repo/database, and it is the predicate", () => {
		// The activities' write-surface guards read their OWN imports, and the
		// walker does not follow calls. Moving the authorization read in here
		// would otherwise have bought this module an unwatched licence to import
		// a publisher, a feed writer or a draft mutator.
		expect(
			databaseValueImports(
				join(__dirname, "../assert-generation-actor.ts"),
			),
		).toEqual(["checkPublishingGenerationActor"]);
	});
});

const ACTIVITIES_DIR = join(
	dirname(fileURLToPath(import.meta.url)),
	"..",
	"..",
);

function walkSourceFiles(dir: string): string[] {
	const out: string[] = [];
	for (const entry of readdirSync(dir)) {
		const full = join(dir, entry);
		if (statSync(full).isDirectory()) {
			if (entry === "__tests__" || entry === "node_modules") {
				continue;
			}
			out.push(...walkSourceFiles(full));
		} else if (entry.endsWith(".ts") && !entry.endsWith(".test.ts")) {
			// Two of the newsletter suites sit BESIDE their source rather than
			// in a `__tests__` directory, so skipping the directory is not
			// enough. A test that mocks the old helper is not an activity that
			// asks it.
			out.push(full);
		}
	}
	return out;
}

/**
 * Files where `isCurrentOrgMember` is actually CALLED.
 *
 * A CallExpression via the AST, not a source-text search. The first version of
 * this scan searched the text and reported THIS FILE as an offender, because
 * the doc comment at the top names the helper it replaced — the precise
 * weakness that makes a grep-shaped guard worthless: it cannot tell code from
 * prose, in either direction.
 */
function filesCallingOrgMembership(): string[] {
	return walkSourceFiles(ACTIVITIES_DIR).filter(
		(file) => firstCallPosition(file, "isCurrentOrgMember") > -1,
	);
}

/**
 * Activities that still ask `isCurrentOrgMember`, and why that is right for
 * them. An entry belongs here only with a reason that is TRUE — not because
 * nobody got round to it.
 */
const STILL_ASKS_ORG_MEMBERSHIP = new Map([
	[
		"publishing-suggestion/summarize-topic-suggestions.ts",
		"scheduled run, not user-initiated: `assertProjectTenantTuple` has already proven the actor IS the project owner, so there is no gate decision to mirror. Its TENANT half is a separate, wider gap — the tuple check runs at workflow step 1 and this activity at step ~15, with the whole collector fan-out between — and is NOT closed here.",
	],
	[
		"newsletter/curate-newsletter-from-releases.ts",
		"scheduled send; the actor is the stored settings admin, validated by `isScheduledNewsletterActorValid`, not a caller who passed a project gate.",
	],
	[
		"newsletter/curate-stakeholder-release-notes.ts",
		"same actor model as the newsletter curator above.",
	],
]);

describe("no activity keeps the old membership check unnoticed", () => {
	it("finds the files it is supposed to find", () => {
		// The precondition, asserted separately. A scan that silently returned
		// nothing would make the check below pass while reading every future
		// offender as classified — the failure mode where the guard is the thing
		// that broke, not the code.
		expect(filesCallingOrgMembership().length).toBeGreaterThanOrEqual(3);
	});

	it("classifies every activity that still asks org membership", () => {
		// Keyed on the SYMPTOM rather than on a name pattern. A guard that
		// discovered `publishing-*/generate-*Activity` would have excluded the
		// three entries above by accident of naming, and reported a clean bill
		// of health for a family it never looked at.
		const unclassified = filesCallingOrgMembership()
			.map((file) => relative(ACTIVITIES_DIR, file).replace(/\\/g, "/"))
			.filter((rel) => !STILL_ASKS_ORG_MEMBERSHIP.has(rel));

		// A new activity reaching for `isCurrentOrgMember` trips this. Either it
		// mirrors a project gate — then call `assertGenerationActorAuthorized` —
		// or it does not, and belongs above with the reason why.
		expect(unclassified).toEqual([]);
	});
});

function generationActivityFiles(): string[] {
	return walkSourceFiles(ACTIVITIES_DIR).filter((file) => {
		const rel = relative(ACTIVITIES_DIR, file).replace(/\\/g, "/");
		return /^publishing-[a-z-]+\/generate-[a-z-]+\.ts$/.test(rel);
	});
}

describe("every publishing generation activity re-checks before it spends", () => {
	it("finds all five generation activities", () => {
		const found = generationActivityFiles().map((file) =>
			relative(ACTIVITIES_DIR, file).replace(/\\/g, "/"),
		);

		expect(found.sort()).toEqual([
			"publishing-blog-post/generate-blog-post.ts",
			"publishing-case-study/generate-case-study.ts",
			"publishing-planning/generate-planning-analysis.ts",
			"publishing-short-post/generate-short-post.ts",
			"publishing-stakeholder-email/generate-stakeholder-email.ts",
		]);
	});

	for (const file of generationActivityFiles()) {
		const rel = relative(ACTIVITIES_DIR, file).replace(/\\/g, "/");

		it(`${rel} CALLS the shared assertion`, () => {
			// A CallExpression, via the AST. A source-text search would be
			// satisfied by an unused import or a mention in a comment — which is
			// exactly what a careless refactor leaves behind.
			expect(
				firstCallPosition(file, "assertGenerationActorAuthorized"),
			).toBeGreaterThan(-1);
		});

		it(`${rel} calls it BEFORE anything resolves a model`, () => {
			// The property that actually protects the organization's money. A
			// guard that runs after the model factory is a log line. Two of the
			// five activities (blog post, short post) have no suite of their own
			// at all, so for those this is the ONLY thing standing between the
			// code and a silently reordered call.
			// Both sides are CALLS, not references: every one of these modules
			// imports `getAIModelWithMetadata` at the top of the file, so a
			// "first reference" comparison would measure the guard against an
			// import statement and pass for any arrangement of the body.
			const guard = firstCallPosition(
				file,
				"assertGenerationActorAuthorized",
			);
			const model = firstCallPosition(file, "getAIModelWithMetadata");

			expect(model).toBeGreaterThan(-1);
			expect(guard).toBeLessThan(model);
		});
	}
});
