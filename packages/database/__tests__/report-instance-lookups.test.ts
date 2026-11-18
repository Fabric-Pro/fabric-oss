/**
 * The latest-successful-report and likely-duplicate lookups in
 * `prisma/queries/report-instance-lookups.ts`, with the Prisma client mocked
 * (no Postgres) and the real report access rules behind them.
 */
import { beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
	instanceFindMany: vi.fn(),
	executionFindMany: vi.fn(),
	artifactFindUnique: vi.fn(),
	memberFindUnique: vi.fn(),
	projectFindFirst: vi.fn(),
	hasProjectAccess: vi.fn(),
}));

vi.mock("../prisma/queries/projects/projects", async (importOriginal) => ({
	...(await importOriginal<
		typeof import("../prisma/queries/projects/projects")
	>()),
	hasProjectAccess: mocks.hasProjectAccess,
}));

vi.mock("../prisma/client", () => ({
	db: {
		templateInstance: { findMany: mocks.instanceFindMany },
		templateInstanceExecution: { findMany: mocks.executionFindMany },
		templateInstanceArtifact: { findUnique: mocks.artifactFindUnique },
		member: { findUnique: mocks.memberFindUnique },
		user: { findUnique: async () => ({ role: "user" }) },
		project: { findFirst: mocks.projectFindFirst },
	},
}));

import { reportInstructions } from "../prisma/queries/lib/report-instructions";
import {
	findLikelyDuplicateReports,
	getLatestSuccessfulReports,
	normalizeReportText,
} from "../prisma/queries/report-instance-lookups";
import { getTemplateInstanceArtifact } from "../prisma/queries/reports";

const ORG = "example-org";
const PROJECT = "example-project";
const CALLER = "example-member";

beforeEach(() => {
	vi.clearAllMocks();
	mocks.instanceFindMany.mockResolvedValue([]);
	mocks.executionFindMany.mockResolvedValue([]);
	mocks.memberFindUnique.mockResolvedValue({ role: "member" });
	mocks.projectFindFirst.mockImplementation(
		async ({ where }: { where: { id: string } }) => ({ id: where.id }),
	);
	mocks.hasProjectAccess.mockImplementation(
		async (projectId: string) => projectId === PROJECT,
	);
});

describe("getLatestSuccessfulReports", () => {
	const report = {
		id: "example-report",
		userId: "example-owner",
		organizationId: ORG,
		projectId: PROJECT,
		fabricConfig: null,
	};
	function run(id: string, parameters: unknown = {}) {
		return {
			id,
			completedAt: new Date("2026-11-02T00:00:00.000Z"),
			parameters,
			artifacts: [{ id: `${id}-artifact`, name: "report.md" }],
		};
	}

	it("asks only for the report's completed runs with an artifact, newest first", async () => {
		await getLatestSuccessfulReports({
			instances: [report],
			userId: CALLER,
			organizationId: ORG,
		});

		const { where, orderBy } = mocks.executionFindMany.mock.calls[0][0];
		expect(where).toEqual({
			instanceId: "example-report",
			status: "COMPLETED",
			artifacts: { some: {} },
		});
		expect(orderBy[0]).toEqual({
			completedAt: { sort: "desc", nulls: "last" },
		});
	});

	it("returns the newest successful run and its artifact", async () => {
		mocks.executionFindMany.mockResolvedValue([
			run("newest"),
			run("older"),
		]);

		const latest = await getLatestSuccessfulReports({
			instances: [report],
			userId: CALLER,
			organizationId: ORG,
		});

		expect(latest.get("example-report")).toEqual({
			executionId: "newest",
			completedAt: new Date("2026-11-02T00:00:00.000Z"),
			artifactId: "newest-artifact",
			artifactName: "report.md",
		});
	});

	it("skips a newer run the caller may not open", async () => {
		mocks.executionFindMany.mockResolvedValue([
			// An unreadable run snapshot fails closed, as in execution history.
			run("unreadable", {
				__fabricReportExecution: {
					config: { projectId: "another-project" },
				},
			}),
			run("readable"),
		]);

		const latest = await getLatestSuccessfulReports({
			instances: [report],
			userId: CALLER,
			organizationId: ORG,
		});

		expect(latest.get("example-report")?.executionId).toBe("readable");
	});

	it("has nothing for a report that never succeeded", async () => {
		const latest = await getLatestSuccessfulReports({
			instances: [report],
			userId: CALLER,
			organizationId: ORG,
		});

		expect(latest.has("example-report")).toBe(false);
	});

	it("reads nothing for an empty page", async () => {
		await getLatestSuccessfulReports({
			instances: [],
			userId: CALLER,
			organizationId: ORG,
		});

		expect(mocks.executionFindMany).not.toHaveBeenCalled();
	});
});

describe("findLikelyDuplicateReports", () => {
	function row(overrides: Record<string, unknown> = {}) {
		return {
			id: "existing-report",
			sId: "existing-sid",
			version: 1,
			name: "Weekly status",
			status: "ACTIVE",
			isActive: true,
			userId: "example-owner",
			organizationId: ORG,
			projectId: PROJECT,
			fabricConfig: null,
			connections: {},
			createdAt: new Date("2026-11-01T00:00:00.000Z"),
			lastRunAt: null,
			template: {
				name: "Status template",
				definition: { userPrompt: "Summarize the week." },
			},
			...overrides,
		};
	}
	const query = {
		userId: CALLER,
		organizationId: ORG,
		projectId: PROJECT,
		name: "A new title",
		prompt: "A new prompt",
	};

	it("compares the project's listed reports inside the tenant", async () => {
		await findLikelyDuplicateReports(query);

		const { where } = mocks.instanceFindMany.mock.calls[0][0];
		expect(where).toEqual({
			organizationId: ORG,
			projectId: PROJECT,
			status: { in: ["ACTIVE", "DRAFT"] },
		});
	});

	it("compares only the caller's own reports without a project", async () => {
		await findLikelyDuplicateReports({ ...query, projectId: undefined });

		const { where } = mocks.instanceFindMany.mock.calls[0][0];
		expect(where).toEqual({
			organizationId: ORG,
			userId: CALLER,
			status: { in: ["ACTIVE", "DRAFT"] },
		});
	});

	it("matches the same title alone, ignoring case and spacing", async () => {
		mocks.instanceFindMany.mockResolvedValue([row()]);

		const matches = await findLikelyDuplicateReports({
			...query,
			name: "  weekly   STATUS ",
		});

		expect(matches).toEqual([
			expect.objectContaining({
				id: "existing-report",
				sameTitle: true,
				samePrompt: false,
				ownedByCaller: false,
			}),
		]);
	});

	it("matches the same prompt alone, the template's when the report has none", async () => {
		mocks.instanceFindMany.mockResolvedValue([row()]);

		const matches = await findLikelyDuplicateReports({
			...query,
			prompt: "Summarize the week.",
		});

		expect(matches).toEqual([
			expect.objectContaining({ sameTitle: false, samePrompt: true }),
		]);
	});

	it("compares a report's own prompt over its template's", async () => {
		mocks.instanceFindMany.mockResolvedValue([
			row({
				connections: {
					promptOverride: "Only blockers.",
					promptOverrideSource: "user",
				},
			}),
		]);

		await expect(
			findLikelyDuplicateReports({
				...query,
				prompt: "Summarize the week.",
			}),
		).resolves.toEqual([]);
		await expect(
			findLikelyDuplicateReports({ ...query, prompt: "only blockers." }),
		).resolves.toHaveLength(1);
	});

	it("compares the template's prompt for an unmarked copy of an older one, as a run does", async () => {
		mocks.instanceFindMany.mockResolvedValue([
			row({
				connections: { promptOverride: "An older template prompt." },
			}),
		]);

		await expect(
			findLikelyDuplicateReports({
				...query,
				prompt: "An older template prompt.",
			}),
		).resolves.toEqual([]);
		await expect(
			findLikelyDuplicateReports({
				...query,
				prompt: "Summarize the week.",
			}),
		).resolves.toHaveLength(1);
	});

	it("finds nothing when neither the title nor the prompt matches", async () => {
		mocks.instanceFindMany.mockResolvedValue([row()]);

		await expect(findLikelyDuplicateReports(query)).resolves.toEqual([]);
	});

	it("ignores an older version of a report", async () => {
		mocks.instanceFindMany.mockResolvedValue([
			row({ id: "current", version: 2, name: "Renamed" }),
			row({ id: "previous", version: 1 }),
		]);

		await expect(
			findLikelyDuplicateReports({ ...query, name: "Weekly status" }),
		).resolves.toEqual([]);
	});

	it("names no report the caller may not open", async () => {
		mocks.instanceFindMany.mockResolvedValue([
			row({ projectId: "another-project" }),
		]);

		await expect(
			findLikelyDuplicateReports({ ...query, name: "Weekly status" }),
		).resolves.toEqual([]);
	});

	it("names nothing for a non-member", async () => {
		mocks.memberFindUnique.mockResolvedValue(null);
		mocks.instanceFindMany.mockResolvedValue([row()]);

		await expect(
			findLikelyDuplicateReports({ ...query, name: "Weekly status" }),
		).resolves.toEqual([]);
	});

	it("reads nothing for an empty title and prompt", async () => {
		await findLikelyDuplicateReports({ ...query, name: " ", prompt: "" });

		expect(mocks.instanceFindMany).not.toHaveBeenCalled();
	});
});

describe("getTemplateInstanceArtifact", () => {
	function artifactOf(projectId: string) {
		return {
			id: "example-artifact",
			name: "Report.html",
			execution: {
				id: "example-run",
				status: "COMPLETED",
				parameters: {},
				createdAt: new Date("2026-11-01T00:00:00.000Z"),
				instance: {
					id: "example-report",
					name: "Weekly status",
					userId: "example-owner",
					organizationId: ORG,
					projectId,
					fabricConfig: null,
				},
			},
		};
	}
	const caller = { userId: CALLER, organizationId: ORG };

	it("reads the report's project column with the artifact", async () => {
		mocks.artifactFindUnique.mockResolvedValue(artifactOf(PROJECT));

		await getTemplateInstanceArtifact("example-artifact", caller);

		const { include } = mocks.artifactFindUnique.mock.calls[0][0];
		expect(include.execution.select.instance.select).toMatchObject({
			projectId: true,
		});
	});

	it("opens a run of a report bound only by its project column for a project member", async () => {
		mocks.artifactFindUnique.mockResolvedValue(artifactOf(PROJECT));

		await expect(
			getTemplateInstanceArtifact("example-artifact", caller),
		).resolves.toMatchObject({ id: "example-artifact" });
	});

	it("refuses that run to a member who cannot reach the project", async () => {
		mocks.artifactFindUnique.mockResolvedValue(
			artifactOf("another-project"),
		);

		await expect(
			getTemplateInstanceArtifact("example-artifact", caller),
		).resolves.toBeNull();
	});
});

describe("report text comparison", () => {
	it("normalizes case and whitespace", () => {
		expect(normalizeReportText("  A\n  Title ")).toBe("a title");
		expect(normalizeReportText(null)).toBe("");
	});

	it("uses the template's prompt when the report's own is blank or unmarked", () => {
		const template = { definition: { userPrompt: "Template prompt" } };
		expect(
			reportInstructions({
				connections: {
					promptOverride: "   ",
					promptOverrideSource: "user",
				},
				template,
			}),
		).toEqual({
			instructions: "Template prompt",
			instructionsSource: "template",
		});
		expect(
			reportInstructions({
				connections: { promptOverride: "Copied text" },
				template,
			}).instructions,
		).toBe("Template prompt");
		expect(
			reportInstructions({
				connections: null,
				template: { definition: null },
			}).instructions,
		).toBe("");
	});
});
