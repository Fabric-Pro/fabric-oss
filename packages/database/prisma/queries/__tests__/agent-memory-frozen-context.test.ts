import { createHash } from "node:crypto";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { matchesWhere } from "../../../__tests__/_helpers/in-memory-rows";

const m = vi.hoisted(() => ({
	remove: vi.fn(),
	editDelete: vi.fn(),
	first: vi.fn(),
	many: vi.fn(),
	member: vi.fn(),
	sources: vi.fn(),
	count: vi.fn(),
	editCount: vi.fn(),
	editMany: vi.fn(),
	editFirst: vi.fn(),
	update: vi.fn(),
	create: vi.fn(),
	skill: vi.fn(),
}));
vi.mock("../../client", () => ({
	db: {
		$transaction: async (work: (tx: unknown) => unknown) =>
			work({
				member: { findFirst: m.member },
				skill: { findFirst: m.skill },
				agentMemoryEdit: { deleteMany: m.editDelete },
				agentMemoryFile: { update: m.update },
			}),
		member: { findFirst: m.member },
		skill: { findMany: m.sources, findFirst: m.skill },
		agentMemoryEdit: {
			count: m.editCount,
			findMany: m.editMany,
			findFirst: m.editFirst,
		},
		agentMemoryFile: {
			findFirst: m.first,
			findMany: m.many,
			count: m.count,
			update: m.update,
			create: m.create,
			delete: m.remove,
		},
	},
}));

import {
	deleteMemoryFile,
	exportMemory,
	type FrozenAgentMemoryFile,
	listMemoryFiles,
	listPendingEdits,
	loadAgentMemoryContext,
	memoryFileExists,
	memorySourceBoundary,
	readMemoryFile,
	searchMemoryFiles,
	writeMemoryFile,
} from "../agent-memory";

const actor = {
	agentInstanceId: "example-instance",
	userId: "example-user",
	organizationId: "example-org",
};
const empty = {
	agentsMd: null,
	mcpJson: null,
	skills: [],
	knowledge: [],
	recentConversations: [],
};
type Row = {
	id: string;
	version: number;
	contentHash: string;
	sourceSkillId: string | null;
	agentInstanceId: string;
	userId: string;
	organizationId: string;
	path: string;
	fileType: string;
	content: string;
	isEnabled: boolean;
	updatedAt: number;
};
function fixture(): Row[] {
	return [
		["AGENTS.md", "AGENTS_MD", "Pinned instructions"],
		["mcp.json", "MCP_JSON", '{"example":true}'],
		["skills/example.md", "SKILL", "Pinned skill"],
		["knowledge/example.md", "KNOWLEDGE", "Pinned knowledge"],
		["conversations/example.json", "CONVERSATION", "Pinned conversation"],
	].map(([path, fileType, content], i) => ({
		id: `example-file-${i}`,
		version: 1,
		contentHash: createHash("sha256").update(content).digest("hex"),
		sourceSkillId: i === 2 ? "example-skill" : null,
		...actor,
		path,
		fileType,
		content,
		isEnabled: true,
		updatedAt: i,
	}));
}
const manifest = (rows: Row[]): FrozenAgentMemoryFile[] =>
	rows.map(({ id, version, contentHash, sourceSkillId }) => ({
		id,
		version,
		contentHash,
		sourceSkillId,
	}));
let rows: Row[] = [];
beforeEach(() => {
	vi.resetAllMocks();
	rows = fixture();
	m.member.mockResolvedValue({ role: "member" });
	m.count.mockImplementation(
		async ({ where }) =>
			rows.filter((row) => matchesWhere(row, where)).length,
	);
	m.editCount.mockResolvedValue(0);
	m.editDelete.mockResolvedValue({ count: 0 });
	m.editMany.mockResolvedValue([]);
	m.update.mockResolvedValue({ id: "example-file-2" });
	m.skill.mockResolvedValue({ id: "example-skill", content: "Pinned skill" });
	m.sources.mockResolvedValue([
		{ id: "example-skill", content: "Pinned skill" },
	]);
	m.first.mockImplementation(
		async ({ where }: { where: Record<string, unknown> }) =>
			rows.find((row) => matchesWhere(row, where)) ?? null,
	);
	m.many.mockImplementation(
		async ({
			where,
			take,
		}: {
			where: Record<string, unknown>;
			take?: number;
		}) => rows.filter((row) => matchesWhere(row, where)).slice(0, take),
	);
});
describe("frozen native test memory is constrained in the actual content queries", () => {
	it("pins all five physical reads to current owner, organization, instance and exact admitted revisions", async () => {
		const frozen = manifest(rows);
		expect(await loadAgentMemoryContext(actor, frozen)).toEqual({
			agentsMd: "Pinned instructions",
			mcpJson: { example: true },
			skills: [{ path: "skills/example.md", content: "Pinned skill" }],
			knowledge: [
				{ path: "knowledge/example.md", content: "Pinned knowledge" },
			],
			recentConversations: [
				{
					path: "conversations/example.json",
					content: "Pinned conversation",
				},
			],
		});
		expect(m.first).toHaveBeenCalledTimes(2);
		expect(m.many).toHaveBeenCalledTimes(4);
		for (const [args] of [
			...m.first.mock.calls,
			...m.many.mock.calls.filter(([args]) => !args.select),
		]) {
			expect(args.where).toMatchObject({
				...actor,
				isEnabled: true,
				OR: frozen,
			});
		}
	});
	it("an explicitly empty admitted manifest issues no content reads", async () => {
		expect(await loadAgentMemoryContext(actor, [])).toEqual(empty);
		expect(m.first).not.toHaveBeenCalled();
		expect(m.many).not.toHaveBeenCalled();
	});
	it.each([
		"version",
		"contentHash",
		"userId",
		"organizationId",
		"agentInstanceId",
		"isEnabled",
		"sourceSkillId",
	] as const)(
		"an edit of %s between admission and content read cannot enter any context slot",
		async (field) => {
			const frozen = manifest(rows);
			for (const row of rows) {
				if (field === "version") {
					row.version += 1;
				} else if (field === "contentHash") {
					row.contentHash = "f".repeat(64);
				} else if (field === "isEnabled") {
					row.isEnabled = false;
				} else {
					row[field] = `other-${field}`;
				}
			}
			expect(await loadAgentMemoryContext(actor, frozen)).toEqual(empty);
		},
	);
	it("does not include newly enabled/unlisted memory in any of the five slots", async () => {
		const frozen = manifest(rows);
		rows = rows.map((row) => ({
			...row,
			id: `new-${row.id}`,
			content: row.fileType === "MCP_JSON" ? "{}" : "Unadmitted content",
		}));
		expect(await loadAgentMemoryContext(actor, frozen)).toEqual(empty);
	});
	it("keeps ordinary unsnapshotted memory behavior and limits unchanged", async () => {
		rows[0].isEnabled = false;
		rows[3].isEnabled = false;
		expect(await loadAgentMemoryContext(actor)).toMatchObject({
			agentsMd: "Pinned instructions",
			knowledge: [{ content: "Pinned knowledge" }],
		});
		expect(m.first).toHaveBeenCalledWith({
			where: expect.objectContaining({ ...actor, path: "AGENTS.md" }),
		});
		expect(m.many).toHaveBeenCalledWith({
			where: expect.objectContaining({ ...actor, fileType: "KNOWLEDGE" }),
			orderBy: { path: "asc" },
		});
		expect(m.many).toHaveBeenCalledWith({
			where: expect.objectContaining({
				...actor,
				fileType: "CONVERSATION",
			}),
			orderBy: { updatedAt: "desc" },
			take: 5,
		});
	});
	it("supports the minimal admitted id/version/hash contract without widening by tenant", async () => {
		const frozen = manifest(rows).map(({ id, version, contentHash }) => ({
			id,
			version,
			contentHash,
		}));
		expect((await loadAgentMemoryContext(actor, frozen)).agentsMd).toBe(
			"Pinned instructions",
		);
		rows[0].userId = "other-user";
		expect(
			(await loadAgentMemoryContext(actor, frozen)).agentsMd,
		).toBeNull();
	});
	it.each([
		{ id: "example-file", version: 0, contentHash: "a".repeat(64) },
		{ id: "example-file", version: 1, contentHash: "invalid" },
	])(
		"rejects malformed internal manifests before querying: %j",
		async (entry) => {
			await expect(
				loadAgentMemoryContext(actor, [entry]),
			).rejects.toThrow("Invalid frozen agent memory manifest");
			expect(m.first).not.toHaveBeenCalled();
			expect(m.many).not.toHaveBeenCalled();
		},
	);
	it("current source revocation constrains the physical memory queries, not only returned results", async () => {
		m.sources.mockResolvedValue([]);
		const result = await loadAgentMemoryContext(actor, manifest(rows));
		expect(result.skills).toEqual([]);
		const contentQueries = [
			...m.first.mock.calls,
			...m.many.mock.calls.filter(([args]) => !args.select),
		];
		for (const [args] of contentQueries) {
			expect(args.where.AND).toEqual([{ OR: [{ sourceSkillId: null }] }]);
		}
	});
	it("refuses an obsolete confidential copy before reading any memory content after sanitized republish", async () => {
		m.sources.mockResolvedValue([
			{ id: "example-skill", content: "New public instructions" },
		]);
		await expect(
			loadAgentMemoryContext(actor, manifest(rows)),
		).rejects.toThrow("Refresh this agent's skills");
		expect(m.first).not.toHaveBeenCalled();
		expect(m.many).toHaveBeenCalledTimes(1);
		expect(m.many.mock.calls[0][0].select).toEqual({
			sourceSkillId: true,
			contentHash: true,
		});
	});
	it("withholds context if source publication changes during the physical reads", async () => {
		m.sources
			.mockResolvedValueOnce([
				{ id: "example-skill", content: "Pinned skill" },
			])
			.mockResolvedValueOnce([]);
		await expect(
			loadAgentMemoryContext(actor, manifest(rows)),
		).rejects.toThrow("Refresh this agent's skills");
	});
	it("requires the current actor permission before reading source-backed memory", async () => {
		m.member.mockResolvedValue(null);
		await expect(
			loadAgentMemoryContext(actor, manifest(rows)),
		).rejects.toThrow("Current skill access");
		expect(m.first).not.toHaveBeenCalled();
		expect(m.sources).not.toHaveBeenCalled();
	});
	it.each(["read", "list", "search", "export", "exists"])(
		"%s does not release source-backed copied content or filenames after source revocation",
		async (surface) => {
			m.sources.mockResolvedValue([]);
			if (surface === "read") {
				expect(
					await readMemoryFile(actor, "skills/example.md"),
				).toBeNull();
			}
			if (surface === "exists") {
				expect(await memoryFileExists(actor, "skills/example.md")).toBe(
					false,
				);
			}
			if (surface === "list") {
				expect(
					(await listMemoryFiles(actor)).files.map((f) => f.path),
				).not.toContain("skills/example.md");
			}
			if (surface === "search") {
				expect(await searchMemoryFiles(actor, "Pinned skill")).toEqual(
					[],
				);
			}
			if (surface === "export") {
				expect(await exportMemory(actor)).not.toHaveProperty(
					"skills/example.md",
				);
			}
			for (const [args] of [
				...m.first.mock.calls,
				...m.many.mock.calls.filter(([args]) => !args.select),
			]) {
				expect(args.where.AND).toEqual([
					{ OR: [{ sourceSkillId: null }] },
				]);
			}
		},
	);
	it("generic writes fail clearly for a stale linked skill rather than creating a duplicate path", async () => {
		m.sources.mockResolvedValue([
			{ id: "example-skill", content: "Sanitized instructions" },
		]);
		await expect(
			writeMemoryFile(actor, "skills/example.md", "Changed copy", "user"),
		).rejects.toThrow("Refresh this agent's skills");
		expect(m.create).not.toHaveBeenCalled();
		expect(m.update).not.toHaveBeenCalled();
	});
	it("explicit source refresh verifies current catalog content without reading an obsolete copied body", async () => {
		await writeMemoryFile(
			actor,
			"skills/example.md",
			"Pinned skill",
			"system",
			{ sourceSkillId: "example-skill" },
		);
		expect(m.first.mock.calls[0][0].select).toEqual({ id: true });
		expect(m.update.mock.calls[0][0].data).toMatchObject({
			content: "Pinned skill",
			sourceSkillId: "example-skill",
		});
		await expect(
			writeMemoryFile(
				actor,
				"skills/example.md",
				"Unverified instructions",
				"system",
				{ sourceSkillId: "example-skill" },
			),
		).rejects.toThrow("current authorized skill instructions");
	});
	it("pending-edit queries constrain their parent file using the same current source boundary", async () => {
		m.sources.mockResolvedValue([]);
		await listPendingEdits(actor);
		expect(
			m.editMany.mock.calls[0][0].where.OR[1].memoryFile.is.AND,
		).toEqual([{ OR: [{ sourceSkillId: null }] }]);
	});

	it("can remove an unavailable owned source attachment without reading its confidential copied body", async () => {
		m.sources.mockResolvedValue([]);
		m.remove.mockResolvedValue({});
		expect(await deleteMemoryFile(actor, "skills/example.md")).toBe(true);
		expect(m.first.mock.calls[0][0]).toEqual({
			where: { ...actor, path: "skills/example.md" },
			select: { id: true },
		});
		expect(m.sources).not.toHaveBeenCalled();
		expect(m.remove.mock.calls[0][0].where).toMatchObject({
			...actor,
			id: "example-file-2",
		});
	});
	it("source refresh atomically invalidates every old edit payload before reauthorizing its parent", async () => {
		let oldEdits = [
			{
				id: "example-old-pending",
				oldContent: "Former confidential draft",
			},
			{
				id: "example-old-rejected",
				oldContent: "Former confidential draft",
			},
		];
		m.skill.mockResolvedValue({
			id: "example-skill",
			content: "Sanitized instructions",
		});
		m.sources.mockResolvedValue([
			{ id: "example-skill", content: "Sanitized instructions" },
		]);
		m.editDelete.mockImplementation(async () => {
			const count = oldEdits.length;
			oldEdits = [];
			return { count };
		});
		m.update.mockImplementation(async ({ where, data }) => {
			const row = rows.find((row) => row.id === where.id);
			if (!row) {
				throw new Error("missing fixture");
			}
			Object.assign(row, {
				content: data.content,
				contentHash: data.contentHash,
			});
			return row;
		});
		m.editMany.mockImplementation(async () => oldEdits);
		await writeMemoryFile(
			actor,
			"skills/example.md",
			"Sanitized instructions",
			"system",
			{ sourceSkillId: "example-skill" },
		);
		expect(await listPendingEdits(actor)).toEqual([]);
		expect(m.editDelete).toHaveBeenCalledWith({
			where: {
				memoryFileId: "example-file-2",
				userId: actor.userId,
				organizationId: actor.organizationId,
			},
		});
		expect(m.editDelete.mock.invocationCallOrder[0]).toBeLessThan(
			m.update.mock.invocationCallOrder[0],
		);
	});
	it("nested readers authorize the requesting actor instead of the copied memory owner", async () => {
		m.sources.mockResolvedValue([]);
		const reader = {
			userId: "example-other-reader",
			organizationId: actor.organizationId,
		};
		const boundary = await memorySourceBoundary(reader, {
			agentInstanceId: actor.agentInstanceId,
			organizationId: actor.organizationId,
		});
		expect(
			(await m.many({ where: boundary.where })).map(
				(row: Row) => row.path,
			),
		).not.toContain("skills/example.md");
		expect(m.member.mock.calls[0][0].where.userId).toBe(reader.userId);
		await boundary.revalidate();
	});
});
