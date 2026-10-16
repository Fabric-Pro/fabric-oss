/**
 * Who may list, open and share a Fabric Agent session.
 *
 * The queries run over an in-memory table that answers the `where` and
 * `orderBy` shapes they build (see `_helpers/in-memory-rows.ts`), so each case
 * drives the real predicates and checks which sessions come back. That the
 * policy in the database agrees is pinned in
 * `agent-conversation-sharing.integration.test.ts`.
 */
import { beforeEach, describe, expect, it, vi } from "vitest";
import { type Row, sortRows } from "./_helpers/in-memory-rows";

const store = vi.hoisted(() => ({
	rows: [] as Array<Record<string, unknown>>,
	users: [] as Array<{ id: string; name: string }>,
	queries: 0,
}));

vi.mock("../prisma/client", async () => {
	const { matchesWhere, sortRows } = await import(
		"./_helpers/in-memory-rows"
	);
	const withUser = (row: Row) => ({
		...row,
		user: store.users.find((u) => u.id === row.userId),
	});
	return {
		db: {
			agentConversation: {
				findMany: async ({
					where,
					orderBy,
					skip = 0,
					take,
				}: {
					where: Row;
					orderBy?: Array<Record<string, "asc" | "desc">>;
					skip?: number;
					take?: number;
				}) => {
					store.queries += 1;
					return sortRows(
						(store.rows as Row[]).filter((r) =>
							matchesWhere(r, where),
						),
						orderBy,
					)
						.slice(
							skip,
							take === undefined ? undefined : skip + take,
						)
						.map(withUser);
				},
				count: async ({ where }: { where: Row }) => {
					store.queries += 1;
					return (store.rows as Row[]).filter((r) =>
						matchesWhere(r, where),
					).length;
				},
				findFirst: async ({ where }: { where: Row }) => {
					store.queries += 1;
					const row = (store.rows as Row[]).find((r) =>
						matchesWhere(r, where),
					);
					return row ? withUser(row) : null;
				},
				findFirstOrThrow: async ({ where }: { where: Row }) => {
					const row = (store.rows as Row[]).find((r) =>
						matchesWhere(r, where),
					);
					if (!row) {
						throw new Error("not found");
					}
					return row;
				},
				updateMany: async ({
					where,
					data,
				}: {
					where: Row;
					data: Row;
				}) => {
					store.queries += 1;
					const hit = (store.rows as Row[]).filter((r) =>
						matchesWhere(r, where),
					);
					for (const row of hit) {
						Object.assign(row, data);
					}
					return { count: hit.length };
				},
			},
		},
	};
});

import {
	AgentConversationCursorError,
	countAgentConversationsForViewer,
	getAgentConversationForViewer,
	listAgentConversationsForViewer,
	setAgentConversationVisibility,
} from "../prisma/queries/agent-conversation-sharing";
import { ConversationNotFoundError } from "../prisma/queries/agent-conversations";

const ORG = "org-a";
const OTHER_ORG = "org-b";
const AGENT = "fabric-workspace-assistant";
const ME = "user-me";
const ANA = "user-ana";

let nextId = 0;
function session(fields: Record<string, unknown>) {
	nextId += 1;
	const row = {
		id: `c${String(nextId).padStart(2, "0")}`,
		userId: ME,
		organizationId: ORG,
		agentId: AGENT,
		title: `Session ${nextId}`,
		messages: [],
		pinned: false,
		status: "ACTIVE",
		visibility: "PRIVATE",
		createdAt: new Date(Date.UTC(2026, 9, 1)),
		updatedAt: new Date(Date.UTC(2026, 9, 1, 0, 0, nextId)),
		...fields,
	};
	store.rows.push(row);
	return row;
}

function list(
	scope: "mine" | "shared",
	extra: Partial<Parameters<typeof listAgentConversationsForViewer>[0]> = {},
) {
	return listAgentConversationsForViewer({
		userId: ME,
		organizationId: ORG,
		agentId: AGENT,
		scope,
		limit: 50,
		...extra,
	});
}

const ids = (items: Array<{ id: string }>) => items.map((i) => i.id);

beforeEach(() => {
	store.rows = [];
	store.queries = 0;
	nextId = 0;
	store.users = [
		{ id: ME, name: "Me Myself" },
		{ id: ANA, name: "Ana" },
	];
});

describe("listAgentConversationsForViewer", () => {
	it("lists only the viewer's own sessions as mine, shared ones included", async () => {
		const privateOne = session({});
		const sharedOne = session({ visibility: "ORGANIZATION" });
		session({ userId: ANA, visibility: "ORGANIZATION" });
		session({ userId: ANA });

		const { items } = await list("mine");

		expect(ids(items).sort()).toEqual([privateOne.id, sharedOne.id].sort());
		expect(items.every((i) => i.isOwn)).toBe(true);
	});

	it("lists every shared session of the organization as shared, the viewer's own among them", async () => {
		const mineShared = session({ visibility: "ORGANIZATION" });
		const anasShared = session({ userId: ANA, visibility: "ORGANIZATION" });
		session({});
		session({ userId: ANA });

		const { items } = await list("shared");

		expect(ids(items).sort()).toEqual(
			[mineShared.id, anasShared.id].sort(),
		);
	});

	describe("with no agent named", () => {
		const OTHER_AGENT = "workflow-assistant";
		const anyAgent = { agentId: undefined } as const;

		it("lists the viewer's own sessions across every agent of the organization as mine", async () => {
			const withFirst = session({});
			const withSecond = session({ agentId: OTHER_AGENT });
			session({ userId: ANA, agentId: OTHER_AGENT });
			session({ organizationId: OTHER_ORG, agentId: OTHER_AGENT });

			const { items } = await list("mine", anyAgent);

			expect(ids(items).sort()).toEqual(
				[withFirst.id, withSecond.id].sort(),
			);
			expect(items.every((i) => i.isOwn)).toBe(true);
		});

		it("still narrows to one agent when one is named", async () => {
			session({});
			const withSecond = session({ agentId: OTHER_AGENT });

			expect(
				ids((await list("mine", { agentId: OTHER_AGENT })).items),
			).toEqual([withSecond.id]);
		});

		it("lists the sessions shared with the organization across every agent as shared, and no other member's private ones", async () => {
			const mineShared = session({ visibility: "ORGANIZATION" });
			const anasSharedElsewhere = session({
				userId: ANA,
				agentId: OTHER_AGENT,
				visibility: "ORGANIZATION",
			});
			session({});
			session({ userId: ANA });
			session({ userId: ANA, agentId: OTHER_AGENT });
			session({
				organizationId: OTHER_ORG,
				agentId: OTHER_AGENT,
				visibility: "ORGANIZATION",
			});

			const { items } = await list("shared", anyAgent);

			expect(ids(items).sort()).toEqual(
				[mineShared.id, anasSharedElsewhere.id].sort(),
			);
		});

		it("keeps the status filter and the title search across agents", async () => {
			const archived = session({
				status: "ARCHIVED",
				agentId: OTHER_AGENT,
				title: "Old plan",
			});
			session({ status: "ARCHIVED", title: "Old notes" });
			session({ agentId: OTHER_AGENT, title: "Fresh plan" });

			const { items } = await list("mine", {
				...anyAgent,
				status: "ARCHIVED",
				search: "plan",
			});

			expect(ids(items)).toEqual([archived.id]);
		});

		it("pages across agents by cursor, each session once", async () => {
			const first = session({ updatedAt: new Date(3) });
			const second = session({
				agentId: OTHER_AGENT,
				updatedAt: new Date(2),
			});
			const third = session({ updatedAt: new Date(1) });

			const page = await list("mine", { ...anyAgent, limit: 2 });
			const rest = await list("mine", {
				...anyAgent,
				limit: 2,
				cursor: page.nextCursor,
			});

			expect(ids(page.items)).toEqual([first.id, second.id]);
			expect(ids(rest.items)).toEqual([third.id]);
			expect(rest.nextCursor).toBeUndefined();
		});
	});

	it("never lists another organization's sessions or another agent's", async () => {
		session({ organizationId: OTHER_ORG, visibility: "ORGANIZATION" });
		session({ organizationId: OTHER_ORG });
		session({ agentId: "someone-else", visibility: "ORGANIZATION" });
		const keep = session({ visibility: "ORGANIZATION" });

		expect(ids((await list("shared")).items)).toEqual([keep.id]);
		expect(ids((await list("mine")).items)).toEqual([keep.id]);
	});

	it("says who owns each session and whether it is the viewer's", async () => {
		session({
			title: "Mine",
			visibility: "ORGANIZATION",
			updatedAt: new Date(2),
		});
		session({
			title: "Anas",
			userId: ANA,
			visibility: "ORGANIZATION",
			updatedAt: new Date(1),
		});

		const { items } = await list("shared");

		expect(items.map((i) => [i.title, i.isOwn, i.owner])).toEqual([
			["Mine", true, { id: ME, name: "Me Myself" }],
			["Anas", false, { id: ANA, name: "Ana" }],
		]);
		expect(items[0]).not.toHaveProperty("user");
		expect(items[0]).toMatchObject({
			visibility: "ORGANIZATION",
			status: "ACTIVE",
		});
	});

	it("puts pinned sessions first in the viewer's list but ignores pins in the shared list", async () => {
		const older = session({
			pinned: true,
			visibility: "ORGANIZATION",
			updatedAt: new Date(1),
		});
		const newer = session({
			visibility: "ORGANIZATION",
			updatedAt: new Date(2),
		});

		expect(ids((await list("mine")).items)).toEqual([older.id, newer.id]);
		expect(ids((await list("shared")).items)).toEqual([newer.id, older.id]);
	});

	it("filters by status and by a case-insensitive title search", async () => {
		const budget = session({ title: "Quarterly Budget review" });
		session({ title: "Standup notes" });
		const archived = session({ title: "Old budget", status: "ARCHIVED" });

		expect(
			ids((await list("mine", { search: "BUDGET" })).items).sort(),
		).toEqual([budget.id, archived.id].sort());
		expect(
			ids(
				(await list("mine", { search: "budget", status: "ARCHIVED" }))
					.items,
			),
		).toEqual([archived.id]);
		expect(ids((await list("mine", { status: "ARCHIVED" })).items)).toEqual(
			[archived.id],
		);
	});

	it("treats a blank search as no search", async () => {
		session({});
		session({});

		expect((await list("mine", { search: "   " })).items).toHaveLength(2);
	});

	describe("paging", () => {
		function walk(scope: "mine" | "shared", limit: number) {
			return (async () => {
				const seen: string[] = [];
				let cursor: string | undefined;
				let pages = 0;
				do {
					const page = await list(scope, { limit, cursor });
					seen.push(...ids(page.items));
					cursor = page.nextCursor;
					pages += 1;
				} while (cursor && pages < 20);
				return { seen, pages };
			})();
		}

		it("walks the viewer's list once each, pinned first, through ties on time", async () => {
			const tie = new Date(Date.UTC(2026, 9, 2));
			session({ pinned: true, updatedAt: tie });
			session({
				pinned: true,
				updatedAt: new Date(Date.UTC(2026, 9, 1)),
			});
			session({ updatedAt: tie });
			session({ updatedAt: tie });
			session({ updatedAt: tie });
			session({ updatedAt: new Date(Date.UTC(2026, 8, 1)) });
			session({
				pinned: true,
				updatedAt: new Date(Date.UTC(2026, 8, 1)),
			});
			const expected = ids(
				sortRows(store.rows as Row[], [
					{ pinned: "desc" },
					{ updatedAt: "desc" },
					{ id: "desc" },
				]) as Array<{ id: string }>,
			);

			const { seen, pages } = await walk("mine", 2);

			expect(seen).toEqual(expected);
			expect(new Set(seen).size).toBe(7);
			expect(pages).toBe(4);
		});

		it("walks the shared list once each, newest first", async () => {
			const tie = new Date(Date.UTC(2026, 9, 2));
			for (let i = 0; i < 6; i++) {
				session({
					userId: i % 2 ? ANA : ME,
					visibility: "ORGANIZATION",
					pinned: i === 0,
					updatedAt:
						i < 3 ? tie : new Date(Date.UTC(2026, 9, 1, 0, 0, i)),
				});
			}
			const expected = ids(
				sortRows(store.rows as Row[], [
					{ updatedAt: "desc" },
					{ id: "desc" },
				]) as Array<{ id: string }>,
			);

			const { seen } = await walk("shared", 4);

			expect(seen).toEqual(expected);
		});

		it("gives no cursor when everything fits", async () => {
			session({});

			expect((await list("mine")).nextCursor).toBeUndefined();
		});

		it("refuses a cursor it did not issue", async () => {
			await expect(
				list("mine", { cursor: "garbage" }),
			).rejects.toBeInstanceOf(AgentConversationCursorError);
		});

		it("caps a huge limit at 100", async () => {
			for (let i = 0; i < 120; i++) {
				session({});
			}

			const page = await list("mine", { limit: 10_000 });

			expect(page.items).toHaveLength(100);
			expect(page.nextCursor).toBeDefined();
		});
	});

	it("needs an organization and asks the database nothing without one", async () => {
		await expect(
			listAgentConversationsForViewer({
				userId: ME,
				organizationId: "",
				agentId: AGENT,
				scope: "shared",
				limit: 10,
			}),
		).rejects.toBeInstanceOf(ConversationNotFoundError);
		expect(store.queries).toBe(0);
	});
});

describe("the offset the public route still takes for its older clients", () => {
	const times = (count: number) =>
		Array.from({ length: count }, (_, index) =>
			session({ updatedAt: new Date(count - index) }),
		);

	it("skips that many sessions when no cursor is given", async () => {
		const all = times(5);

		const { items, nextCursor } = await list("mine", {
			offset: 2,
			limit: 2,
		});

		expect(ids(items)).toEqual([all[2].id, all[3].id]);
		expect(nextCursor).toBeDefined();
	});

	it("says there is no more past the last of them", async () => {
		times(5);

		const { items, nextCursor } = await list("mine", {
			offset: 4,
			limit: 2,
		});

		expect(items).toHaveLength(1);
		expect(nextCursor).toBeUndefined();
	});

	it("is ignored once a cursor is given, so a cursor walk is not skipped twice", async () => {
		const all = times(5);
		const first = await list("mine", { limit: 2 });

		const second = await list("mine", {
			limit: 2,
			offset: 3,
			cursor: first.nextCursor,
		});

		expect(ids(second.items)).toEqual([all[2].id, all[3].id]);
	});
});

describe("countAgentConversationsForViewer", () => {
	const count = (
		scope: "mine" | "shared",
		extra: Partial<
			Parameters<typeof countAgentConversationsForViewer>[0]
		> = {},
	) =>
		countAgentConversationsForViewer({
			userId: ME,
			organizationId: ORG,
			agentId: AGENT,
			scope,
			...extra,
		});

	it("counts what the list is over, with the same filter: the viewer's own for mine, the shared ones for shared", async () => {
		session({});
		session({ visibility: "ORGANIZATION" });
		session({ userId: ANA, visibility: "ORGANIZATION" });
		session({ userId: ANA });
		session({ organizationId: OTHER_ORG, visibility: "ORGANIZATION" });

		expect(await count("mine")).toBe(2);
		expect(await count("shared")).toBe(2);
	});

	it("counts across agents when none is named, and one agent's when it is", async () => {
		session({});
		session({ agentId: "workflow-assistant" });

		expect(await count("mine", { agentId: undefined })).toBe(2);
		expect(await count("mine")).toBe(1);
	});

	it("applies the status and the title search the list applies", async () => {
		session({ title: "Old plan", status: "ARCHIVED" });
		session({ title: "Old notes", status: "ARCHIVED" });
		session({ title: "Fresh plan" });

		expect(await count("mine", { status: "ARCHIVED" })).toBe(2);
		expect(await count("mine", { search: "PLAN" })).toBe(2);
		expect(
			await count("mine", { status: "ARCHIVED", search: "plan" }),
		).toBe(1);
	});

	it("needs an organization and asks the database nothing without one", async () => {
		await expect(
			count("mine", { organizationId: "" }),
		).rejects.toBeInstanceOf(ConversationNotFoundError);
		expect(store.queries).toBe(0);
	});
});

describe("getAgentConversationForViewer", () => {
	const get = (id: string, userId = ME, organizationId = ORG) =>
		getAgentConversationForViewer({ id, userId, organizationId });

	it("opens the viewer's own private session", async () => {
		const own = session({});

		expect(await get(own.id)).toMatchObject({
			id: own.id,
			isOwn: true,
			owner: { id: ME, name: "Me Myself" },
		});
	});

	it("opens another member's session only when it is shared", async () => {
		const shared = session({ userId: ANA, visibility: "ORGANIZATION" });
		const hidden = session({ userId: ANA });

		expect(await get(shared.id)).toMatchObject({
			isOwn: false,
			owner: { id: ANA, name: "Ana" },
		});
		expect(await get(hidden.id)).toBeNull();
	});

	it("does not open a shared session of another organization", async () => {
		const elsewhere = session({
			userId: ANA,
			organizationId: OTHER_ORG,
			visibility: "ORGANIZATION",
		});

		expect(await get(elsewhere.id)).toBeNull();
		expect(await get(elsewhere.id, ME, OTHER_ORG)).not.toBeNull();
	});

	it("returns null for an unknown id and needs an organization", async () => {
		expect(await get("nope")).toBeNull();
		await expect(get("nope", ME, "")).rejects.toBeInstanceOf(
			ConversationNotFoundError,
		);
	});
});

describe("setAgentConversationVisibility", () => {
	const set = (
		id: string,
		visibility: "PRIVATE" | "ORGANIZATION",
		userId = ME,
		organizationId = ORG,
	) =>
		setAgentConversationVisibility({
			id,
			userId,
			organizationId,
			visibility,
		});

	it("lets the owner share a session and take it back", async () => {
		const own = session({});

		expect((await set(own.id, "ORGANIZATION")).visibility).toBe(
			"ORGANIZATION",
		);
		expect(own.visibility).toBe("ORGANIZATION");
		expect((await set(own.id, "PRIVATE")).visibility).toBe("PRIVATE");
	});

	it("does not let another member change a session, shared or not", async () => {
		const shared = session({ userId: ANA, visibility: "ORGANIZATION" });
		const hidden = session({ userId: ANA });

		await expect(set(shared.id, "PRIVATE")).rejects.toBeInstanceOf(
			ConversationNotFoundError,
		);
		await expect(set(hidden.id, "ORGANIZATION")).rejects.toBeInstanceOf(
			ConversationNotFoundError,
		);
		expect(shared.visibility).toBe("ORGANIZATION");
		expect(hidden.visibility).toBe("PRIVATE");
	});

	it("does not reach a session of another organization", async () => {
		const elsewhere = session({ organizationId: OTHER_ORG });

		await expect(set(elsewhere.id, "ORGANIZATION")).rejects.toBeInstanceOf(
			ConversationNotFoundError,
		);
		expect(elsewhere.visibility).toBe("PRIVATE");
	});

	it("needs an organization", async () => {
		const own = session({});

		await expect(
			set(own.id, "ORGANIZATION", ME, ""),
		).rejects.toBeInstanceOf(ConversationNotFoundError);
		expect(own.visibility).toBe("PRIVATE");
	});
});
