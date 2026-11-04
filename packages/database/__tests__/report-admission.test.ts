import { beforeEach, describe, expect, it, vi } from "vitest";

const m = vi.hoisted(() => ({
	create: vi.fn(),
	find: vi.fn(),
	prior: vi.fn(),
	createInstance: vi.fn(),
	template: vi.fn(),
	query: vi.fn(),
	skills: vi.fn(),
}));
vi.mock("../prisma/client", () => ({
	db: {
		$queryRaw: m.query,
		reportTemplateSkill: { findMany: m.skills },
		templateInstance: { create: m.createInstance },
		reportTemplate: { findUnique: m.template },
		templateInstanceExecution: {
			create: m.create,
			findUnique: m.find,
			findFirst: m.prior,
		},
	},
}));
vi.mock("../prisma/queries/lib/report-access", () => ({
	canAccessReportInstance: vi.fn(),
	reportScopeWhere: vi.fn(),
}));

import {
	admitTemplateInstanceExecution,
	buildReportExecutionSnapshot,
	createTemplateInstance,
	listPendingReportExecutionStarts,
	reportExecutionAdmissionId,
} from "../prisma/queries/reports";

const input = {
	instanceId: "instance-1",
	organizationId: "org-1",
	userId: "user-1",
	workflowId: "scheduled-report-instance-1-1782291600000",
};
beforeEach(() => {
	vi.clearAllMocks();
	m.prior.mockResolvedValue(null);
	m.template.mockResolvedValue({ definition: null });
	m.skills.mockResolvedValue([]);
	m.query.mockImplementation(async () =>
		(await m.skills()).map(({ skill }: { skill: unknown }) => skill),
	);
});
describe("report occurrence primary-key fence", () => {
	it("admits concurrent callers once and preserves the original payload after edits", async () => {
		const rows = new Map<string, Record<string, unknown>>();
		m.create.mockImplementation(async ({ data }) => {
			if (rows.has(data.id)) {
				throw { code: "P2002" };
			}
			rows.set(data.id, data);
			return data;
		});
		m.find.mockImplementation(async ({ where }) => rows.get(where.id));
		const id = reportExecutionAdmissionId(input.workflowId);
		const [first, retry] = await Promise.all([
			admitTemplateInstanceExecution({
				...input,
				id,
				parameters: { window: "original" },
			}),
			admitTemplateInstanceExecution({
				...input,
				id,
				parameters: { window: "edited" },
			}),
		]);
		expect(rows.size).toBe(1);
		expect(first.id).toBe(retry.id);
		expect(retry.parameters).toEqual({ window: "original" });
	});
	it("rejects a colliding admission with a different organization or actor", async () => {
		m.create.mockRejectedValue({ code: "P2002" });
		m.find.mockResolvedValue({ ...input, id: "report-1" });
		await expect(
			admitTemplateInstanceExecution({
				...input,
				organizationId: "other-org",
				id: "report-1",
			}),
		).rejects.toThrow("identity mismatch");
	});
	it("does not mistake a database outage for an existing occurrence", async () => {
		m.create.mockRejectedValue(new Error("unavailable"));
		await expect(
			admitTemplateInstanceExecution({ ...input, id: "report-1" }),
		).rejects.toThrow("unavailable");
		expect(m.find).not.toHaveBeenCalled();
	});
	it("only occurrence/request identity controls the key", () => {
		expect(reportExecutionAdmissionId(input.workflowId)).toBe(
			reportExecutionAdmissionId(input.workflowId),
		);
		expect(reportExecutionAdmissionId(`${input.workflowId}-next`)).not.toBe(
			reportExecutionAdmissionId(input.workflowId),
		);
	});
});

it("reuses a legacy scheduled row across deployment instead of minting another occurrence", async () => {
	m.prior.mockResolvedValue({
		...input,
		id: "legacy-execution-id",
		parameters: null,
	});
	const result = await admitTemplateInstanceExecution({
		...input,
		id: reportExecutionAdmissionId(input.workflowId),
		parameters: { __fabricReportExecution: { version: 1 } },
	});
	expect(result.id).toBe("legacy-execution-id");
	expect(m.create).not.toHaveBeenCalled();
	expect(result.parameters).toBeNull();
});

it("persists unqualified project reports as disconnected drafts and leaves organization reports active", async () => {
	m.createInstance.mockImplementation(async ({ data }) => data);
	const base = {
		templateId: "template-1",
		organizationId: "org-1",
		userId: "user-1",
		name: "Delivery",
		connections: {},
	};
	await createTemplateInstance({
		...base,
		fabricConfig: {
			reporting: { version: 1, period: "weekly", projectId: "project-a" },
		},
		schedule: { frequency: "daily", timezone: "UTC" },
	});
	expect(m.createInstance.mock.calls[0][0].data).toMatchObject({
		status: "DRAFT",
		isActive: false,
		scheduleMode: "OFF",
		nextRunAt: null,
	});
	await createTemplateInstance(base);
	expect(m.createInstance.mock.calls[1][0].data).toMatchObject({
		status: "ACTIVE",
		isActive: true,
		scheduleMode: "INHERITED",
	});
});

it("activates a project report only for the implemented project knowledge source", async () => {
	m.createInstance.mockImplementation(async ({ data }) => data);
	m.template.mockResolvedValue({
		definition: {
			dataSources: [
				{
					id: "knowledge",
					type: "fabric",
					provider: "fabric_project",
					operation: "project_knowledge",
				},
			],
		},
	});
	await createTemplateInstance({
		templateId: "template-1",
		userId: "user-1",
		organizationId: "org-1",
		name: "Delivery",
		connections: {},
		fabricConfig: {
			reporting: {
				version: 1,
				period: "monthly",
				projectId: "project-a",
			},
		},
		schedule: { frequency: "daily", timezone: "UTC" },
	});
	expect(m.createInstance.mock.calls[0][0].data).toMatchObject({
		status: "ACTIVE",
		isActive: true,
	});
	expect(m.createInstance.mock.calls[0][0].data.nextRunAt).toBeInstanceOf(
		Date,
	);
});

it("pins bounded effective published skills and their hash against later edits or detachment", async () => {
	const skill = {
		id: "skill-1",
		version: 2,
		updatedAt: new Date("2026-10-01T00:00:00Z"),
		name: "Delivery format",
		content: "Use the admitted output format.",
	};
	m.skills.mockResolvedValue([{ skill }]);
	const input = {
		instance: {
			id: "report-1",
			templateId: "template-1",
			template: {},
			connections: {},
		},
		organizationId: "org-1",
		userId: "user-1",
		occurrenceAt: new Date("2026-11-02T00:00:00Z"),
		origin: "manual" as const,
	};
	const first = await buildReportExecutionSnapshot(input);
	skill.content = "Changed after admission";
	m.skills.mockResolvedValue([]);
	const next = await buildReportExecutionSnapshot(input);
	expect(first.skills[0].content).toBe("Use the admitted output format.");
	expect(next.skills).toEqual([]);
	expect(first.hashes.config).not.toBe(next.hashes.config);
	const query = m.query.mock.calls[0][0];
	expect(query.strings.join("")).toContain(
		"octet_length(s.content) <= 64000",
	);
	expect(query.strings.join("")).toContain("LIMIT 33");
	expect(query.values).toEqual(["template-1", "org-1"]);
});
it("progresses past more skipped recovery rows than a batch without changing their uncertain status", async () => {
	const rows = Array.from({ length: 301 }, (_, index) => ({
		id: `pending-${index}`,
		status: "PENDING",
		attemptedAt: 0,
	}));
	m.query.mockImplementation(async (query) => {
		const sql = query.strings.join("?");
		expect(sql).toContain("lastAttemptAtMillis");
		expect(sql).toContain("ORDER BY CASE");
		expect(sql).toContain("FOR UPDATE SKIP LOCKED");
		expect(sql).toContain("jsonb_set");
		const limit = query.values[0];
		const timestamp = query.values[1];
		const chosen = [...rows]
			.sort(
				(a, b) =>
					a.attemptedAt - b.attemptedAt ||
					Number(a.id.slice(8)) - Number(b.id.slice(8)),
			)
			.slice(0, limit);
		for (const row of chosen) {
			row.attemptedAt = timestamp;
		}
		return chosen;
	});
	const selected = [];
	for (let tick = 0; tick < 4; tick++) {
		selected.push(...(await listPendingReportExecutionStarts(100)));
	}
	expect(selected.some((row) => row.id === "pending-300")).toBe(true);
	expect(rows.every((row) => row.status === "PENDING")).toBe(true);
});
