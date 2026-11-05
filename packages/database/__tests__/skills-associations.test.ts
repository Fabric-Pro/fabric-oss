import { beforeEach, describe, expect, it, vi } from "vitest";
import { matchesWhere } from "./_helpers/in-memory-rows";

const m = vi.hoisted(() => ({
	member: vi.fn(),
	agent: vi.fn(),
	report: vi.fn(),
	skill: vi.fn(),
	many: vi.fn(),
	count: vi.fn(),
}));
vi.mock("../prisma/client", () => ({
	db: {
		member: { findFirst: m.member },
		agentTemplateSkill: { findMany: m.agent },
		reportTemplateSkill: { findMany: m.report },
		skill: { findFirst: m.skill, findMany: m.many, count: m.count },
	},
}));

import {
	assertPinnedSkillAccess,
	getSkillById,
	listReportTemplateSkills,
	listSkills,
	listTemplateSkills,
} from "../prisma/queries/skills";

const actor = { userId: "example-owner", organizationId: "example-org" };
const rows = [
	{
		id: "own-draft",
		scope: "ORGANIZATION",
		...actor,
		isPublished: false,
		archivedAt: null,
	},
	{
		id: "other-draft",
		scope: "ORGANIZATION",
		...actor,
		userId: "example-other",
		isPublished: false,
		archivedAt: null,
	},
	{
		id: "members",
		scope: "ORGANIZATION",
		...actor,
		userId: "example-other",
		isPublished: true,
		isDiscoverable: false,
		archivedAt: null,
	},
	{
		id: "archived",
		scope: "ORGANIZATION",
		...actor,
		isPublished: false,
		archivedAt: new Date(),
	},
	{
		id: "other-org",
		scope: "ORGANIZATION",
		...actor,
		organizationId: "example-other-org",
		isPublished: true,
		archivedAt: null,
	},
	{
		id: "legacy-personal",
		scope: "USER",
		...actor,
		organizationId: null,
		isPublished: true,
		archivedAt: null,
	},
	{
		id: "builtin",
		scope: "SYSTEM",
		userId: null,
		organizationId: null,
		isPublished: true,
		archivedAt: null,
	},
];
beforeEach(() => {
	vi.resetAllMocks();
	m.member.mockResolvedValue({ role: "member" });
	m.many.mockImplementation(async ({ where }) =>
		rows.filter((row) => matchesWhere(row, where)),
	);
	for (const query of [m.agent, m.report]) {
		query.mockImplementation(async ({ where }) =>
			rows
				.filter((row) => matchesWhere(row, where.skill.is))
				.map((skill) => ({ skill })),
		);
	}
	m.skill.mockImplementation(
		async ({ where }) =>
			rows.find((row) => matchesWhere(row, where)) ?? null,
	);
});
describe("skill attachment source privacy", () => {
	it.each([listTemplateSkills, listReportTemplateSkills])(
		"filters content at association SQL for actual actor",
		async (list) => {
			const result = await list("example-template", actor);
			expect(result.map((x) => x.skill.id)).toEqual([
				"own-draft",
				"members",
				"builtin",
			]);
		},
	);
	it.each([listTemplateSkills, listReportTemplateSkills])(
		"fails closed to published builtins when historical caller omitted actor",
		async (list) => {
			expect(
				(await list("example-template")).map((x) => x.skill.id),
			).toEqual(["builtin"]);
		},
	);
	it("direct IDs cannot bypass owner-private drafts or organization exclusivity", async () => {
		expect(await getSkillById("own-draft", actor)).toMatchObject({
			id: "own-draft",
		});
		for (const id of [
			"other-draft",
			"archived",
			"other-org",
			"legacy-personal",
		]) {
			expect(await getSkillById(id, actor)).toBeNull();
		}
	});
	it("current role is mandatory for attached or direct skill content", async () => {
		m.member.mockResolvedValue(null);
		await expect(
			listTemplateSkills("example-template", actor),
		).rejects.toThrow("Current skill access");
		await expect(getSkillById("members", actor)).rejects.toThrow(
			"Current skill access",
		);
		expect(m.agent).not.toHaveBeenCalled();
		expect(m.skill).not.toHaveBeenCalled();
	});
	it("pinned source checks compare current exact version and bytes at SQL, never loading a new body", async () => {
		const pinned = {
			id: "members",
			version: 1,
			name: "Example",
			content: "Current instructions",
		};
		const record = rows.find((r) => r.id === "members");
		if (!record) {
			throw new Error("Missing members fixture");
		}
		Object.assign(record, pinned);
		await assertPinnedSkillAccess(actor, [pinned]);
		expect(m.many.mock.calls[0][0].select).toEqual({ id: true });
		Object.assign(record, {
			version: 2,
			content: "Sanitized instructions",
		});
		await expect(assertPinnedSkillAccess(actor, [pinned])).rejects.toThrow(
			"unavailable or changed",
		);
	});
	it.each([null, { role: "example-revoked-role" }])(
		"legacy organization list repeats current READ instead of trusting actor identifiers: %j",
		async (member) => {
			m.member.mockResolvedValue(member);
			await expect(listSkills(actor)).rejects.toThrow(
				"Current skill access",
			);
			expect(m.many).not.toHaveBeenCalled();
		},
	);
});
