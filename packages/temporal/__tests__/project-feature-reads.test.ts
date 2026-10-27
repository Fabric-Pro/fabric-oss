/**
 * The chat's live roadmap reads (Fizzy #2309/#2310). Pinned here: the access
 * gate (a project the user cannot reach — another organization's included —
 * is refused before any story query runs), the project scoping of every query,
 * the status-name filter the model can actually use, identifier matching for
 * the forms people type ("F-040", "F40", "40"), a typed prefix never resolving
 * to another kind ("F-001" returned bug B-001), and the list counting what the
 * roadmap page counts.
 */

import { beforeEach, describe, expect, it, vi } from "vitest";

const h = vi.hoisted(() => ({
	getProjectAccessContext: vi.fn(),
	listStorySummaries: vi.fn(),
	getStoryById: vi.fn(),
	statusFindMany: vi.fn(),
	storyFindMany: vi.fn(),
	storyFindFirst: vi.fn(),
}));

vi.mock("@repo/database", () => ({
	getProjectAccessContext: h.getProjectAccessContext,
	listStorySummaries: h.listStorySummaries,
	getStoryById: h.getStoryById,
	db: {
		projectStoryStatus: { findMany: h.statusFindMany },
		userStory: { findMany: h.storyFindMany, findFirst: h.storyFindFirst },
	},
}));

const {
	featureIdentifierCandidates,
	getProjectFeature,
	listProjectFeatures,
	PROJECT_FEATURE_TOOL_IDS,
} = await import("../src/activities/shared/project-feature-reads");

const CTX = { projectId: "p-1", userId: "u-1" };

const summary = {
	updatedAt: new Date("2026-09-20T00:00:00Z"),
	id: "s-1",
	identifier: "F-040",
	title: "Checkout",
	kind: "FEATURE",
	status: { id: "st-review", name: "In Review", color: "#000" },
	priority: "P1_HIGH",
	draftingStage: "PUBLISHED",
	taskCount: 3,
	completedTaskCount: 1,
};

const story = {
	id: "s-1",
	identifier: "F-040",
	title: "Checkout",
	kind: "FEATURE",
	status: { name: "In Review", isFinal: false },
	priority: "P1_HIGH",
	size: "M",
	storyPoints: 5,
	draftingStage: "PUBLISHED",
	description: "Pay with a saved card.",
	acceptanceCriteria: "- Given a saved card…",
	externalUrl: null,
	updatedAt: new Date("2026-09-20T00:00:00Z"),
	tasks: [
		{
			identifier: "TASK-001",
			title: "API",
			isCompleted: true,
			description: null,
			subtasks: [],
		},
		{
			identifier: "TASK-002",
			title: "UI",
			isCompleted: false,
			description: "Form",
			subtasks: [{ isCompleted: true }, { isCompleted: false }],
		},
	],
};

beforeEach(() => {
	vi.clearAllMocks();
	h.getProjectAccessContext.mockResolvedValue({ organizationId: "org-1" });
	h.listStorySummaries.mockResolvedValue({ stories: [summary], total: 41 });
	h.storyFindMany.mockResolvedValue([
		{ id: "s-1", description: "Pay with a saved card." },
	]);
	h.statusFindMany.mockResolvedValue([
		{ id: "st-backlog", name: "Backlog" },
		{ id: "st-review", name: "In Review" },
	]);
});

describe("access", () => {
	it("refuses a project the user cannot reach and queries nothing", async () => {
		// getProjectAccessContext answers null for a project in an organization
		// the user is not a member (or invited guest) of.
		h.getProjectAccessContext.mockResolvedValue(null);

		const list = await listProjectFeatures({}, CTX);
		const get = await getProjectFeature({ feature: "F-040" }, CTX);

		expect(list).toEqual({ error: "Project not found or access denied." });
		expect(get).toEqual({ error: "Project not found or access denied." });
		expect(h.getProjectAccessContext).toHaveBeenCalledWith("p-1", "u-1");
		expect(h.listStorySummaries).not.toHaveBeenCalled();
		expect(h.getStoryById).not.toHaveBeenCalled();
		expect(h.storyFindMany).not.toHaveBeenCalled();
	});

	it("asks for a project when none is attached", async () => {
		const res = await listProjectFeatures({}, { userId: "u-1" });
		expect(res).toMatchObject({
			error: expect.stringContaining("project"),
		});
		expect(h.getProjectAccessContext).not.toHaveBeenCalled();
	});

	it("exports exactly the two read tool ids", () => {
		expect([...PROJECT_FEATURE_TOOL_IDS]).toEqual([
			"fabric_list_project_features",
			"fabric_get_project_feature",
		]);
	});
});

describe("listProjectFeatures", () => {
	it("passes updated ordering to the query before paging and returns update time", async () => {
		const result = await listProjectFeatures(
			{ sort: "updated", offset: 5, limit: 5 },
			CTX,
		);
		expect(h.listStorySummaries).toHaveBeenCalledWith(
			expect.objectContaining({
				orderBy: "updated",
				offset: 5,
				limit: 5,
			}),
		);
		expect(result).toMatchObject({
			features: [{ updatedAt: "2026-09-20T00:00:00.000Z" }],
		});
	});

	it("rejects an unsupported sort", async () => {
		expect(await listProjectFeatures({ sort: "oldest" }, CTX)).toEqual({
			error: 'sort must be "identifier" or "updated".',
		});
		expect(h.listStorySummaries).not.toHaveBeenCalled();
	});

	it("filters by status NAME, case-insensitively, within the project", async () => {
		const res = await listProjectFeatures(
			{ status: "in review", limit: 10 },
			CTX,
		);

		expect(h.statusFindMany).toHaveBeenCalledWith(
			expect.objectContaining({ where: { projectId: "p-1" } }),
		);
		expect(h.listStorySummaries).toHaveBeenCalledWith(
			expect.objectContaining({
				projectId: "p-1",
				statusId: "st-review",
				limit: 10,
				offset: 0,
				orderBy: "identifier",
			}),
		);
		expect(res).toEqual({
			summary:
				"41 items on the roadmap matching these filters; 41 items closed and hidden, already excluded from total — report 41, never subtract the hidden count. total covers every page, not just the items below. Returned 1 of 41 items. Continue with offset=1 and the same filters and sort.",
			features: [
				{
					id: "s-1",
					identifier: "F-040",
					title: "Checkout",
					kind: "FEATURE",
					status: "In Review",
					priority: "P1_HIGH",
					draftingStage: "PUBLISHED",
					tasks: "1/3 done",
					description: "Pay with a saved card.",
					updatedAt: "2026-09-20T00:00:00.000Z",
				},
			],
			total: 41,
			hiddenCount: 41,
			hasMore: true,
			nextOffset: 1,
		});
	});

	it("counts what the roadmap shows: no declined items, closed ones reported as hidden", async () => {
		h.listStorySummaries.mockImplementation(
			async (options: { draftingStage?: string }) =>
				options.draftingStage === "CLOSED"
					? { stories: [summary], total: 8 }
					: { stories: [summary], total: 199 },
		);

		const res = await listProjectFeatures({ kind: "FEATURE" }, CTX);

		expect(h.listStorySummaries).toHaveBeenCalledWith(
			expect.objectContaining({
				kind: "FEATURE",
				excludeDraftingStages: ["DECLINED", "CLOSED"],
				orderBy: "identifier",
			}),
		);
		// The hidden count runs under the same filters.
		expect(h.listStorySummaries).toHaveBeenCalledWith(
			expect.objectContaining({
				kind: "FEATURE",
				draftingStage: "CLOSED",
			}),
		);
		expect(res).toMatchObject({ total: 199, hiddenCount: 8 });
	});

	it("states that total already excludes the hidden items, so they are never subtracted", async () => {
		h.listStorySummaries.mockImplementation(
			async (options: { draftingStage?: string }) =>
				options.draftingStage === "CLOSED"
					? { stories: [], total: 8 }
					: { stories: [summary], total: 199 },
		);

		const res = await listProjectFeatures({}, CTX);

		expect(res).toMatchObject({ total: 199, hiddenCount: 8 });
		const text = (res as { summary: string }).summary;
		expect(text).toMatch(
			/^199 items on the roadmap; 8 items closed and hidden, already excluded from total/,
		);
		expect(text).toContain("report 199");
		expect(text).not.toContain("191");
		expect(text).not.toContain("matching these filters");
	});

	it("summarises an includeHidden listing without a hidden count", async () => {
		h.listStorySummaries.mockResolvedValue({
			stories: [summary],
			total: 1,
		});

		const res = await listProjectFeatures({ includeHidden: true }, CTX);

		expect(res).toMatchObject({
			summary:
				"1 item, closed items included; declined items are never listed. Returned 1 of 1 items.",
		});
	});

	it("lists closed items with includeHidden, still never declined ones", async () => {
		const res = await listProjectFeatures({ includeHidden: true }, CTX);

		expect(h.listStorySummaries).toHaveBeenCalledTimes(1);
		expect(h.listStorySummaries).toHaveBeenCalledWith(
			expect.objectContaining({ excludeDraftingStages: ["DECLINED"] }),
		);
		expect(res).not.toHaveProperty("hiddenCount");
	});

	it("scopes the description lookup to the project", async () => {
		await listProjectFeatures({}, CTX);
		expect(h.storyFindMany).toHaveBeenCalledWith(
			expect.objectContaining({
				where: { projectId: "p-1", id: { in: ["s-1"] } },
			}),
		);
	});

	it("names the valid statuses when the requested one does not exist", async () => {
		const res = await listProjectFeatures({ status: "Shipped" }, CTX);
		expect(res).toMatchObject({
			error: expect.stringContaining("Backlog, In Review"),
		});
		expect(h.listStorySummaries).not.toHaveBeenCalled();
	});

	it("clamps the limit and rejects an unknown priority", async () => {
		await listProjectFeatures({ limit: 5000 }, CTX);
		expect(h.listStorySummaries).toHaveBeenCalledWith(
			expect.objectContaining({ limit: 100 }),
		);
		expect(
			await listProjectFeatures({ priority: "URGENT" }, CTX),
		).toMatchObject({ error: expect.stringContaining("priority") });
	});
});

describe("getProjectFeature", () => {
	it("resolves a typed identifier within the project and returns full detail", async () => {
		h.getStoryById.mockImplementation(async (id: string) =>
			id === "s-1" ? story : null,
		);
		h.storyFindMany.mockResolvedValue([
			{ id: "s-1", identifier: "F-040", kind: "FEATURE" },
		]);

		const res = await getProjectFeature({ feature: "f40" }, CTX);

		expect(h.getStoryById).toHaveBeenNthCalledWith(1, "f40", "p-1");
		const where = h.storyFindMany.mock.calls[0][0].where;
		expect(where.projectId).toBe("p-1");
		expect(h.getStoryById).toHaveBeenLastCalledWith("s-1", "p-1");
		expect(res).toMatchObject({
			identifier: "F-040",
			status: "In Review",
			acceptanceCriteria: "- Given a saved card…",
			tasksSummary: "1/2 tasks done",
			tasks: [
				expect.objectContaining({ identifier: "TASK-001" }),
				expect.objectContaining({ subtasks: "1/2 done" }),
			],
		});
	});

	it("marks an item the roadmap shows as on the roadmap", async () => {
		h.getStoryById.mockResolvedValue(story);

		const res = await getProjectFeature({ feature: "s-1" }, CTX);

		expect(res).toMatchObject({ identifier: "F-040", onRoadmap: true });
		expect(res).not.toHaveProperty("hiddenReason");
		expect(res).not.toHaveProperty("note");
	});

	it("says a declined item exists but is never on the roadmap", async () => {
		h.getStoryById.mockResolvedValue({
			...story,
			identifier: "B-001",
			kind: "BUG",
			draftingStage: "DECLINED",
		});

		const res = await getProjectFeature({ feature: "B-001" }, CTX);

		expect(res).toMatchObject({
			identifier: "B-001",
			draftingStage: "DECLINED",
			onRoadmap: false,
			hiddenReason: "declined",
			note: expect.stringContaining("B-001 exists but was declined"),
		});
	});

	it("says a closed item exists and where the roadmap shows it", async () => {
		h.getStoryById.mockResolvedValue({ ...story, draftingStage: "CLOSED" });

		const res = await getProjectFeature({ feature: "F-040" }, CTX);

		expect(res).toMatchObject({
			onRoadmap: false,
			hiddenReason: "closed",
			note: expect.stringContaining("includeHidden=true"),
		});
	});

	it("says the feature is missing rather than guessing", async () => {
		h.getStoryById.mockResolvedValue(null);
		h.storyFindMany.mockResolvedValue([]);
		const res = await getProjectFeature({ feature: "F-999" }, CTX);
		expect(res).toMatchObject({ error: expect.stringContaining("F-999") });
	});

	/** Rows the identifier lookup returns; getStoryById resolves their ids. */
	function withRows(
		rows: Array<{ id: string; identifier: string; kind: string }>,
	) {
		h.storyFindMany.mockResolvedValue(rows);
		h.getStoryById.mockImplementation(async (id: string) => {
			const row = rows.find((r) => r.id === id);
			return row ? { ...story, ...row } : null;
		});
	}

	it("never answers F-001 with a bug (legacy B-001 or a bug numbered 1)", async () => {
		withRows([
			{ id: "bug-legacy", identifier: "B-001", kind: "BUG" },
			{ id: "bug-plain", identifier: "1", kind: "BUG" },
		]);

		const res = await getProjectFeature({ feature: "F-001" }, CTX);

		expect(res).toEqual({
			error: 'No feature "F-001" in this project. Use fabric_list_project_features to find it.',
		});
	});

	it("resolves F-001 to a feature numbered 1", async () => {
		withRows([
			{ id: "bug-legacy", identifier: "B-001", kind: "BUG" },
			{ id: "feat-plain", identifier: "1", kind: "FEATURE" },
		]);

		const res = await getProjectFeature({ feature: "F-001" }, CTX);

		expect(res).toMatchObject({ id: "feat-plain", identifier: "1" });
	});

	it("prefers the exact identifier over any other candidate", async () => {
		// Returned in the order a database might: the plain-number row first.
		withRows([
			{ id: "feat-plain", identifier: "1", kind: "FEATURE" },
			{ id: "feat-legacy", identifier: "F-001", kind: "FEATURE" },
		]);

		expect(
			await getProjectFeature({ feature: "F-001" }, CTX),
		).toMatchObject({ id: "feat-legacy" });
		expect(await getProjectFeature({ feature: "1" }, CTX)).toMatchObject({
			id: "feat-plain",
		});
	});

	it("tries a bare number as plain, then F-, then B-", async () => {
		withRows([
			{ id: "bug-legacy", identifier: "B-007", kind: "BUG" },
			{ id: "feat-legacy", identifier: "F-007", kind: "FEATURE" },
		]);
		expect(await getProjectFeature({ feature: "7" }, CTX)).toMatchObject({
			id: "feat-legacy",
		});
	});

	it("names a bug reference as a bug when it is missing", async () => {
		withRows([{ id: "feat-legacy", identifier: "F-002", kind: "FEATURE" }]);
		expect(
			await getProjectFeature({ feature: "B-002" }, CTX),
		).toMatchObject({
			error: expect.stringContaining('No bug "B-002"'),
		});
	});

	it("refuses a task identifier instead of mapping it to a feature number", async () => {
		h.getStoryById.mockResolvedValue(null);
		const res = await getProjectFeature({ feature: "TASK-005" }, CTX);
		expect(res).toMatchObject({
			error: expect.stringContaining("task identifier"),
		});
		expect(h.storyFindMany).not.toHaveBeenCalled();
	});

	it("requires a feature reference", async () => {
		expect(await getProjectFeature({}, CTX)).toMatchObject({
			error: expect.stringContaining("feature is required"),
		});
	});
});

describe("featureIdentifierCandidates", () => {
	const ids = (ref: string) =>
		featureIdentifierCandidates(ref).map((c) =>
			c.kind ? `${c.identifier}:${c.kind}` : c.identifier,
		);

	it.each(["F-040", "f40", "F-40"])(
		"%s reaches legacy F- and plain-decimal FEATURE rows, nothing else",
		(ref) => {
			const got = ids(ref);
			expect(got[0]).toBe(ref);
			expect(got).toEqual(
				expect.arrayContaining(["F-040", "40:FEATURE", "040:FEATURE"]),
			);
			expect(
				got.some((c) => c.startsWith("B-") || c.startsWith("US-")),
			).toBe(false);
		},
	);

	it("B-002 stays with bugs", () => {
		expect(ids("B-002")).toEqual(["B-002", "B-2", "2:BUG", "002:BUG"]);
	});

	it("a bare number tries plain, then F-, US-, B-", () => {
		expect(ids("040")).toEqual([
			"040",
			"40",
			"F-040",
			"F-40",
			"US-040",
			"US-40",
			"B-040",
			"B-40",
		]);
	});

	it("leaves a non-identifier reference alone", () => {
		expect(ids("cm1abcdef")).toEqual(["cm1abcdef"]);
	});
});

describe("compact feature results", () => {
	it("stops a list at the serialized budget and continues at the first omitted row", async () => {
		const rows = Array.from({ length: 100 }, (_, i) => ({
			...summary,
			id: `s-${i}`,
			identifier: `F-${i}`,
			title: "Checkout requirement ".repeat(8),
		}));
		h.listStorySummaries.mockResolvedValue({ stories: rows, total: 150 });
		h.storyFindMany.mockResolvedValue(
			rows.map((r) => ({
				id: r.id,
				description: "Detailed requirement ".repeat(20),
			})),
		);
		const result = (await listProjectFeatures(
			{ limit: 100, offset: 7 },
			CTX,
		)) as {
			features: typeof rows;
			nextOffset: number;
			hasMore: boolean;
			summary: string;
		};
		expect(JSON.stringify(result).length).toBeLessThanOrEqual(10000);
		expect(result.features.length).toBeGreaterThan(0);
		expect(result.features.length).toBeLessThan(100);
		expect(result.hasMore).toBe(true);
		expect(result.nextOffset).toBe(7 + result.features.length);
		expect(result.features.map((r) => r.id)).toEqual(
			rows.slice(0, result.features.length).map((r) => r.id),
		);
		expect(result.summary).toContain(
			`Returned ${result.features.length} of 150`,
		);
		expect(result.summary).toContain(`offset=${result.nextOffset}`);
	});
	it("returns a complete page when it fits", async () => {
		h.listStorySummaries.mockResolvedValue({
			stories: [summary],
			total: 1,
		});
		const result = await listProjectFeatures({}, CTX);
		expect(result).toMatchObject({
			features: [
				expect.objectContaining({
					id: "s-1",
					title: "Checkout",
					status: "In Review",
				}),
			],
			hasMore: false,
		});
		expect(result).not.toHaveProperty("nextOffset");
	});
	it.each([
		["main text", 18000, 5],
		["many tasks", 3000, 80],
	] as const)(
		"fits detail with %s and marks field cuts",
		async (_label, chars, tasks) => {
			const fixture = {
				...story,
				description: "Requirement\n".repeat(chars / 12),
				acceptanceCriteria: "Acceptance\n".repeat(chars / 11),
				tasks: Array.from({ length: tasks }, (_, i) => ({
					...story.tasks[1],
					identifier: `TASK-${i}`,
					description: "Task implementation details. ".repeat(30),
				})),
			};
			h.getStoryById.mockResolvedValue(fixture);
			const result = (await getProjectFeature(
				{ feature: "s-1" },
				CTX,
			)) as {
				truncations: { field: string; shown: number; total: number }[];
				description: string | null;
				acceptanceCriteria: string | null;
				tasks: Array<{ description: string | null }>;
			};
			expect(JSON.stringify(result).length).toBeLessThanOrEqual(10000);
			expect(result.truncations.length).toBeGreaterThan(0);
			for (const cut of result.truncations) {
				expect(cut.field).toBeTruthy();
				if (cut.field === "tasks[].description") {
					expect(cut).toMatchObject({
						count: result.tasks.length,
						next: { section: "tasks", offset: 0 },
					});
					continue;
				}
				expect(cut.shown).toBeLessThan(cut.total);
				if (cut.field === "tasks") {
					expect(cut.shown).toBe(result.tasks.length);
					expect(cut.total).toBe(fixture.tasks.length);
				} else {
					const index = cut.field.match(
						/^tasks\[(\d+)\]\.description$/,
					)?.[1];
					const field = cut.field as
						| "description"
						| "acceptanceCriteria";
					const original =
						index === undefined
							? fixture[field].trim()
							: fixture.tasks[Number(index)].description.trim();
					const shown =
						index === undefined
							? result[field]
							: result.tasks[Number(index)].description;
					expect(cut.total).toBe(original.length);
					expect(cut.shown).toBe(shown ? shown.length - 1 : 0);
				}
			}
			if (_label === "main text") {
				expect(result.tasks.every((t) => t.description === null)).toBe(
					true,
				);
				expect(result.truncations.map((c) => c.field)).toContain(
					"description",
				);
				expect(result.truncations.map((c) => c.field)).toContain(
					"acceptanceCriteria",
				);
			}
			expect(
				result.truncations.some((c) => c.field.startsWith("tasks")),
			).toBe(true);
		},
	);
	it("preserves a small feature detail exactly", async () => {
		h.getStoryById.mockResolvedValue(story);
		expect(await getProjectFeature({ feature: "s-1" }, CTX)).toEqual({
			id: story.id,
			identifier: story.identifier,
			title: story.title,
			kind: story.kind,
			onRoadmap: true,
			status: story.status.name,
			statusIsFinal: false,
			priority: story.priority,
			size: story.size,
			storyPoints: story.storyPoints,
			draftingStage: story.draftingStage,
			description: story.description,
			acceptanceCriteria: story.acceptanceCriteria,
			externalUrl: null,
			tasksSummary: "1/2 tasks done",
			tasks: [
				{
					identifier: "TASK-001",
					title: "API",
					isCompleted: true,
					description: null,
					subtasks: "0/0 done",
				},
				{
					identifier: "TASK-002",
					title: "UI",
					isCompleted: false,
					description: "Form",
					subtasks: "1/2 done",
				},
			],
			updatedAt: story.updatedAt,
		});
	});
});

it("retains feature identity when task metadata and cut markers nearly fill the budget", async () => {
	for (const count of [50, 62, 80, 160]) {
		h.getStoryById.mockResolvedValue({
			...story,
			description: "Requirement ".repeat(250),
			acceptanceCriteria: "Acceptance ".repeat(250),
			tasks: Array.from({ length: count }, (_, i) => ({
				...story.tasks[1],
				identifier: `TASK-${i}`,
				description: "Task details ".repeat(60),
			})),
		});
		const result = await getProjectFeature({ feature: "s-1" }, CTX);
		expect(result, `task count ${count}`).toHaveProperty("id", "s-1");
		expect(JSON.stringify(result).length).toBeLessThanOrEqual(10000);
	}
});

type PageContinuation = {
	section: "description" | "acceptanceCriteria" | "tasks";
	offset: number;
};
type DetailPage = {
	content: string;
	offset: number;
	hasMore: boolean;
	nextOffset: number;
	tasks: Array<{ identifier: string; description: string | null }>;
};
type DetailOverview = {
	description: string;
	acceptanceCriteria: string;
	tasks: DetailPage["tasks"];
	truncations: Array<{
		field: string;
		shown: number;
		total: number;
		next: PageContinuation;
	}>;
};

describe("feature detail continuation", () => {
	it.each(["description", "acceptanceCriteria"] as const)(
		"reassembles %s from the overview and character pages",
		async (section) => {
			const text = "A launch requirement with emoji 🚀.\n"
				.repeat(900)
				.trim();
			h.getStoryById.mockResolvedValue({
				...story,
				[section]: text,
				tasks: [],
			});
			const overview = (await getProjectFeature(
				{ feature: "s-1" },
				CTX,
			)) as DetailOverview;
			const cut = overview.truncations.find((c) => c.field === section);
			if (!cut) {
				throw new Error("Expected an overview text continuation");
			}
			expect(cut.next).toEqual({ section, offset: cut.shown });
			let offset = cut.next.offset;
			let reconstructed = overview[section].slice(0, -1);
			do {
				const page = (await getProjectFeature(
					{ feature: "s-1", section, offset },
					CTX,
				)) as DetailPage;
				expect(JSON.stringify(page).length).toBeLessThanOrEqual(10000);
				expect(page.offset).toBe(offset);
				reconstructed += page.content;
				if (!page.hasMore) {
					break;
				}
				expect(page.nextOffset).toBeGreaterThan(offset);
				offset = page.nextOffset;
			} while (offset < Array.from(text).length);
			expect(reconstructed).toBe(text);
		},
	);

	it("returns a section remainder that fits whole, without a further page", async () => {
		const criteria = "- a\n- b\n- c";
		h.getStoryById.mockResolvedValue({
			...story,
			acceptanceCriteria: criteria,
			tasks: [],
		});
		const page = (await getProjectFeature(
			{ feature: "s-1", section: "acceptanceCriteria", offset: 0 },
			CTX,
		)) as DetailPage;
		expect(page.content).toBe(criteria);
		expect(page.hasMore).toBe(false);
		expect(page).not.toHaveProperty("nextOffset");
	});

	it("pages tasks by index and exposes continuations for omitted rows and task descriptions", async () => {
		const tasks = Array.from({ length: 160 }, (_, i) => ({
			...story.tasks[1],
			identifier: `TASK-${i}`,
			description: "Implementation detail. ".repeat(80),
		}));
		h.getStoryById.mockResolvedValue({ ...story, tasks });
		const overview = (await getProjectFeature(
			{ feature: "s-1" },
			CTX,
		)) as DetailOverview;
		const cuts = overview.truncations as Array<{
			field: string;
			shown: number;
			total: number;
			next: { section: string; offset: number };
		}>;
		expect(cuts.find((c) => c.field === "tasks")).toMatchObject({
			shown: overview.tasks.length,
			total: tasks.length,
			next: { section: "tasks", offset: overview.tasks.length },
		});
		expect(
			cuts.find((c) => c.field === "tasks[].description")?.next,
		).toEqual({ section: "tasks", offset: 0 });
		const read: string[] = [];
		let offset = 0;
		do {
			const page = (await getProjectFeature(
				{ feature: "s-1", section: "tasks", offset },
				CTX,
			)) as DetailPage;
			expect(JSON.stringify(page).length).toBeLessThanOrEqual(10000);
			for (const task of page.tasks) {
				read.push(task.identifier);
				expect(task.description).toBe(tasks[0].description.trim());
			}
			if (!page.hasMore) {
				break;
			}
			expect(page.nextOffset).toBeGreaterThan(offset);
			offset = page.nextOffset;
		} while (offset < tasks.length);
		expect(read).toEqual(tasks.map((t) => t.identifier));
	});

	it("gives a section continuation when overview metadata alone exceeds the budget", async () => {
		h.getStoryById.mockResolvedValue({
			...story,
			title: "Metadata ".repeat(2000),
		});
		const overview = (await getProjectFeature({ feature: "s-1" }, CTX)) as {
			error: string;
			next: PageContinuation;
		};
		expect(overview.error).toBeTruthy();
		expect(overview.next).toEqual({ section: "description", offset: 0 });
		const page = (await getProjectFeature(
			{ feature: "s-1", ...overview.next },
			CTX,
		)) as DetailPage;
		expect(page.content).toBe(story.description);
		expect(JSON.stringify(page).length).toBeLessThanOrEqual(10000);
	});

	it("names a usable feature read when a single list row exceeds the budget", async () => {
		h.listStorySummaries.mockResolvedValue({
			stories: [{ ...summary, title: "Metadata ".repeat(2000) }],
			total: 1,
		});
		const result = (await listProjectFeatures({}, CTX)) as Record<
			string,
			unknown
		>;
		expect(result.error).toContain("fabric_get_project_feature");
		expect(result.feature).toBe("s-1");
	});

	it("gives a concrete task and UI action for a task too large to page by index", async () => {
		h.getStoryById.mockResolvedValue({
			...story,
			tasks: [
				{ ...story.tasks[0], description: "Huge task ".repeat(3000) },
			],
		});
		const result = (await getProjectFeature(
			{ feature: "s-1", section: "tasks", offset: 0 },
			CTX,
		)) as Record<string, unknown>;
		expect(result.error).toContain("roadmap");
		expect(result.task).toBe("TASK-001");
		expect(result.feature).toBe("s-1");
		expect(JSON.stringify(result).length).toBeLessThanOrEqual(10000);
	});
});

it("keeps recovery arguments in error text for the Advisor's string-only error projection", async () => {
	h.getStoryById.mockResolvedValue({
		...story,
		title: "Metadata ".repeat(2000),
	});
	const detail = (await getProjectFeature({ feature: "s-1" }, CTX)) as {
		error: string;
	};
	expect(detail.error).toContain(
		'fabric_get_project_feature({"feature":"s-1","section":"description","offset":0})',
	);
	h.listStorySummaries.mockResolvedValue({
		stories: [{ ...summary, title: "Metadata ".repeat(2000) }],
		total: 2,
	});
	const list = (await listProjectFeatures({}, CTX)) as { error: string };
	expect(list.error).toContain(
		'fabric_get_project_feature({"feature":"s-1","section":"description","offset":0})',
	);
	expect(list.error).toContain("offset=1");
	h.getStoryById.mockResolvedValue({
		...story,
		tasks: [
			{ ...story.tasks[0], description: "Huge task ".repeat(3000) },
			story.tasks[1],
		],
	});
	const tasks = (await getProjectFeature(
		{ feature: "s-1", section: "tasks", offset: 0 },
		CTX,
	)) as { error: string };
	expect(tasks.error).toContain("TASK-001");
	expect(tasks.error).toContain("F-040");
	expect(tasks.error).toContain(
		'fabric_get_project_feature({"feature":"s-1","section":"tasks","offset":1})',
	);
});

it("aggregates task description omissions without spending the main text budget on per-task notes", async () => {
	const tasks = Array.from({ length: 40 }, (_, i) => ({
		...story.tasks[1],
		identifier: `TASK-${i}`,
		description: "T".repeat(900),
	}));
	h.getStoryById.mockResolvedValue({
		...story,
		description: "D".repeat(2500),
		acceptanceCriteria: "A".repeat(1000),
		tasks,
	});
	const result = (await getProjectFeature(
		{ feature: "s-1" },
		CTX,
	)) as DetailOverview;
	expect(result.description).toBe("D".repeat(2500));
	expect(result.acceptanceCriteria).toBe("A".repeat(1000));
	expect(result.tasks).toHaveLength(40);
	expect(result.truncations).toEqual([
		{
			field: "tasks[].description",
			count: 40,
			next: { section: "tasks", offset: 0 },
		},
	]);
	expect(JSON.stringify(result.truncations).length).toBeLessThan(150);
	expect(JSON.stringify(result).length).toBeLessThanOrEqual(10000);
});

it("uses Unicode characters for the task description opening cap", async () => {
	const description = `😀${"x".repeat(400)}`;
	h.getStoryById.mockResolvedValue({
		...story,
		tasks: [{ ...story.tasks[1], description }],
	});
	const result = (await getProjectFeature(
		{ feature: "s-1" },
		CTX,
	)) as DetailOverview;
	expect(result.tasks[0].description).toBe(`😀${"x".repeat(298)}…`);
});

it("reconstructs overview text with an astral character exactly across the cut", async () => {
	const fixture = {
		...story,
		description: "x".repeat(18000),
		acceptanceCriteria: null,
		tasks: [],
	};
	h.getStoryById.mockResolvedValue(fixture);
	const baseline = (await getProjectFeature(
		{ feature: "s-1" },
		CTX,
	)) as DetailOverview;
	const baselineCut = baseline.truncations.find(
		(c) => c.field === "description",
	);
	if (!baselineCut) {
		throw new Error("Expected an overview continuation");
	}
	const boundary = baselineCut.shown;
	const text = `${"x".repeat(boundary - 1)}😀${"y".repeat(18000 - boundary)}`;
	h.getStoryById.mockResolvedValue({ ...fixture, description: text });
	const overview = (await getProjectFeature(
		{ feature: "s-1" },
		CTX,
	)) as DetailOverview;
	const cut = overview.truncations.find((c) => c.field === "description");
	if (!cut) {
		throw new Error("Expected an overview continuation");
	}
	let reconstructed = overview.description.slice(0, -1);
	expect(reconstructed).not.toMatch(/[\uD800-\uDBFF]$/);
	expect(Array.from(reconstructed)).toHaveLength(cut.shown);
	let offset = cut.next.offset;
	for (;;) {
		const page = (await getProjectFeature(
			{ feature: "s-1", section: "description", offset },
			CTX,
		)) as DetailPage;
		reconstructed += page.content;
		if (!page.hasMore) {
			break;
		}
		offset = page.nextOffset;
	}
	expect(reconstructed).toBe(text);
});

it("starts the grouped task continuation at the first affected index", async () => {
	h.getStoryById.mockResolvedValue({
		...story,
		tasks: [
			{ ...story.tasks[1], description: "Short" },
			{ ...story.tasks[1], description: null },
			{ ...story.tasks[1], description: "Long".repeat(100) },
			{ ...story.tasks[1], description: "Longer".repeat(100) },
		],
	});
	const result = (await getProjectFeature(
		{ feature: "s-1" },
		CTX,
	)) as DetailOverview;
	expect(result.truncations).toEqual([
		{
			field: "tasks[].description",
			count: 2,
			next: { section: "tasks", offset: 2 },
		},
	]);
	const page = (await getProjectFeature(
		{ feature: "s-1", ...result.truncations[0].next },
		CTX,
	)) as DetailPage;
	expect(page.tasks.map((t) => t.description)).toEqual([
		"Long".repeat(100),
		"Longer".repeat(100),
	]);
});
