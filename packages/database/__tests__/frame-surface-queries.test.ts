/**
 * Who sees which frame on the two surfaces: a project's Artifacts tab and an
 * organization's Workspaces.
 *
 * The store is faked by a small evaluator for the Prisma `where` shapes these
 * queries issue (equality, `in`, `not: null`, `gt`, `OR`, a JSON path, and the
 * `members: { some }` relation filter), so each case asserts on who ends up
 * seeing what, not on the shape of a query. Postgres itself is not exercised.
 *
 * Roles in the fixture:
 * - owner      organization member, owns project P1
 * - colleague  organization member, owns project P2
 * - member     organization member, accepted member of P1
 * - guest      NOT an organization member, accepted member of P1
 * - invited    organization member on no project; holds an email grant
 * - outsider   member of another organization only
 */

import { beforeEach, describe, expect, it, vi } from "vitest";

type Row = Record<string, unknown>;

const store = vi.hoisted(() => ({
	members: [] as Row[],
	projects: [] as Row[],
	projectMembers: [] as Row[],
	frames: [] as Row[],
}));

function matchesScalar(value: unknown, condition: unknown): boolean {
	const actual = value ?? null;
	if (
		condition !== null &&
		typeof condition === "object" &&
		!(condition instanceof Date)
	) {
		const operators = condition as {
			in?: unknown[];
			notIn?: unknown[];
			not?: unknown;
			gt?: Date;
		};
		if (operators.in) {
			return operators.in.includes(actual);
		}
		if (operators.notIn) {
			return !operators.notIn.includes(actual);
		}
		if ("not" in operators) {
			return actual !== (operators.not ?? null);
		}
		if (operators.gt) {
			return actual instanceof Date && actual > operators.gt;
		}
		throw new Error(`unsupported operator ${JSON.stringify(condition)}`);
	}
	return actual === (condition ?? null);
}

function matches(row: Row, where: Row): boolean {
	return Object.entries(where).every(([key, condition]) => {
		if (key === "OR") {
			return (condition as Row[]).some((branch) => matches(row, branch));
		}
		if (key === "members") {
			const { some } = condition as { some: Row };
			return store.projectMembers
				.filter((member) => member.projectId === row.id)
				.some((member) => matches(member, some));
		}
		if (key === "metadata") {
			const { path, equals } = condition as {
				path: string[];
				equals: unknown;
			};
			const metadata = (row.metadata ?? {}) as Row;
			return metadata[path[0]] === equals;
		}
		return matchesScalar(row[key], condition);
	});
}

function table(rows: () => Row[]) {
	return {
		findFirst: async ({ where }: { where: Row }) =>
			rows().find((row) => matches(row, where)) ?? null,
		findMany: async ({
			where,
			take,
			skip,
		}: {
			where: Row;
			take?: number;
			skip?: number;
		}) =>
			rows()
				.filter((row) => matches(row, where))
				.sort(
					(a, b) =>
						((b.updatedAt as Date | undefined)?.getTime() ?? 0) -
						((a.updatedAt as Date | undefined)?.getTime() ?? 0),
				)
				.slice(skip ?? 0, (skip ?? 0) + (take ?? rows().length)),
	};
}

vi.mock("../prisma/client", async (importOriginal) => {
	const actual = await importOriginal<typeof import("../prisma/client")>();
	return {
		...actual,
		db: {
			member: table(() => store.members),
			project: table(() => store.projects),
			projectMember: table(() => store.projectMembers),
			agentWorkspaceFile: {
				...table(() => store.frames),
				findUnique: async ({ where }: { where: { id: string } }) =>
					store.frames.find((row) => row.id === where.id) ?? null,
			},
			frameSharingGrant: { update: async () => ({}) },
		},
	};
});

const { getAccessibleFrameById, listProjectFrames, listWorkspaceFrames } =
	await import("../prisma/queries/frames");

const ORG = "org-a";
const OTHER_ORG = "org-b";
const ONE_DAY_MS = 24 * 60 * 60 * 1000;
const TOMORROW = new Date(Date.now() + ONE_DAY_MS);
const YESTERDAY = new Date(Date.now() - ONE_DAY_MS);

let tick = 0;

function frame(
	id: string,
	overrides: {
		userId: string;
		organizationId?: string;
		projectId?: string;
		surface?: "artifact" | "workspace";
		shareScope?: string;
		isPublic?: boolean;
		grants?: string[];
	},
): Row {
	tick += 1;
	return {
		id,
		conversationId: null,
		userId: overrides.userId,
		organizationId: overrides.organizationId ?? ORG,
		projectId: overrides.projectId ?? null,
		storyId: null,
		path: `/frames/${id}.frame.json`,
		name: `${id}.frame.json`,
		mimeType: "application/vnd.fabric.frame",
		fileType: "FRAME",
		status: "COMPLETE",
		version: 1,
		isPublic: overrides.isPublic ?? false,
		shareToken: null,
		shareScope: overrides.shareScope ?? "PRIVATE",
		sourceRunType: null,
		sourceRunId: null,
		authoritySessionId: null,
		providerKeys: [],
		metadata: {
			frameVersion: 1,
			...(overrides.surface ? { surface: overrides.surface } : {}),
		},
		content: JSON.stringify({
			version: 1,
			kind: "frame",
			title: id,
			blocks: [{ id: "b", type: "html", content: "<p>page</p>" }],
			metadata: { runtime: { tools: ["fabric_list_workflows"] } },
		}),
		sharingGrants: (overrides.grants ?? []).map((email) => ({
			id: `grant-${id}-${email}`,
			frameId: id,
			email,
			invitedBy: overrides.userId,
			invitedAt: new Date(),
			lastAccessedAt: null,
			accessCount: 0,
		})),
		createdAt: new Date(2026, 0, 1),
		updatedAt: new Date(2026, 0, 1, 0, 0, tick),
	};
}

function project(id: string, userId: string, extra: Row = {}): Row {
	return { id, userId, organizationId: ORG, deletedAt: null, ...extra };
}

function accepted(projectId: string, userId: string, extra: Row = {}): Row {
	return {
		projectId,
		userId,
		acceptedAt: new Date("2026-01-01T00:00:00Z"),
		expiresAt: null,
		...extra,
	};
}

beforeEach(() => {
	tick = 0;
	store.members = [
		{ organizationId: ORG, userId: "owner" },
		{ organizationId: ORG, userId: "colleague" },
		{ organizationId: ORG, userId: "member" },
		{ organizationId: ORG, userId: "invited" },
		{ organizationId: OTHER_ORG, userId: "outsider" },
	];
	store.projects = [
		project("P1", "owner"),
		project("P2", "colleague"),
		project("P3", "owner", { deletedAt: new Date("2026-02-01T00:00:00Z") }),
		{ ...project("PB", "outsider"), organizationId: OTHER_ORG },
	];
	store.projectMembers = [
		accepted("P3", "member"),
		accepted("P1", "member"),
		accepted("P1", "guest"),
		accepted("P1", "expired", { expiresAt: YESTERDAY }),
		accepted("P1", "pending", { acceptedAt: null }),
		accepted("P1", "later", { expiresAt: TOMORROW }),
	];
	store.members.push(
		{ organizationId: ORG, userId: "expired" },
		{ organizationId: ORG, userId: "pending" },
		{ organizationId: ORG, userId: "later" },
	);
	store.frames = [
		frame("W-private", { userId: "owner", surface: "workspace" }),
		frame("W-org", {
			userId: "colleague",
			surface: "workspace",
			shareScope: "WORKSPACE_AND_EMAILS",
		}),
		frame("W-project", {
			userId: "colleague",
			surface: "workspace",
			projectId: "P1",
		}),
		frame("W-other-org", {
			userId: "outsider",
			organizationId: OTHER_ORG,
			surface: "workspace",
			shareScope: "WORKSPACE_AND_EMAILS",
		}),
		frame("W-emails", {
			userId: "owner",
			surface: "workspace",
			shareScope: "EMAILS_ONLY",
			grants: ["invited@example.com"],
		}),
		frame("A-artifact", {
			userId: "owner",
			surface: "artifact",
			projectId: "P1",
			shareScope: "PROJECT",
		}),
		frame("A-legacy", {
			userId: "owner",
			projectId: "P1",
			shareScope: "PROJECT",
		}),
		frame("A-second-project", {
			userId: "colleague",
			surface: "artifact",
			projectId: "P2",
			shareScope: "PROJECT",
		}),
		frame("A-trashed-project", {
			userId: "owner",
			surface: "artifact",
			projectId: "P3",
			shareScope: "PROJECT",
		}),
		frame("A-trashed-by-colleague", {
			userId: "colleague",
			surface: "artifact",
			projectId: "P3",
			shareScope: "PROJECT",
		}),
		frame("A-other-org", {
			userId: "outsider",
			organizationId: OTHER_ORG,
			surface: "artifact",
			projectId: "PB",
			shareScope: "PROJECT",
		}),
		frame("L-public", {
			userId: "colleague",
			shareScope: "PUBLIC",
			isPublic: true,
		}),
	];
});

const ids = (records: Array<{ id: string }>) => records.map((r) => r.id).sort();

describe("listWorkspaceFrames", () => {
	it("lists the creator's own workspaces, shared ones and those of projects they can open", async () => {
		const records = await listWorkspaceFrames({
			userId: "owner",
			organizationId: ORG,
		});
		expect(ids(records)).toEqual([
			"W-emails",
			"W-org",
			"W-private",
			"W-project",
		]);
	});

	it("shows an organization member the workspaces shared with the organization, not other people's private ones", async () => {
		const records = await listWorkspaceFrames({
			userId: "colleague",
			organizationId: ORG,
		});
		expect(ids(records)).toEqual(["W-org", "W-project"]);
	});

	it("adds a project's workspaces for an accepted project member", async () => {
		const records = await listWorkspaceFrames({
			userId: "member",
			organizationId: ORG,
		});
		expect(ids(records)).toEqual(["W-org", "W-project"]);
	});

	it("gives a project guest the project's workspaces but not those shared with the organization", async () => {
		const records = await listWorkspaceFrames({
			userId: "guest",
			organizationId: ORG,
		});
		expect(ids(records)).toEqual(["W-project"]);
	});

	it("does not count an expired or unaccepted project membership", async () => {
		for (const userId of ["expired", "pending"]) {
			const records = await listWorkspaceFrames({
				userId,
				organizationId: ORG,
			});
			expect(ids(records), userId).toEqual(["W-org"]);
		}
		const later = await listWorkspaceFrames({
			userId: "later",
			organizationId: ORG,
		});
		expect(ids(later)).toEqual(["W-org", "W-project"]);
	});

	it("shows someone from another organization nothing of this one", async () => {
		const records = await listWorkspaceFrames({
			userId: "outsider",
			organizationId: ORG,
		});
		expect(records).toEqual([]);
	});

	it("keeps each organization's workspaces to that organization", async () => {
		const records = await listWorkspaceFrames({
			userId: "outsider",
			organizationId: OTHER_ORG,
		});
		expect(ids(records)).toEqual(["W-other-org"]);
	});

	it("narrows to one project's workspaces", async () => {
		const records = await listWorkspaceFrames({
			userId: "owner",
			organizationId: ORG,
			projectId: "P1",
		});
		expect(ids(records)).toEqual(["W-project"]);
	});

	it("lists newest first and honours the limit", async () => {
		const records = await listWorkspaceFrames({
			userId: "owner",
			organizationId: ORG,
			limit: 2,
		});
		expect(records.map((r) => r.id)).toEqual(["W-emails", "W-project"]);
	});

	it("reports the surface and the runtime tools of each workspace", async () => {
		const [record] = await listWorkspaceFrames({
			userId: "owner",
			organizationId: ORG,
			limit: 1,
		});
		expect(record).toMatchObject({
			surface: "workspace",
			runtimeTools: ["fabric_list_workflows"],
		});
	});
});

describe("listProjectFrames", () => {
	it("lists a project's artifacts, legacy project frames included, to an accepted member", async () => {
		const records = await listProjectFrames({
			userId: "member",
			organizationId: ORG,
			projectId: "P1",
			surface: "artifact",
		});
		expect(ids(records)).toEqual(["A-artifact", "A-legacy"]);
	});

	it("leaves a workspace linked to the project out of its artifacts", async () => {
		const artifacts = await listProjectFrames({
			userId: "member",
			organizationId: ORG,
			projectId: "P1",
			surface: "artifact",
		});
		expect(ids(artifacts)).not.toContain("W-project");

		const everything = await listProjectFrames({
			userId: "member",
			organizationId: ORG,
			projectId: "P1",
		});
		expect(ids(everything)).toContain("W-project");
	});

	it("serves the project's owner and a project guest alike", async () => {
		for (const userId of ["owner", "guest"]) {
			const records = await listProjectFrames({
				userId,
				organizationId: ORG,
				projectId: "P1",
				surface: "artifact",
			});
			expect(ids(records), userId).toEqual(["A-artifact", "A-legacy"]);
		}
	});

	it("shows an organization member who is not on the project nothing of it", async () => {
		const records = await listProjectFrames({
			userId: "colleague",
			organizationId: ORG,
			projectId: "P1",
			surface: "artifact",
		});
		expect(records).toEqual([]);
	});

	it("shows someone from another organization nothing", async () => {
		const records = await listProjectFrames({
			userId: "outsider",
			organizationId: ORG,
			projectId: "P1",
			surface: "artifact",
		});
		expect(records).toEqual([]);
	});

	it("does not reach a project through the wrong organization", async () => {
		const records = await listProjectFrames({
			userId: "owner",
			organizationId: OTHER_ORG,
			projectId: "P1",
			surface: "artifact",
		});
		expect(records).toEqual([]);
	});

	it("spans only the projects the user can open when no project is named", async () => {
		const records = await listProjectFrames({
			userId: "owner",
			organizationId: ORG,
			surface: "artifact",
		});
		expect(ids(records)).toEqual(["A-artifact", "A-legacy"]);
	});

	it("leaves a trashed project's frames out", async () => {
		const records = await listProjectFrames({
			userId: "owner",
			organizationId: ORG,
			projectId: "P3",
		});
		expect(records).toEqual([]);
	});

	describe("when a project has more frames of the other surface than any scan could hold", () => {
		function crowdWithWorkspaces(count: number) {
			for (let index = 0; index < count; index++) {
				store.frames.push(
					frame(`W-bulk-${index}`, {
						userId: "owner",
						surface: "workspace",
						projectId: "P1",
					}),
				);
			}
		}

		it("still lists every artifact, the older ones as much as the newest", async () => {
			crowdWithWorkspaces(260);

			const records = await listProjectFrames({
				userId: "owner",
				organizationId: ORG,
				projectId: "P1",
				surface: "artifact",
			});

			expect(ids(records)).toEqual(["A-artifact", "A-legacy"]);
		});

		it("still lists the project's workspaces newest first, to the limit", async () => {
			crowdWithWorkspaces(260);

			const records = await listProjectFrames({
				userId: "owner",
				organizationId: ORG,
				projectId: "P1",
				surface: "workspace",
				limit: 3,
			});

			expect(records.map((r) => r.id)).toEqual([
				"W-bulk-259",
				"W-bulk-258",
				"W-bulk-257",
			]);
		});

		it("takes the limit from the artifacts, not from what the scan found", async () => {
			crowdWithWorkspaces(260);

			const records = await listProjectFrames({
				userId: "owner",
				organizationId: ORG,
				projectId: "P1",
				surface: "artifact",
				limit: 1,
			});

			expect(records).toHaveLength(1);
			expect(records[0].id).toMatch(/^A-/);
		});
	});

	it("lists every surface of a project when none is asked for", async () => {
		const records = await listProjectFrames({
			userId: "owner",
			organizationId: ORG,
			projectId: "P1",
		});

		expect(ids(records)).toEqual(["A-artifact", "A-legacy", "W-project"]);
	});
});

describe("getAccessibleFrameById", () => {
	const open = (id: string, userId: string, userEmail?: string) =>
		getAccessibleFrameById({ id, userId, userEmail, organizationId: ORG });

	it("opens a frame for its creator", async () => {
		expect(await open("W-private", "owner")).toMatchObject({
			id: "W-private",
		});
	});

	it("opens a frame shared with the organization for any member of it", async () => {
		expect(await open("W-org", "member")).toMatchObject({ id: "W-org" });
	});

	it("keeps a private frame from other organization members", async () => {
		expect(await open("W-private", "colleague")).toBeNull();
	});

	it("keeps a frame shared with the organization from people outside it", async () => {
		expect(await open("W-org", "guest")).toBeNull();
		expect(await open("W-org", "outsider")).toBeNull();
	});

	it("opens a project's frame for its accepted members and not for other organization members", async () => {
		expect(await open("A-artifact", "member")).toMatchObject({
			id: "A-artifact",
		});
		expect(await open("A-artifact", "guest")).toMatchObject({
			id: "A-artifact",
		});
		expect(await open("A-artifact", "colleague")).toBeNull();
	});

	it("treats the frames of a trashed project as gone for the people who had them through the project", async () => {
		expect(await open("A-trashed-by-colleague", "member")).toBeNull();
	});

	it("still opens a trashed project's frame for the person who made it", async () => {
		expect(await open("A-trashed-project", "owner")).toMatchObject({
			id: "A-trashed-project",
		});
	});

	it("opens the same frame again once the project is out of the trash", async () => {
		expect(await open("A-trashed-by-colleague", "member")).toBeNull();
		const trashed = store.projects.find((row) => row.id === "P3");
		if (trashed) {
			trashed.deletedAt = null;
		}

		expect(await open("A-trashed-by-colleague", "member")).toMatchObject({
			id: "A-trashed-by-colleague",
		});
	});

	it("opens an email-only frame for the invited address and no one else", async () => {
		expect(
			await open("W-emails", "invited", "Invited@example.com"),
		).toMatchObject({ id: "W-emails" });
		expect(await open("W-emails", "invited")).toBeNull();
		expect(
			await open("W-emails", "member", "member@example.com"),
		).toBeNull();
	});

	it("never opens a frame of another organization, whatever its share scope", async () => {
		expect(
			await getAccessibleFrameById({
				id: "W-other-org",
				userId: "owner",
				organizationId: ORG,
			}),
		).toBeNull();
		expect(
			await getAccessibleFrameById({
				id: "L-public",
				userId: "outsider",
				organizationId: OTHER_ORG,
			}),
		).toBeNull();
	});

	it("opens a public frame of the same organization", async () => {
		expect(await open("L-public", "invited")).toMatchObject({
			id: "L-public",
		});
	});

	it("finds nothing for an id that is not a frame", async () => {
		expect(await open("missing", "owner")).toBeNull();
	});
});
