/**
 * Glossy editions (Fizzy #2589) — unit tests that need no database.
 *
 * The concurrency and RLS behaviour is proven against real Postgres in
 * `glossy-editions.integration.test.ts`. Here: the value sets the TypeScript
 * unions and the migration's CHECK constraints must agree on, the key-shape
 * predicates, the outcome of each guarded write when its guard does not
 * match — in particular that nothing after a failed guard is written — and
 * the attempt-then-edition lock order of finalize and fail.
 */

import { readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { beforeEach, describe, expect, it, vi } from "vitest";

const fake = vi.hoisted(() => {
	const delegate = () => ({
		findFirst: vi.fn(),
		findUnique: vi.fn(),
		findUniqueOrThrow: vi.fn(),
		findMany: vi.fn(),
		createMany: vi.fn(),
		create: vi.fn(),
		updateMany: vi.fn(),
		upsert: vi.fn(),
		deleteMany: vi.fn(),
		count: vi.fn(),
	});
	const client = {
		projectDocument: delegate(),
		project: delegate(),
		glossyEdition: delegate(),
		glossyBuild: delegate(),
		glossyVisualDecision: delegate(),
		glossySegmentCache: delegate(),
		projectRecipientBrand: delegate(),
		$queryRaw: vi.fn(),
		$transaction: vi.fn(),
	};
	return client;
});

vi.mock("../prisma/client", () => ({ db: fake, Prisma: {} }));

import {
	applyVisualRegeneration,
	claimGlossyBuild,
	failGlossyBuild,
	finalizeGlossyBuild,
	GLOSSY_BUILD_STATUSES,
	GLOSSY_CACHE_KINDS,
	GLOSSY_VISUAL_DECISIONS,
	GlossyBuildInvariantError,
	getCacheEntries,
	glossyEditionBuildWorkflowId,
	heartbeatGlossyBuild,
	putCacheEntry,
} from "../prisma/queries/projects/glossy-editions";
import {
	confirmRecipientBrand,
	isRecipientLogoKeyForProject,
	normalizeRecipientBrandFields,
	RecipientBrandValidationError,
} from "../prisma/queries/projects/recipient-brand";

const migrationSql = (() => {
	const dir = join(__dirname, "../prisma/migrations");
	const folder = readdirSync(dir).find((name) =>
		name.endsWith("_glossy_editions"),
	);
	return readFileSync(join(dir, String(folder), "migration.sql"), "utf8");
})();

/** The quoted values of `"column" IN (...)` in the named CHECK constraint. */
function checkValues(constraint: string, column: string): string[] {
	const flat = migrationSql.replace(/\s+/g, " ");
	const start = flat.indexOf(`"${constraint}"`);
	expect(start).toBeGreaterThan(-1);
	const clause = flat
		.slice(start)
		.match(new RegExp(`"${column}" IN \\(([^)]*)\\)`));
	return [...(clause?.[1] ?? "").matchAll(/'([^']+)'/g)].map((m) => m[1]);
}

/** Every write-shaped call made on the fake, as `delegate.method`. */
function writes(): string[] {
	const names: string[] = [];
	for (const [model, delegate] of Object.entries(fake)) {
		if (typeof delegate !== "object") {
			continue;
		}
		for (const [method, fn] of Object.entries(delegate)) {
			if (
				/^(create|createMany|update|updateMany|upsert|delete|deleteMany)$/.test(
					method,
				) &&
				(fn as ReturnType<typeof vi.fn>).mock.calls.length > 0
			) {
				names.push(`${model}.${method}`);
			}
		}
	}
	return names.sort();
}

beforeEach(() => {
	vi.clearAllMocks();
	fake.$transaction.mockImplementation(
		async (fn: (tx: typeof fake) => unknown) => fn(fake),
	);
});

describe("value sets agree with the migration's CHECK constraints", () => {
	it.each([
		["glossy_build_status_check", "status", GLOSSY_BUILD_STATUSES],
		["glossy_segment_cache_kind_check", "kind", GLOSSY_CACHE_KINDS],
		[
			"glossy_visual_decision_decision_check",
			"decision",
			GLOSSY_VISUAL_DECISIONS,
		],
	])("%s", (constraint, column, values) => {
		expect(checkValues(constraint, column).sort()).toEqual(
			[...values].sort(),
		);
	});
});

describe("key shapes", () => {
	it("keys the workflow id on the attempt, so a rebuild never reuses one", () => {
		expect(glossyEditionBuildWorkflowId("doc-1", "build-2")).toBe(
			"glossy-edition-build-doc-1-build-2",
		);
	});

	it.each([
		["project-brand/p1/recipient-brand/current/abc_123-x.png", true],
		["project-brand/p2/recipient-brand/current/abc.png", false],
		["project-brand/p1/recipient-brand/pending/abc.png", false],
		["project-brand/p1/recipient-brand/current/../../p2/x.png", false],
		["project-brand/p1/recipient-brand/current/a/b.png", false],
		["project-brand/p1/recipient-brand/current/abc.svg", false],
		["project-brand/p1/recipient-brand/current/.png", false],
		["story-attachments/p1/recipient-brand/current/abc.png", false],
	])("recipient logo key %s → %s", (key, expected) => {
		expect(isRecipientLogoKeyForProject("p1", key)).toBe(expected);
	});
});

describe("recipient brand fields", () => {
	it("normalizes the website to https://host, trims the name, lowercases colors", () => {
		expect(
			normalizeRecipientBrandFields("p1", {
				name: "  Example Client ",
				website: "https://Example.COM/",
				colors: ["#AABBCC"],
			}),
		).toEqual({
			name: "Example Client",
			website: "https://example.com",
			logoKey: null,
			colors: ["#aabbcc"],
		});
	});

	it.each([
		[{ website: "http://example.com" }, "invalidWebsite"],
		[{ website: "https://example.com/about" }, "invalidWebsite"],
		[{ website: "https://example.com:8443" }, "invalidWebsite"],
		[{ website: "https://user:pw@example.com" }, "invalidWebsite"],
		[{ website: "https://example.com/?q=1" }, "invalidWebsite"],
		[{ website: "not a url" }, "invalidWebsite"],
		[
			{ colors: ["#111111", "#222222", "#333333", "#444444"] },
			"tooManyColors",
		],
		[{ colors: ["#abc"] }, "invalidColor"],
		[{ colors: ["red"] }, "invalidColor"],
		[{ name: "x".repeat(201) }, "nameTooLong"],
		[
			{ logoKey: "project-brand/p2/recipient-brand/current/a.png" },
			"invalidLogoKey",
		],
	])("rejects %o with %s", (input, code) => {
		expect(() => normalizeRecipientBrandFields("p1", input)).toThrow(
			expect.objectContaining({ code }),
		);
	});

	it("a stale version conflicts without writing", async () => {
		fake.project.findUnique.mockResolvedValue({ organizationId: "org-1" });
		fake.projectRecipientBrand.findUnique.mockResolvedValue({
			version: 3,
			logoKey: null,
		});
		await expect(
			confirmRecipientBrand({
				projectId: "p1",
				expectedVersion: 2,
				name: "Example",
				updatedById: "u1",
			}),
		).resolves.toEqual({ outcome: "conflict" });
		expect(writes()).toEqual([]);
	});

	it("validates before touching the database", async () => {
		await expect(
			confirmRecipientBrand({
				projectId: "p1",
				expectedVersion: 0,
				colors: ["blue"],
				updatedById: "u1",
			}),
		).rejects.toBeInstanceOf(RecipientBrandValidationError);
		expect(fake.project.findUnique).not.toHaveBeenCalled();
		expect(writes()).toEqual([]);
	});
});

describe("attempt guards", () => {
	const snapshot = {
		title: "t",
		content: "c",
		version: 1,
		contentHash: "h",
	};

	function tenantResolves() {
		fake.projectDocument.findFirst.mockResolvedValue({
			project: { organizationId: "org-1" },
		});
		fake.glossyEdition.createMany.mockResolvedValue({ count: 0 });
		fake.glossyEdition.findUniqueOrThrow.mockResolvedValue({
			id: "edition-1",
			projectId: "p1",
			organizationId: "org-1",
		});
	}

	/** Finalize's and fail's first statement: `SELECT ... FOR UPDATE`. */
	function attemptRowLocks() {
		fake.$queryRaw.mockResolvedValue([
			{ documentId: "d1", startedAt: new Date() },
		]);
	}

	const finalizeAttempt = (buildId: string) =>
		finalizeGlossyBuild({
			buildId,
			content: { v: 1 },
			report: {},
			sectionKeys: [],
			usedCacheKeys: [],
		});
	const failAttempt = (buildId: string) =>
		failGlossyBuild({ buildId, errorCode: "X", errorMessage: "x" });

	it("a lost claim inserts no attempt row and reports the holder", async () => {
		tenantResolves();
		fake.glossyEdition.updateMany.mockResolvedValue({ count: 0 });
		fake.glossyEdition.findUnique.mockResolvedValue({
			currentBuildId: "holder",
		});
		const startedAt = new Date("2026-09-24T10:00:00Z");
		fake.glossyBuild.findUnique.mockResolvedValue({
			id: "holder",
			startedById: "u9",
			startedAt,
			heartbeatAt: startedAt,
			workflowId: "wf",
		});

		const result = await claimGlossyBuild({
			documentId: "d1",
			projectId: "p1",
			organizationId: "org-1",
			startedById: "u1",
			options: {},
			snapshot,
		});

		expect(result).toEqual({
			outcome: "alreadyBuilding",
			holder: {
				buildId: "holder",
				startedById: "u9",
				startedAt,
				heartbeatAt: startedAt,
				workflowId: "wf",
			},
		});
		expect(fake.glossyBuild.create).not.toHaveBeenCalled();
		// A fresh claim is conditional on no holder, not on any status.
		const [{ where }] = fake.glossyEdition.updateMany.mock.calls[0];
		expect(where).toEqual({
			id: "edition-1",
			OR: [{ currentBuildId: null }],
		});
	});

	it("a won claim copies tenant columns from the edition, never from the caller", async () => {
		tenantResolves();
		fake.glossyEdition.updateMany.mockResolvedValue({ count: 1 });
		fake.glossyBuild.create.mockResolvedValue({ id: "new" });

		const result = await claimGlossyBuild({
			documentId: "d1",
			projectId: "p1",
			organizationId: "org-1",
			startedById: "guest-1",
			options: { lengthMode: "brief" },
			snapshot,
		});

		expect(result.outcome).toBe("claimed");
		const [{ data }] = fake.glossyBuild.create.mock.calls[0];
		expect(data).toMatchObject({
			projectId: "p1",
			organizationId: "org-1",
			status: "BUILDING",
			startedById: "guest-1",
			sourceContent: "c",
		});
		expect(data.heartbeatAt).toEqual(data.startedAt);
	});

	it("finalize by an attempt that lost the claim writes nothing after the guard", async () => {
		attemptRowLocks();
		fake.glossyEdition.updateMany.mockResolvedValue({ count: 0 });

		await expect(
			finalizeGlossyBuild({
				buildId: "old",
				content: { v: 1 },
				report: {},
				sectionKeys: [],
				usedCacheKeys: [],
			}),
		).resolves.toEqual({ outcome: "superseded" });
		expect(writes()).toEqual(["glossyEdition.updateMany"]);
		// The swap is guarded on the attempt's identity, not on a status.
		const [{ where }] = fake.glossyEdition.updateMany.mock.calls[0];
		expect(where).toEqual({ documentId: "d1", currentBuildId: "old" });
	});

	it("fail by an attempt that lost the claim leaves both rows alone", async () => {
		attemptRowLocks();
		fake.glossyEdition.updateMany.mockResolvedValue({ count: 0 });

		await expect(
			failGlossyBuild({
				buildId: "old",
				errorCode: "X",
				errorMessage: "x",
			}),
		).resolves.toBe("superseded");
		expect(writes()).toEqual(["glossyEdition.updateMany"]);
		expect(fake.glossyBuild.updateMany).not.toHaveBeenCalled();
	});

	it("fail truncates the stored message and never touches published content", async () => {
		attemptRowLocks();
		fake.glossyEdition.updateMany.mockResolvedValue({ count: 1 });
		fake.glossyBuild.updateMany.mockResolvedValue({ count: 1 });

		await failGlossyBuild({
			buildId: "b1",
			errorCode: "MODEL_ERROR",
			errorMessage: "m".repeat(2_000),
		});
		const [{ data: edition }] = fake.glossyEdition.updateMany.mock.calls[0];
		expect(edition).toEqual({ currentBuildId: null });
		const [{ data: build }] = fake.glossyBuild.updateMany.mock.calls[0];
		expect(build.status).toBe("FAILED");
		expect(build.errorMessage).toHaveLength(500);
	});

	it.each([
		["finalize", finalizeAttempt],
		["fail", failAttempt],
	])(
		"%s locks the attempt row before it touches the edition row",
		async (_name, write) => {
			attemptRowLocks();
			fake.glossyEdition.updateMany.mockResolvedValue({ count: 0 });

			await write("b1");

			const [strings, ...values] = fake.$queryRaw.mock.calls[0];
			// Whatever the status, so a non-BUILDING holder still reaches the
			// invariant check below instead of reading as superseded.
			expect((strings as string[]).join("?")).toMatch(
				/FROM "glossy_build"\s+WHERE "id" = \?\s+FOR UPDATE\s*$/,
			);
			expect(values).toEqual(["b1"]);
			// Build then edition, the order a reclaim takes them in.
			expect(fake.$queryRaw.mock.invocationCallOrder[0]).toBeLessThan(
				fake.glossyEdition.updateMany.mock.invocationCallOrder[0],
			);
		},
	);

	it.each([
		["finalize", finalizeAttempt],
		["fail", failAttempt],
	])(
		"%s throws when the attempt holds the claim but is not BUILDING",
		async (_name, write) => {
			attemptRowLocks();
			fake.glossyEdition.updateMany.mockResolvedValue({ count: 1 });
			fake.glossyBuild.updateMany.mockResolvedValue({ count: 0 });

			await expect(write("b1")).rejects.toBeInstanceOf(
				GlossyBuildInvariantError,
			);
			// The throw rolls the transaction back; nothing after it runs.
			expect(writes()).toEqual([
				"glossyBuild.updateMany",
				"glossyEdition.updateMany",
			]);
		},
	);

	it("heartbeat reports superseded when the attempt no longer holds the claim", async () => {
		fake.glossyBuild.updateMany.mockResolvedValue({ count: 0 });
		await expect(heartbeatGlossyBuild("old")).resolves.toBe("superseded");
		const [{ where }] = fake.glossyBuild.updateMany.mock.calls[0];
		expect(where).toEqual({
			id: "old",
			status: "BUILDING",
			document: { glossyEdition: { is: { currentBuildId: "old" } } },
		});
	});

	it("a superseded regenerate writes no cache row and keeps acceptances", async () => {
		fake.glossyEdition.updateMany.mockResolvedValue({ count: 0 });
		await expect(
			applyVisualRegeneration({
				documentId: "d1",
				projectId: "p1",
				expectedPublishedBuildId: "b1",
				expectedContentRevision: 4,
				content: {},
				visualKey: "v1",
				cacheEntry: { cacheKey: "k", sectionKey: "s1", output: {} },
			}),
		).resolves.toEqual({ outcome: "superseded" });
		expect(writes()).toEqual(["glossyEdition.updateMany"]);
		const [{ where }] = fake.glossyEdition.updateMany.mock.calls[0];
		expect(where).toEqual({
			documentId: "d1",
			projectId: "p1",
			publishedBuildId: "b1",
			contentRevision: 4,
			currentBuildId: null,
		});
	});

	it("a cache write from an attempt that lost the claim is superseded", async () => {
		fake.$queryRaw.mockResolvedValue([]);
		await expect(
			putCacheEntry({
				documentId: "d1",
				projectId: "p1",
				kind: "REWRITE",
				cacheKey: "k",
				output: {},
				buildId: "old",
			}),
		).resolves.toBe("superseded");
		expect(writes()).toEqual([]);
	});
});

describe("segment cache reads", () => {
	it("no keys is an empty map without a query", async () => {
		const entries = await getCacheEntries({
			documentId: "d1",
			kind: "REWRITE",
			cacheKeys: [],
		});
		expect(entries).toEqual(new Map());
		expect(fake.glossySegmentCache.findMany).not.toHaveBeenCalled();
	});

	it("returns each found output under its cache key, filtered on document, kind and keys", async () => {
		fake.glossySegmentCache.findMany.mockResolvedValue([
			{ cacheKey: "k1", output: { text: "one" } },
			{ cacheKey: "k2", output: { text: "two" } },
		]);
		const entries = await getCacheEntries({
			documentId: "d1",
			kind: "DETECTION",
			cacheKeys: ["k1", "k2", "missing"],
		});
		expect(entries).toEqual(
			new Map([
				["k1", { text: "one" }],
				["k2", { text: "two" }],
			]),
		);
		const [{ where }] = fake.glossySegmentCache.findMany.mock.calls[0];
		expect(where).toEqual({
			documentId: "d1",
			kind: "DETECTION",
			cacheKey: { in: ["k1", "k2", "missing"] },
		});
	});
});
