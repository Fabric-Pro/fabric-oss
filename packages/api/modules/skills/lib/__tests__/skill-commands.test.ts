import { beforeEach, describe, expect, it, vi } from "vitest";

const m = vi.hoisted(() => ({
	member: vi.fn(),
	find: vi.fn(),
	many: vi.fn(),
	count: vi.fn(),
	create: vi.fn(),
	update: vi.fn(),
	remove: vi.fn(),
	orgUpdate: vi.fn(),
	memoryDelete: vi.fn(),
	audit: vi.fn(),
	log: vi.fn(),
}));
vi.mock("@repo/database", async () => {
	const p = await import("@repo/permissions");
	const client = {
		member: { findFirst: m.member },
		skill: {
			findFirst: m.find,
			findMany: m.many,
			count: m.count,
			create: m.create,
			updateMany: m.update,
			deleteMany: m.remove,
		},
		organization: { updateMany: m.orgUpdate },
		agentMemoryFile: { deleteMany: m.memoryDelete },
	};
	return {
		...p,
		db: {
			...client,
			$transaction: (f: (tx: unknown) => unknown) => f(client),
		},
		skillVisibilityWhere: (actor: unknown, archived: boolean) => ({
			actor,
			archived,
		}),
	};
});
vi.mock("@repo/ai/skills", () => ({ invalidateSkillCache: vi.fn() }));
vi.mock("@repo/logs", () => ({ logDataEvent: m.log }));
const c = await import("../skill-commands");
const actor = { userId: "example-owner", organizationId: "example-org" };
const timestamp = new Date("2026-01-01T00:00:00Z");
function skill(extra: Record<string, unknown> = {}) {
	return {
		id: "example-skill",
		slug: "example-skill",
		name: "Example skill",
		description: "Example",
		content: "  indented instructions\n",
		scope: "ORGANIZATION",
		...actor,
		version: 1,
		isPublished: false,
		isDiscoverable: false,
		archivedAt: null,
		category: null,
		tags: [],
		createdAt: timestamp,
		updatedAt: timestamp,
		useCount: 0,
		files: [],
		...extra,
	};
}
function member(role = "member", policy?: Record<string, unknown>) {
	m.member.mockResolvedValue({
		role,
		organization: {
			metadata: policy
				? JSON.stringify({
						unrelated: { keep: true },
						skillGovernance: policy,
					})
				: null,
		},
	});
}
beforeEach(() => {
	vi.resetAllMocks();
	m.log.mockResolvedValue(undefined);
	member();
	m.find.mockResolvedValue(skill());
	m.many.mockResolvedValue([]);
	m.count.mockResolvedValue(0);
	m.update.mockResolvedValue({ count: 1 });
	m.remove.mockResolvedValue({ count: 1 });
	m.create.mockResolvedValue({ id: "example-skill", version: 1 });
	m.orgUpdate.mockResolvedValue({ count: 1 });
	m.memoryDelete.mockResolvedValue({ count: 1 });
});
describe("secured skill lifecycle", () => {
	it("requires current membership even for external wildcard actors", async () => {
		m.member.mockResolvedValue(null);
		await expect(
			c.listSkillsCommand({ ...actor, external: true }, {}),
		).rejects.toMatchObject({ code: "FORBIDDEN" });
		expect(m.many).not.toHaveBeenCalled();
	});
	it("does not let a read-only guest create", async () => {
		member("guest");
		await expect(
			c.createSkillCommand(
				actor,
				{
					name: "Example",
					slug: "example",
					description: "Example",
					content: "Instructions",
				},
				m.audit,
			),
		).rejects.toMatchObject({ code: "FORBIDDEN" });
		expect(m.create).not.toHaveBeenCalled();
	});
	it("creates an organization-owned private draft and preserves Markdown indentation", async () => {
		await c.createSkillCommand(
			actor,
			{
				name: "Example",
				slug: "example",
				description: "Example",
				content: "  preserve\n",
			},
			m.audit,
		);
		expect(m.create.mock.calls[0][0].data).toMatchObject({
			...actor,
			scope: "ORGANIZATION",
			isPublished: false,
			isDiscoverable: false,
			content: "  preserve\n",
		});
		expect(m.audit).toHaveBeenCalledWith(
			expect.objectContaining({ action: "org.skill.created" }),
		);
	});
	it("rejects whitespace-only instructions without touching storage", async () => {
		await expect(
			c.createSkillCommand(
				actor,
				{
					name: "Example",
					slug: "example",
					description: "Example",
					content: " \n ",
				},
				m.audit,
			),
		).rejects.toMatchObject({ code: "BAD_REQUEST" });
		expect(m.create).not.toHaveBeenCalled();
	});
	it("prevents administrator edits of another owner and builtin edits", async () => {
		member("admin");
		m.find.mockResolvedValue(skill({ userId: "example-other" }));
		await expect(
			c.updateSkillCommand(
				actor,
				{ id: "example-skill", content: "Changed" },
				m.audit,
			),
		).rejects.toMatchObject({ code: "FORBIDDEN" });
		m.find.mockResolvedValue(
			skill({ scope: "SYSTEM", userId: null, organizationId: null }),
		);
		await expect(
			c.archiveSkillCommand(actor, { id: "example-skill" }, m.audit),
		).rejects.toMatchObject({ code: "FORBIDDEN" });
		expect(m.update).not.toHaveBeenCalled();
	});
	it("enforces governance ceiling on publish but permits reducing sharing", async () => {
		member("member", {
			create: "permitted_members",
			publish: "administrators",
			discover: "administrators",
			revision: 2,
		});
		m.find.mockResolvedValue(skill({ isPublished: true }));
		await expect(
			c.publishSkillCommand(
				actor,
				{
					id: "example-skill",
					expectedVersion: 1,
					availability: "agents",
				},
				m.audit,
			),
		).rejects.toMatchObject({ code: "FORBIDDEN" });
		await c.publishSkillCommand(
			actor,
			{ id: "example-skill", expectedVersion: 1, availability: "draft" },
			m.audit,
		);
		expect(m.update.mock.calls[0][0].data).toMatchObject({
			isPublished: false,
			isDiscoverable: false,
		});
	});
	it("checks version with compare-and-swap and never audits rejected writes", async () => {
		m.update.mockResolvedValue({ count: 0 });
		await expect(
			c.updateSkillCommand(
				actor,
				{ id: "example-skill", expectedVersion: 2, content: "Changed" },
				m.audit,
			),
		).rejects.toMatchObject({ code: "CONFLICT" });
		expect(m.update.mock.calls[0][0].where).toMatchObject({
			...actor,
			version: 2,
		});
		expect(m.audit).not.toHaveBeenCalled();
	});
	it("restores archived skills as drafts rather than republishing", async () => {
		m.find.mockResolvedValue(skill({ archivedAt: timestamp }));
		await c.restoreSkillCommand(
			actor,
			{ id: "example-skill", expectedVersion: 1 },
			m.audit,
		);
		expect(m.update.mock.calls[0][0].data).toMatchObject({
			archivedAt: null,
			isPublished: false,
			isDiscoverable: false,
		});
	});
	it("rejects caller-supplied storage authority and invalid prepared paths", async () => {
		const raw = {
			name: "Example",
			slug: "example",
			description: "Example",
			content: "Instructions",
		};
		await expect(
			c.createSkillCommand(actor, { ...raw, preparedFiles: [] }, m.audit),
		).rejects.toMatchObject({ code: "BAD_REQUEST" });
		await expect(
			c.createSkillCommand(actor, raw, m.audit, {
				id: "example-skill",
				preparedFiles: [
					{
						path: "../secret",
						contentType: "text/plain",
						sizeBytes: 1,
						sha256: "a".repeat(64),
						storageKey: "skills/example-skill/x/file",
					},
				],
			}),
		).rejects.toMatchObject({ code: "BAD_REQUEST" });
		expect(m.create).not.toHaveBeenCalled();
	});
	it("requires admin role and revision CAS for governance, preserving unrelated metadata", async () => {
		const policy = {
			create: "administrators",
			publish: "administrators",
			discover: "administrators",
		};
		await expect(
			c.updateSkillGovernanceCommand(
				actor,
				{ expectedRevision: 0, policy },
				m.audit,
			),
		).rejects.toMatchObject({ code: "FORBIDDEN" });
		member("admin", { ...policy, revision: 3 });
		await expect(
			c.updateSkillGovernanceCommand(
				actor,
				{ expectedRevision: 2, policy },
				m.audit,
			),
		).rejects.toMatchObject({ code: "CONFLICT" });
		await c.updateSkillGovernanceCommand(
			actor,
			{ expectedRevision: 3, policy },
			m.audit,
		);
		const call = m.orgUpdate.mock.calls[0][0];
		expect(JSON.parse(call.data.metadata)).toMatchObject({
			unrelated: { keep: true },
			skillGovernance: { ...policy, revision: 4 },
		});
		expect(call.where.metadata).toContain('"revision":3');
	});
	it("rejects metadata races rather than overwriting another setting", async () => {
		member("owner");
		m.orgUpdate.mockResolvedValue({ count: 0 });
		await expect(
			c.updateSkillGovernanceCommand(
				actor,
				{
					expectedRevision: 0,
					policy: {
						create: "administrators",
						publish: "administrators",
						discover: "administrators",
					},
				},
				m.audit,
			),
		).rejects.toMatchObject({ code: "CONFLICT" });
		expect(m.audit).not.toHaveBeenCalled();
	});
	it("permanent owner deletion removes protected copies before parent FK provenance is nulled", async () => {
		member("owner");
		await c.deleteSkillCommand(
			actor,
			{ id: "example-skill", expectedVersion: 1 },
			m.audit,
		);
		expect(m.memoryDelete).toHaveBeenCalledWith({
			where: { sourceSkillId: "example-skill" },
		});
		expect(m.memoryDelete.mock.invocationCallOrder[0]).toBeLessThan(
			m.remove.mock.invocationCallOrder[0],
		);
	});
});
