/**
 * Brand source rows (Fizzy #2946), without a database: the organization's
 * website fetch, a project's recipient suggestion and the brand an export
 * printed.
 *
 * The load-bearing assertion is the negative one: none of these writers
 * issues a write against a table a person owns (the Brand kit, the recipient
 * brand, the document Style), so no automated fetch can replace a value a
 * person chose. Every finishing write is conditioned on its own attempt.
 */

import { BRAND_FETCH_JOIN_WINDOW_MS } from "@repo/utils/proposal-artifact/brand-sources";
import { beforeEach, describe, expect, it, vi } from "vitest";

const fake = vi.hoisted(() => {
	const delegate = () => ({
		findUnique: vi.fn(),
		findFirst: vi.fn(),
		upsert: vi.fn(),
		update: vi.fn(),
		updateMany: vi.fn(),
		create: vi.fn(),
		createMany: vi.fn(),
	});
	const fake = {
		organizationBrandKit: delegate(),
		organizationBrandSiteFetch: delegate(),
		projectRecipientBrand: delegate(),
		projectRecipientBrandSuggestion: delegate(),
		projectDocumentStyle: delegate(),
		projectDocumentExportBrand: delegate(),
		$transaction: vi.fn(),
		$queryRaw: vi.fn(),
		$executeRaw: vi.fn(),
	};
	fake.$transaction.mockImplementation(
		async (run: (tx: typeof fake) => Promise<unknown>) => run(fake),
	);
	return fake;
});

vi.mock("../prisma/client", () => ({ db: fake }));

import {
	finishBrandSiteFetch,
	getBrandSiteFetch,
	startBrandSiteFetch,
} from "../prisma/queries/brand-site-fetch";
import { recordProposalExportBrand } from "../prisma/queries/projects/proposal-export-brand";
import {
	finishRecipientBrandSuggestion,
	getRecipientBrandSuggestion,
	startRecipientBrandSuggestion,
} from "../prisma/queries/projects/recipient-brand-suggestion";

const ORG = "org-a";
const PROJECT = "proj-a";
const NOW = new Date("2026-10-22T12:00:00Z");
const WRITES = [
	"upsert",
	"update",
	"updateMany",
	"create",
	"createMany",
] as const;

/** Every write the fake client was asked for on tables people own. */
function writesToPeopleOwnedTables(): string[] {
	const owned = {
		organizationBrandKit: fake.organizationBrandKit,
		projectRecipientBrand: fake.projectRecipientBrand,
		projectDocumentStyle: fake.projectDocumentStyle,
	};
	return Object.entries(owned).flatMap(([table, delegate]) =>
		WRITES.filter((method) => delegate[method].mock.calls.length > 0).map(
			(method) => `${table}.${method}`,
		),
	);
}

/** What the locked parent-row reads (`SELECT … FOR UPDATE`) answer. */
function seedLockedRows(rows: {
	kitWebsite?: string | null;
	recipient?: { website: string | null; organizationId: string } | null;
}) {
	fake.$queryRaw.mockImplementation(async (strings: TemplateStringsArray) => {
		const sql = strings.join("?");
		if (sql.includes("organization_brand_kit")) {
			return rows.kitWebsite === undefined
				? []
				: [{ website: rows.kitWebsite }];
		}
		if (sql.includes("project_recipient_brand")) {
			return rows.recipient ? [rows.recipient] : [];
		}
		return [];
	});
}

beforeEach(() => {
	vi.clearAllMocks();
	fake.organizationBrandSiteFetch.updateMany.mockResolvedValue({ count: 1 });
	fake.projectRecipientBrandSuggestion.updateMany.mockResolvedValue({
		count: 1,
	});
	fake.$executeRaw.mockResolvedValue(1);
	// No attempt stored unless a test says otherwise.
	fake.organizationBrandSiteFetch.findUnique.mockResolvedValue(null);
	fake.projectRecipientBrandSuggestion.findUnique.mockResolvedValue(null);
});

const ago = (ms: number) => new Date(NOW.getTime() - ms);

/**
 * Both start functions decide joining the same way; each case is the attempt
 * already stored and whether a new start for `website` joins it.
 */
const START_SUBJECTS = [
	{
		label: "the organization's website fetch",
		website: "https://example.com",
		seed: () => seedLockedRows({ kitWebsite: "https://example.com" }),
		current: fake.organizationBrandSiteFetch.findUnique,
		upsert: fake.organizationBrandSiteFetch.upsert,
		start: (extra: { failureCode?: "rate_limited" } = {}) =>
			startBrandSiteFetch({
				organizationId: ORG,
				website: "https://example.com",
				requestId: "req-new",
				requestedById: "user-1",
				requestedAt: NOW,
				...extra,
			}),
	},
	{
		label: "the recipient website fetch",
		website: "https://client.example.com",
		seed: () =>
			seedLockedRows({
				recipient: {
					website: "https://client.example.com",
					organizationId: ORG,
				},
			}),
		current: fake.projectRecipientBrandSuggestion.findUnique,
		upsert: fake.projectRecipientBrandSuggestion.upsert,
		start: (extra: { failureCode?: "rate_limited" } = {}) =>
			startRecipientBrandSuggestion({
				projectId: PROJECT,
				organizationId: ORG,
				website: "https://client.example.com",
				requestId: "req-new",
				requestedById: "user-1",
				requestedAt: NOW,
				...extra,
			}),
	},
];

describe.each(START_SUBJECTS)("joining in $label", (subject) => {
	const stored = (overrides: Record<string, unknown>) => ({
		website: subject.website,
		status: "RUNNING",
		requestedAt: ago(5_000),
		...overrides,
	});

	it("joins the same website's attempt running inside the window", async () => {
		subject.seed();
		subject.current.mockResolvedValue(stored({}));

		expect(await subject.start()).toBe("joined");
		expect(subject.upsert).not.toHaveBeenCalled();
	});

	it.each([
		[
			"a running attempt for another website",
			{ website: "https://other.example.com" },
		],
		[
			"an attempt exactly at the window",
			{ requestedAt: ago(BRAND_FETCH_JOIN_WINDOW_MS) },
		],
		["a succeeded attempt", { status: "SUCCEEDED" }],
		["a failed attempt", { status: "FAILED" }],
	])("starts over %s", async (_label, overrides) => {
		subject.seed();
		subject.current.mockResolvedValue(stored(overrides));

		expect(await subject.start()).toBe("started");
		expect(subject.upsert).toHaveBeenCalledTimes(1);
	});

	it("joins a fresh running attempt with a refused start instead of failing it", async () => {
		subject.seed();
		subject.current.mockResolvedValue(stored({}));

		expect(await subject.start({ failureCode: "rate_limited" })).toBe(
			"joined",
		);
		expect(subject.upsert).not.toHaveBeenCalled();
	});

	it("records a refused start as FAILED when nothing is running", async () => {
		subject.seed();
		subject.current.mockResolvedValue(stored({ status: "SUCCEEDED" }));

		expect(await subject.start({ failureCode: "rate_limited" })).toBe(
			"started",
		);
		expect(subject.upsert.mock.calls[0][0].update).toMatchObject({
			status: "FAILED",
			failureCode: "rate_limited",
		});
	});
});

describe("the organization's website fetch", () => {
	it("starts an attempt only while the Brand kit still names the website", async () => {
		seedLockedRows({ kitWebsite: "https://example.com" });

		expect(
			await startBrandSiteFetch({
				organizationId: ORG,
				website: "https://example.com",
				requestId: "req-1",
				requestedById: "user-1",
				requestedAt: NOW,
			}),
		).toBe("started");
		const [{ update }] =
			fake.organizationBrandSiteFetch.upsert.mock.calls[0];
		expect(update).toEqual({
			website: "https://example.com",
			requestId: "req-1",
			status: "RUNNING",
			failureCode: null,
			requestedById: "user-1",
			requestedAt: NOW,
		});
		// The attempt never names the result columns, so the last result stays.
		expect(update).not.toHaveProperty("primaryColor");

		fake.organizationBrandSiteFetch.upsert.mockClear();
		seedLockedRows({ kitWebsite: "https://new.example.com" });
		expect(
			await startBrandSiteFetch({
				organizationId: ORG,
				website: "https://example.com",
				requestId: "req-2",
				requestedById: "user-1",
				requestedAt: NOW,
			}),
		).toBe("stale");
		expect(fake.organizationBrandSiteFetch.upsert).not.toHaveBeenCalled();
	});

	it("joins a recent running attempt for the same website instead of starting another", async () => {
		seedLockedRows({ kitWebsite: "https://example.com" });
		fake.organizationBrandSiteFetch.findUnique.mockResolvedValue({
			website: "https://example.com",
			status: "RUNNING",
			requestedAt: new Date(NOW.getTime() - 5_000),
		});

		expect(
			await startBrandSiteFetch({
				organizationId: ORG,
				website: "https://example.com",
				requestId: "req-2",
				requestedById: "user-1",
				requestedAt: NOW,
			}),
		).toBe("joined");
		expect(fake.organizationBrandSiteFetch.upsert).not.toHaveBeenCalled();
		// The parent row is locked, so a concurrent start waits for this one.
		expect(fake.$queryRaw.mock.calls[0][0].join("?")).toContain(
			"FOR UPDATE",
		);
	});

	it("finishes only its own running attempt, writing the result for the website it fetched", async () => {
		const applied = await finishBrandSiteFetch({
			organizationId: ORG,
			requestId: "req-1",
			website: "https://example.com",
			outcome: {
				ok: true,
				primaryColor: "#0A2540",
				accentColors: [
					"#635BFF",
					"red",
					"#635bff",
					"#111111",
					"#222222",
				],
			},
			fetchedAt: NOW,
		});

		expect(applied).toBe(true);
		expect(fake.organizationBrandSiteFetch.updateMany).toHaveBeenCalledWith(
			{
				where: {
					organizationId: ORG,
					requestId: "req-1",
					status: "RUNNING",
				},
				data: {
					status: "SUCCEEDED",
					failureCode: null,
					resultWebsite: "https://example.com",
					primaryColor: "#0a2540",
					accentColors: ["#635bff", "#111111", "#222222"],
					fetchedAt: NOW,
				},
			},
		);
	});

	it("writes only the attempt on a failure, and nothing for a superseded attempt", async () => {
		await finishBrandSiteFetch({
			organizationId: ORG,
			requestId: "req-1",
			website: "https://example.com",
			outcome: { ok: false, failureCode: "blocked" },
			fetchedAt: NOW,
		});
		expect(
			fake.organizationBrandSiteFetch.updateMany.mock.calls[0][0].data,
		).toEqual({ status: "FAILED", failureCode: "blocked" });

		fake.organizationBrandSiteFetch.updateMany.mockResolvedValue({
			count: 0,
		});
		expect(
			await finishBrandSiteFetch({
				organizationId: ORG,
				requestId: "req-old",
				website: "https://example.com",
				outcome: {
					ok: true,
					primaryColor: "#0a2540",
					accentColors: [],
				},
				fetchedAt: NOW,
			}),
		).toBe(false);
	});

	it("reads the row by organization", async () => {
		fake.organizationBrandSiteFetch.findUnique.mockResolvedValue(null);
		expect(await getBrandSiteFetch(ORG)).toBeNull();
		expect(
			fake.organizationBrandSiteFetch.findUnique.mock.calls[0][0].where,
		).toEqual({ organizationId: ORG });
	});
});

describe("the recipient website fetch", () => {
	const recipient = {
		website: "https://client.example.com",
		organizationId: ORG,
	};

	it("starts an attempt only for the recipient brand's website in the same organization", async () => {
		seedLockedRows({ recipient });
		const start = (website: string, organizationId = ORG) =>
			startRecipientBrandSuggestion({
				projectId: PROJECT,
				organizationId,
				website,
				requestId: "req-1",
				requestedById: "user-1",
				requestedAt: NOW,
			});

		expect(await start("https://client.example.com")).toBe("started");
		expect(await start("https://other.example.com")).toBe("stale");
		expect(await start("https://client.example.com", "org-b")).toBe(
			"stale",
		);
		expect(
			fake.projectRecipientBrandSuggestion.upsert,
		).toHaveBeenCalledTimes(1);
	});

	it("stores a neutralized name, valid colours and only this project's suggested logo", async () => {
		fake.projectRecipientBrandSuggestion.findFirst.mockResolvedValue({
			logoKey: `project-brand/${PROJECT}/recipient-brand/suggested/req-0.png`,
		});

		const result = await finishRecipientBrandSuggestion({
			projectId: PROJECT,
			requestId: "req-1",
			website: "https://client.example.com",
			outcome: {
				ok: true,
				name: " Example‮ Client\n",
				colors: ["#0B3D91", "url(x)"],
				logoKey: `project-brand/${PROJECT}/recipient-brand/suggested/req-1.png`,
				logoHash: "a".repeat(64),
			},
			fetchedAt: NOW,
		});

		expect(result).toEqual({
			applied: true,
			previousLogoKey: `project-brand/${PROJECT}/recipient-brand/suggested/req-0.png`,
		});
		expect(
			fake.projectRecipientBrandSuggestion.updateMany.mock.calls[0][0],
		).toEqual({
			where: {
				projectId: PROJECT,
				requestId: "req-1",
				status: "RUNNING",
			},
			data: {
				status: "SUCCEEDED",
				failureCode: null,
				resultWebsite: "https://client.example.com",
				name: "Example Client",
				colors: ["#0b3d91"],
				logoKey: `project-brand/${PROJECT}/recipient-brand/suggested/req-1.png`,
				logoHash: "a".repeat(64),
				fetchedAt: NOW,
			},
		});
	});

	it("drops a logo key outside this project's suggested prefix", async () => {
		fake.projectRecipientBrandSuggestion.findFirst.mockResolvedValue({
			logoKey: null,
		});

		await finishRecipientBrandSuggestion({
			projectId: PROJECT,
			requestId: "req-1",
			website: "https://client.example.com",
			outcome: {
				ok: true,
				name: null,
				colors: [],
				logoKey:
					"project-brand/proj-b/recipient-brand/suggested/req-1.png",
				logoHash: "a".repeat(64),
			},
			fetchedAt: NOW,
		});

		expect(
			fake.projectRecipientBrandSuggestion.updateMany.mock.calls[0][0]
				.data,
		).toMatchObject({ logoKey: null, logoHash: null });
	});

	it("reports a superseded attempt so its caller can delete what it stored", async () => {
		fake.projectRecipientBrandSuggestion.findFirst.mockResolvedValue(null);

		expect(
			await finishRecipientBrandSuggestion({
				projectId: PROJECT,
				requestId: "req-old",
				website: "https://client.example.com",
				outcome: {
					ok: true,
					name: null,
					colors: [],
					logoKey: null,
					logoHash: null,
				},
				fetchedAt: NOW,
			}),
		).toEqual({ applied: false });
		expect(
			fake.projectRecipientBrandSuggestion.updateMany,
		).not.toHaveBeenCalled();
	});

	it("writes exactly the failed attempt on a failure", async () => {
		expect(
			await finishRecipientBrandSuggestion({
				projectId: PROJECT,
				requestId: "req-1",
				website: "https://client.example.com",
				outcome: { ok: false, failureCode: "no_logo" },
				fetchedAt: NOW,
			}),
		).toEqual({ applied: true, previousLogoKey: null });
		expect(
			fake.projectRecipientBrandSuggestion.updateMany,
		).toHaveBeenCalledWith({
			where: {
				projectId: PROJECT,
				requestId: "req-1",
				status: "RUNNING",
			},
			data: { status: "FAILED", failureCode: "no_logo" },
		});
	});

	it("reports a superseded failure as not applied", async () => {
		fake.projectRecipientBrandSuggestion.updateMany.mockResolvedValue({
			count: 0,
		});
		expect(
			await finishRecipientBrandSuggestion({
				projectId: PROJECT,
				requestId: "req-old",
				website: "https://client.example.com",
				outcome: { ok: false, failureCode: "blocked" },
				fetchedAt: NOW,
			}),
		).toEqual({ applied: false });
	});

	it("reads the suggestion in the owning organization only", async () => {
		fake.projectRecipientBrandSuggestion.findFirst.mockResolvedValue(null);
		await getRecipientBrandSuggestion({
			projectId: PROJECT,
			organizationId: ORG,
		});
		expect(
			fake.projectRecipientBrandSuggestion.findFirst.mock.calls[0][0]
				.where,
		).toEqual({ projectId: PROJECT, organizationId: ORG });
	});
});

describe("the export record", () => {
	const record = (exportedAt: Date) =>
		recordProposalExportBrand({
			documentId: "doc-a",
			projectId: PROJECT,
			organizationId: ORG,
			themeTokenHash: "t2:0123456789abcdef",
			format: "PDF",
			exportedAt,
		});

	/** The statement text and its parameters, as `$executeRaw` was called. */
	function statement() {
		const [strings, ...values] = fake.$executeRaw.mock.calls[0] as [
			TemplateStringsArray,
			...unknown[],
		];
		return { sql: strings.join("?").replace(/\s+/g, " "), values };
	}

	it("writes the export's token hash in one conditional upsert", async () => {
		expect(await record(NOW)).toBe(true);

		expect(fake.$executeRaw).toHaveBeenCalledTimes(1);
		expect(fake.$transaction).not.toHaveBeenCalled();
		const { sql, values } = statement();
		expect(sql).toContain('INSERT INTO "project_document_export_brand"');
		expect(sql).toContain('ON CONFLICT ("documentId") DO UPDATE SET');
		expect(sql).toContain(
			'WHERE excluded."exportedAt" >= "project_document_export_brand"."exportedAt"',
		);
		// Every NOT NULL column without a default is supplied.
		for (const column of ['"id"', '"createdAt"', '"updatedAt"']) {
			expect(sql).toContain(column);
		}
		expect(values).toEqual([
			expect.stringMatching(/^[0-9a-f-]{36}$/),
			"doc-a",
			PROJECT,
			ORG,
			"t2:0123456789abcdef",
			"PDF",
			NOW,
		]);
	});

	it("reports a row a later-started export already holds as not written", async () => {
		fake.$executeRaw.mockResolvedValue(0);
		expect(await record(NOW)).toBe(false);
	});

	it("refuses a hash of an unknown shape", async () => {
		await expect(
			recordProposalExportBrand({
				documentId: "doc-a",
				projectId: PROJECT,
				organizationId: ORG,
				themeTokenHash: "not-a-hash",
				format: "PDF",
				exportedAt: NOW,
			}),
		).rejects.toThrow();
		expect(fake.$executeRaw).not.toHaveBeenCalled();
	});
});

describe("automated writers", () => {
	it("never write a table a person owns", async () => {
		seedLockedRows({
			kitWebsite: "https://example.com",
			recipient: {
				website: "https://client.example.com",
				organizationId: ORG,
			},
		});
		fake.projectRecipientBrandSuggestion.findFirst.mockResolvedValue({
			logoKey: null,
		});

		await startBrandSiteFetch({
			organizationId: ORG,
			website: "https://example.com",
			requestId: "r",
			requestedById: "u",
			requestedAt: NOW,
		});
		await finishBrandSiteFetch({
			organizationId: ORG,
			requestId: "r",
			website: "https://example.com",
			outcome: { ok: true, primaryColor: "#0a2540", accentColors: [] },
			fetchedAt: NOW,
		});
		await startRecipientBrandSuggestion({
			projectId: PROJECT,
			organizationId: ORG,
			website: "https://client.example.com",
			requestId: "r",
			requestedById: "u",
			requestedAt: NOW,
		});
		await finishRecipientBrandSuggestion({
			projectId: PROJECT,
			requestId: "r",
			website: "https://client.example.com",
			outcome: {
				ok: true,
				name: "X",
				colors: [],
				logoKey: null,
				logoHash: null,
			},
			fetchedAt: NOW,
		});
		await recordProposalExportBrand({
			documentId: "doc-a",
			projectId: PROJECT,
			organizationId: ORG,
			themeTokenHash: "t2:0123456789abcdef",
			format: "DOCX",
			exportedAt: NOW,
		});

		expect(writesToPeopleOwnedTables()).toEqual([]);
		// The one raw write is the export record's own table.
		for (const [strings] of fake.$executeRaw.mock.calls) {
			const sql = (strings as TemplateStringsArray).join("?");
			expect(sql).toContain('INTO "project_document_export_brand"');
			expect(sql).not.toMatch(
				/organization_brand_kit"|project_recipient_brand"|project_document_style/,
			);
		}
	});
});
