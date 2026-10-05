/**
 * The GitLab instance a project's PM container lives on is recorded by the
 * server when the container is chosen — from the chooser's own GitLab — and
 * is never taken from the client. An unchanged selection keeps the recorded
 * instance whoever saves it, so another member's (or a reconnected) GitLab
 * on a different instance cannot re-bind an existing container to itself.
 */
import { beforeEach, describe, expect, it, vi } from "vitest";

const db = vi.hoisted(() => ({
	servers: {} as Record<string, string>,
	configs: [] as Array<Record<string, unknown>>,
	drafts: [] as Array<Record<string, unknown>>,
}));

vi.mock("@repo/database", () => ({
	isGitLabPersonalMcpServerKey: (key: string | null | undefined) =>
		key === "gitlab" || key === "gitlab-official",
	isPmServerIdKeySentinel: (id: string) => id.startsWith("key:"),
	readPmServerIdKeySentinel: (id: string) => id.slice("key:".length),
	db: {
		mCPServer: {
			findUnique: async (args: { where: { id: string } }) =>
				db.servers[args.where.id]
					? { key: db.servers[args.where.id] }
					: null,
		},
		mCPConfig: {
			findFirst: async (args: { where: Record<string, unknown> }) =>
				db.configs.find(
					(row) =>
						row.id === args.where.id &&
						row.userId === args.where.userId &&
						row.organizationId === args.where.organizationId,
				) ?? null,
		},
		project: {
			findFirst: async (args: { where: Record<string, unknown> }) =>
				db.drafts.find((row) => row.draftKey === args.where.draftKey) ??
				null,
		},
	},
}));

const findUsableGitLabConnection = vi.hoisted(() => vi.fn());
vi.mock("@repo/integrations/gitlab", async (importOriginal) => ({
	...(await importOriginal<object>()),
	findUsableGitLabConnection: (...args: unknown[]) =>
		findUsableGitLabConnection(...args),
}));

import {
	bindGitLabPmContainerOrigin,
	readDraftPmSelection,
	saveWithGitLabPmBinding,
} from "../gitlab-pm-origin";

const actor = { userId: "user-2", organizationId: "org-example" };
const LABELS = { labelStatusMap: '{"doing":"IN_PROGRESS"}' };

beforeEach(() => {
	vi.clearAllMocks();
	db.servers = {
		"srv-gitlab": "gitlab-official",
		"srv-jira": "atlassian",
	};
	db.configs = [];
	db.drafts = [];
	findUsableGitLabConnection.mockResolvedValue({
		integrationId: "wi-2",
		origin: "https://gitlab.example.com",
	});
});

describe("bindGitLabPmContainerOrigin", () => {
	it("records the chooser's connection instance when a GitLab container is chosen", async () => {
		const stored = await bindGitLabPmContainerOrigin({
			actor,
			stored: null,
			next: {
				serverId: "srv-gitlab",
				configId: null,
				containerId: "42",
				additionalContext: LABELS,
			},
		});

		expect(stored).toEqual({
			...LABELS,
			gitlabOrigin: "https://gitlab.example.com",
		});
		expect(findUsableGitLabConnection).toHaveBeenCalledWith(actor);
	});

	it("records the selected GitLab MCP config's instance over the connection's", async () => {
		db.configs = [
			{
				id: "cfg-gl",
				userId: "user-2",
				organizationId: "org-example",
				baseUrl: "https://gitlab.other.example.com/api/v4/mcp",
				mcpServer: {
					key: "gitlab-official",
					defaultUrl: "https://gitlab.com/api/v4/mcp",
				},
			},
		];

		const stored = await bindGitLabPmContainerOrigin({
			actor,
			stored: null,
			next: {
				serverId: "srv-gitlab",
				configId: "cfg-gl",
				containerId: "42",
				additionalContext: undefined,
			},
		});

		expect(stored).toEqual({
			gitlabOrigin: "https://gitlab.other.example.com",
		});
		expect(findUsableGitLabConnection).not.toHaveBeenCalled();
	});

	it("never stores an instance the client sent", async () => {
		// A legacy selection (no recorded instance) re-saved with one.
		const stored = await bindGitLabPmContainerOrigin({
			actor,
			stored: {
				serverId: "srv-gitlab",
				configId: null,
				containerId: "42",
				additionalContext: LABELS,
			},
			next: {
				serverId: "srv-gitlab",
				configId: null,
				containerId: "42",
				additionalContext: {
					...LABELS,
					gitlabOrigin: "https://gitlab.example.com",
				},
			},
		});

		expect(stored).toEqual(LABELS);
	});

	it("keeps the recorded instance on an unchanged selection, whoever saves it", async () => {
		const stored = await bindGitLabPmContainerOrigin({
			actor,
			stored: {
				serverId: "srv-gitlab",
				configId: null,
				containerId: "42",
				additionalContext: {
					...LABELS,
					gitlabOrigin: "https://gitlab.com",
				},
			},
			next: {
				serverId: "srv-gitlab",
				configId: null,
				containerId: "42",
				additionalContext: {
					...LABELS,
					gitlabOrigin: "https://gitlab.example.com",
				},
			},
		});

		expect(stored).toEqual({
			...LABELS,
			gitlabOrigin: "https://gitlab.com",
		});
		// The saver's own instance was never consulted.
		expect(findUsableGitLabConnection).not.toHaveBeenCalled();
	});

	it("re-records the instance when the container changes", async () => {
		const stored = await bindGitLabPmContainerOrigin({
			actor,
			stored: {
				serverId: "srv-gitlab",
				configId: null,
				containerId: "42",
				additionalContext: { gitlabOrigin: "https://gitlab.com" },
			},
			next: {
				serverId: undefined,
				configId: undefined,
				containerId: "77",
				additionalContext: undefined,
			},
		});

		expect(stored).toEqual({ gitlabOrigin: "https://gitlab.example.com" });
	});

	it("records no instance for a selection that is not a GitLab container", async () => {
		const stored = await bindGitLabPmContainerOrigin({
			actor,
			stored: {
				serverId: "srv-gitlab",
				configId: null,
				containerId: "42",
				additionalContext: { gitlabOrigin: "https://gitlab.com" },
			},
			next: {
				serverId: "srv-jira",
				configId: "cfg-jira",
				containerId: "EXAMPLE",
				additionalContext: {
					gitlabOrigin: "https://gitlab.example.com",
				},
			},
		});

		expect(stored).toEqual({});
		expect(findUsableGitLabConnection).not.toHaveBeenCalled();
	});

	it("writes nothing when nothing was sent and the selection is unchanged", async () => {
		expect(
			await bindGitLabPmContainerOrigin({
				actor,
				stored: {
					serverId: "srv-gitlab",
					configId: null,
					containerId: "42",
					additionalContext: { gitlabOrigin: "https://gitlab.com" },
				},
				next: {
					serverId: undefined,
					configId: undefined,
					containerId: undefined,
					additionalContext: undefined,
				},
			}),
		).toBeUndefined();
	});
});

describe("readDraftPmSelection", () => {
	it("reads the caller's draft selection", async () => {
		db.drafts = [
			{
				draftKey: "draft-1",
				projectManagementMcpServerId: "srv-gitlab",
				projectManagementMcpConfigId: null,
				projectManagementContainerId: "42",
				projectManagementAdditionalContext: {
					gitlabOrigin: "https://gitlab.com",
				},
			},
		];

		expect(
			await readDraftPmSelection({ draftKey: "draft-1", actor }),
		).toEqual({
			serverId: "srv-gitlab",
			configId: null,
			containerId: "42",
			additionalContext: { gitlabOrigin: "https://gitlab.com" },
		});
		expect(
			await readDraftPmSelection({ draftKey: "draft-2", actor }),
		).toBeNull();
	});
});

/**
 * Two saves of one project, interleaved deterministically against an
 * in-memory row whose guarded write behaves like
 * `pmSelectionUnchangedWhere` (P2025 when the selection it was bound from
 * is no longer the row's).
 */
describe("saveWithGitLabPmBinding — concurrent saves", () => {
	type Row = {
		serverId: string | null;
		configId: string | null;
		containerId: string | null;
		additionalContext: unknown;
	};

	function store(initial: Row) {
		let row: Row = structuredClone(initial);
		return {
			get row() {
				return row;
			},
			read: async (): Promise<Row> => structuredClone(row),
			write: async (
				next: Partial<Omit<Row, "additionalContext">>,
				additionalContext: unknown,
				expected: Row | null | undefined,
			) => {
				if (
					expected &&
					JSON.stringify(expected) !== JSON.stringify(row)
				) {
					throw Object.assign(
						new Error("Record to update not found."),
						{
							code: "P2025",
						},
					);
				}
				row = {
					serverId:
						next.serverId !== undefined
							? next.serverId
							: row.serverId,
					configId:
						next.configId !== undefined
							? next.configId
							: row.configId,
					containerId:
						next.containerId !== undefined
							? next.containerId
							: row.containerId,
					additionalContext:
						additionalContext !== undefined
							? additionalContext
							: row.additionalContext,
				};
				return row;
			},
		};
	}

	it("a context-only save that read container 42 cannot pair its instance with container 77", async () => {
		const project = store({
			serverId: "srv-gitlab",
			configId: null,
			containerId: "42",
			additionalContext: {
				...LABELS,
				gitlabOrigin: "https://gitlab.com",
			},
		});
		// Save A (a gitlab.com member) reads, then waits before writing.
		let releaseA: () => void = () => undefined;
		const aMayWrite = new Promise<void>((resolve) => {
			releaseA = resolve;
		});
		const nextA = {
			serverId: undefined,
			configId: undefined,
			containerId: undefined,
			additionalContext: { labelStatusMap: '{"done":"DONE"}' },
		};
		const saveA = saveWithGitLabPmBinding({
			actor: { userId: "user-a", organizationId: "org-example" },
			stored: await project.read(),
			next: nextA,
			reread: project.read,
			write: async (ctx, expected) => {
				await aMayWrite;
				return project.write(nextA, ctx, expected);
			},
		});

		// Save B (a gitlab.example.com member) switches to container 77.
		const nextB = {
			serverId: "srv-gitlab",
			configId: null,
			containerId: "77",
			additionalContext: undefined,
		};
		await saveWithGitLabPmBinding({
			actor,
			stored: await project.read(),
			next: nextB,
			reread: project.read,
			write: (ctx, expected) => project.write(nextB, ctx, expected),
		});
		expect(project.row).toMatchObject({
			containerId: "77",
			additionalContext: { gitlabOrigin: "https://gitlab.example.com" },
		});

		releaseA();
		await saveA;

		// A's label map landed, and container 77 kept the instance it was
		// chosen on — not the gitlab.com instance A read for container 42.
		expect(project.row).toEqual({
			serverId: "srv-gitlab",
			configId: null,
			containerId: "77",
			additionalContext: {
				labelStatusMap: '{"done":"DONE"}',
				gitlabOrigin: "https://gitlab.example.com",
			},
		});
	});

	it("gives up after three conflicting attempts and rethrows", async () => {
		const conflict = Object.assign(
			new Error("Record to update not found."),
			{
				code: "P2025",
			},
		);
		const write = vi.fn(async () => {
			throw conflict;
		});
		await expect(
			saveWithGitLabPmBinding({
				actor,
				stored: {
					serverId: "srv-gitlab",
					configId: null,
					containerId: "42",
					additionalContext: null,
				},
				next: {
					serverId: undefined,
					configId: undefined,
					containerId: "77",
					additionalContext: undefined,
				},
				reread: async () => ({
					serverId: "srv-gitlab",
					configId: null,
					containerId: "42",
					additionalContext: null,
				}),
				write,
			}),
		).rejects.toBe(conflict);
		expect(write).toHaveBeenCalledTimes(3);
	});

	it("does not require the selection when the save writes no PM field", async () => {
		const write = vi.fn(async () => "saved");
		await saveWithGitLabPmBinding({
			actor,
			stored: {
				serverId: "srv-gitlab",
				configId: null,
				containerId: "42",
				additionalContext: { gitlabOrigin: "https://gitlab.com" },
			},
			next: {
				serverId: undefined,
				configId: undefined,
				containerId: undefined,
				additionalContext: undefined,
			},
			reread: async () => null,
			write,
		});
		expect(write).toHaveBeenCalledWith(undefined, undefined);
	});
});
