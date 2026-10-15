/**
 * `projects.contexts.repositorySync.writeTargets.{list,create,update,delete}`
 * and `projects.contexts.memoryWrites.validate` — the Living Memory write
 * folders and the admission check (ADR-022).
 *
 * Each call runs the procedure's REAL middleware chain in its declared order
 * — `projectNotFoundUnlessVisible`, then the real `requireProjectPermission`
 * — before the handler. The database layer is mocked, but the mock for the
 * two writers RUNS the `decide` function the procedure hands it against a
 * fixed sync, as the transaction does, so the folder rules, the direct-push
 * rule and the refusals are the real ones. What the transaction itself writes
 * is `context-write-targets.test.ts`'s.
 *
 * What this pins:
 *  - CONTEXT_CREATE is required, and the organization is the project's host,
 *    never the session's;
 *  - DIRECT_PUSH needs PROJECT_SETTINGS_EDIT on the RESULT of a create or an
 *    update, answered FORBIDDEN `DIRECT_PUSH_REQUIRES_ADMIN`, and is allowed
 *    with it; PULL_REQUEST and delete need only CONTEXT_CREATE;
 *  - every folder refusal is BAD_REQUEST with `data.code` and `data.path`;
 *  - each mutation is audited with its folder and mode, and a refusal is not;
 *  - `validate` answers what admission says, for the project's host
 *    organization, and persists nothing.
 */
import { beforeEach, describe, expect, it, vi } from "vitest";

const m = vi.hoisted(() => ({
	resolveEffectiveProjectPermissions: vi.fn(),
	hasProjectAccess: vi.fn(),
	grantProjectAccess: vi.fn(),
	recordAuditFromRequest: vi.fn(),
	createContextWriteTarget: vi.fn(),
	updateContextWriteTarget: vi.fn(),
	deleteContextWriteTarget: vi.fn(),
	listContextWriteTargets: vi.fn(),
	getMemoryWriteAdmissionState: vi.fn(),
}));

vi.mock("@repo/database", async () => ({
	...(await import(
		"@repo/database/prisma/queries/projects/context-source-path"
	)),
	...(await import(
		"@repo/database/prisma/queries/projects/context-repository-sync-selection"
	)),
	db: {},
	hasProjectAccess: m.hasProjectAccess,
	grantProjectAccess: m.grantProjectAccess,
	createContextWriteTarget: m.createContextWriteTarget,
	updateContextWriteTarget: m.updateContextWriteTarget,
	deleteContextWriteTarget: m.deleteContextWriteTarget,
	listContextWriteTargets: m.listContextWriteTargets,
	getMemoryWriteAdmissionState: m.getMemoryWriteAdmissionState,
}));
vi.mock("../../../../../../../lib/audit", () => ({
	recordAuditFromRequest: m.recordAuditFromRequest,
}));
vi.mock("../../../../../../../lib/effective-project-permissions", () => ({
	resolveEffectiveProjectPermissions: m.resolveEffectiveProjectPermissions,
}));

// Each `.use(...)` returns a builder carrying its own chain;
// `requireProjectPermission` is the real one.
vi.mock("../../../../../../../orpc/procedures", async () => {
	const { requireProjectPermission } = await vi.importActual<
		typeof import("../../../../../../../orpc/middleware/require-permission")
	>("../../../../../../../orpc/middleware/require-permission");
	const { Permissions } =
		await vi.importActual<typeof import("@repo/permissions")>(
			"@repo/permissions",
		);
	function builder(chain: unknown[], schema?: unknown) {
		const b: Record<string, unknown> = {};
		b.use = (middleware: unknown) =>
			builder([...chain, middleware], schema);
		b.route = () => b;
		b.input = (next: unknown) => builder(chain, next);
		b.handler = (fn: unknown) => ({
			handler: fn,
			middlewares: chain,
			inputSchema: schema,
		});
		return b;
	}
	return {
		tenantProtectedProcedure: builder([]),
		requireProjectPermission,
		Permissions,
	};
});

import { validateMemoryWriteProcedure } from "../../../memory-writes/validate";
import { createContextWriteTargetProcedure } from "../create";
import { deleteContextWriteTargetProcedure } from "../delete";
import { listContextWriteTargetsProcedure } from "../list";
import { updateContextWriteTargetProcedure } from "../update";

type Ctx = {
	user: { id: string; name: string; email: string };
	session: { id: string; activeOrganizationId: string | null };
};
type Built = {
	handler: (args: { input: unknown; context: Ctx }) => Promise<unknown>;
	middlewares: Middleware[];
	inputSchema: {
		safeParse(v: unknown): { success: boolean; data?: unknown };
	};
};
type Middleware = (
	options: {
		context: Ctx;
		next: (options?: {
			context?: object;
		}) => Promise<{ output: unknown; context: object }>;
	},
	input: unknown,
) => Promise<{ output: unknown }>;

const procedures = {
	list: listContextWriteTargetsProcedure,
	create: createContextWriteTargetProcedure,
	update: updateContextWriteTargetProcedure,
	delete: deleteContextWriteTargetProcedure,
	validate: validateMemoryWriteProcedure,
} as unknown as Record<
	"list" | "create" | "update" | "delete" | "validate",
	Built
>;

// The caller's session sits in org-session; the project lives in org-host.
const ctx: Ctx = {
	user: { id: "user-1", name: "Example Member", email: "dev@example.com" },
	session: { id: "sess-1", activeOrganizationId: "org-session" },
};

/** Run the procedure as oRPC would: its middlewares in order, then the handler. */
async function call(
	name: keyof typeof procedures,
	input: Record<string, unknown>,
): Promise<Record<string, unknown>> {
	const procedure = procedures[name];
	const parsed = procedure.inputSchema.safeParse(input);
	if (!parsed.success) {
		throw Object.assign(new Error("input validation failed"), {
			code: "BAD_REQUEST",
		});
	}
	const run = async (
		index: number,
		context: Ctx,
	): Promise<{ output: unknown; context: object }> => {
		const middleware = procedure.middlewares[index];
		if (!middleware) {
			return {
				output: await procedure.handler({
					input: parsed.data,
					context,
				}),
				context: {},
			};
		}
		return (await middleware(
			{
				context,
				next: (options) =>
					run(
						index + 1,
						options?.context
							? { ...context, ...options.context }
							: context,
					),
			},
			parsed.data,
		)) as { output: unknown; context: object };
	};
	return (await run(0, { ...ctx })).output as Record<string, unknown>;
}

const VIEWER = ["context:read"];
const EDITOR = ["context:read", "context:create"];
const ADMIN = [...EDITOR, "project:settings:edit"];

function grant(permissions: string[], extra: Record<string, unknown> = {}) {
	m.resolveEffectiveProjectPermissions.mockResolvedValue({
		permissions,
		source: "project-member",
		organizationId: "org-host",
		...extra,
	});
}

/** The sync and its neighbours, as the transaction reads them under the lock. */
const sync = {
	id: "sync-1",
	userId: "user-delegate",
	repositoryIntegrationId: "int-1",
	ref: "main",
	paths: ["docs", "notes/team.md"],
	excludedPaths: ["docs/drafts"],
};
let siblings: Array<{ id: string; folder: string }> = [];
let instructionRoots: string[] = [];
let stored = storedTarget();

function storedTarget(overrides: Record<string, unknown> = {}) {
	return {
		id: "target-1",
		syncId: "sync-1",
		projectId: "proj-1",
		organizationId: "org-host",
		userId: "user-earlier",
		folder: "docs/memory",
		mode: "PULL_REQUEST",
		directPushEnabledById: null,
		directPushEnabledAt: null,
		version: 1,
		createdAt: new Date("2026-10-15T00:00:00.000Z"),
		updatedAt: new Date("2026-10-15T00:00:00.000Z"),
		...overrides,
	};
}

type Decide = (
	state: unknown,
	current?: unknown,
) =>
	| { accept: true; folder: string; mode: string }
	| { accept: false; refusal: unknown };

beforeEach(() => {
	vi.clearAllMocks();
	siblings = [];
	instructionRoots = [];
	stored = storedTarget();
	m.hasProjectAccess.mockResolvedValue(true);
	grant(EDITOR);
	m.createContextWriteTarget.mockImplementation(
		async (input: { userId: string }, decide: Decide) => {
			const decision = decide({ sync, siblings, instructionRoots });
			if (!decision.accept) {
				return { status: "refused", refusal: decision.refusal };
			}
			return {
				status: "created",
				target: storedTarget({
					folder: decision.folder,
					mode: decision.mode,
					userId: input.userId,
				}),
			};
		},
	);
	m.updateContextWriteTarget.mockImplementation(
		async (input: { userId: string }, decide: Decide) => {
			const decision = decide(
				{ sync, siblings, instructionRoots },
				stored,
			);
			if (!decision.accept) {
				return { status: "refused", refusal: decision.refusal };
			}
			return {
				status: "updated",
				target: storedTarget({
					folder: decision.folder,
					mode: decision.mode,
					userId: input.userId,
					version: stored.version + 1,
				}),
				previous: { folder: stored.folder, mode: stored.mode },
			};
		},
	);
	m.deleteContextWriteTarget.mockResolvedValue({
		status: "deleted",
		target: storedTarget({ mode: "DIRECT_PUSH" }),
	});
	m.listContextWriteTargets.mockResolvedValue([storedTarget()]);
});

const NO_WRITES = () => {
	expect(m.createContextWriteTarget).not.toHaveBeenCalled();
	expect(m.updateContextWriteTarget).not.toHaveBeenCalled();
	expect(m.deleteContextWriteTarget).not.toHaveBeenCalled();
	expect(m.recordAuditFromRequest).not.toHaveBeenCalled();
};

const createInput = { projectId: "proj-1", folder: "docs/memory" };
const updateInput = { projectId: "proj-1", targetId: "target-1" };
const deleteInput = { projectId: "proj-1", targetId: "target-1" };

// =============================================================================
// Authorization
// =============================================================================

describe("authorization", () => {
	it.each([
		["create", createInput],
		["update", { ...updateInput, mode: "PULL_REQUEST" }],
		["delete", deleteInput],
	] as const)(
		"refuses %s to a member without CONTEXT_CREATE",
		async (name, input) => {
			grant(VIEWER);

			await expect(call(name, input)).rejects.toMatchObject({
				code: "FORBIDDEN",
			});

			NO_WRITES();
		},
	);

	it("lets a read-only member list the folders, and says they cannot enable direct push", async () => {
		grant(VIEWER);

		const listed = await call("list", { projectId: "proj-1" });

		expect(listed).toMatchObject({
			canConfigure: false,
			canEnableDirectPush: false,
			maxTargets: 10,
			targets: [
				{ id: "target-1", folder: "docs/memory", mode: "PULL_REQUEST" },
			],
		});
	});

	it("tells an administrator they can enable direct push", async () => {
		grant(ADMIN);

		await expect(
			call("list", { projectId: "proj-1" }),
		).resolves.toMatchObject({
			canConfigure: true,
			canEnableDirectPush: true,
		});
	});

	it("answers NOT_FOUND to a project the caller cannot discover, before any permission", async () => {
		m.hasProjectAccess.mockResolvedValue(false);

		await expect(call("create", createInput)).rejects.toMatchObject({
			code: "NOT_FOUND",
		});

		expect(m.resolveEffectiveProjectPermissions).not.toHaveBeenCalled();
		NO_WRITES();
	});

	it("refuses a personal project", async () => {
		grant(ADMIN, { organizationId: null });

		await expect(call("create", createInput)).rejects.toMatchObject({
			code: "FORBIDDEN",
		});

		NO_WRITES();
	});

	it("acts in the project's host organization, never the session's", async () => {
		await call("create", createInput);

		expect(m.createContextWriteTarget).toHaveBeenCalledWith(
			{
				projectId: "proj-1",
				organizationId: "org-host",
				userId: "user-1",
			},
			expect.any(Function),
		);
		expect(m.recordAuditFromRequest).toHaveBeenCalledWith(
			expect.anything(),
			expect.objectContaining({ organizationId: "org-host" }),
		);
	});
});

// =============================================================================
// create
// =============================================================================

describe("create", () => {
	it("adds a PULL_REQUEST folder by default, and audits it with its folder and mode", async () => {
		const created = await call("create", createInput);

		expect(created).toMatchObject({
			id: "target-1",
			folder: "docs/memory",
			mode: "PULL_REQUEST",
			version: 1,
			updatedById: "user-1",
		});
		expect(m.recordAuditFromRequest).toHaveBeenCalledWith(
			expect.anything(),
			{
				action: "project.context.write_target_created",
				category: "project",
				organizationId: "org-host",
				projectId: "proj-1",
				resource: {
					type: "project_context_write_target",
					id: "target-1",
					name: "docs/memory",
				},
				metadata: { folder: "docs/memory", mode: "PULL_REQUEST" },
			},
		);
	});

	it("refuses DIRECT_PUSH without PROJECT_SETTINGS_EDIT, writes nothing and audits nothing", async () => {
		grant(EDITOR);

		await expect(
			call("create", { ...createInput, mode: "DIRECT_PUSH" }),
		).rejects.toMatchObject({
			code: "FORBIDDEN",
			data: { code: "DIRECT_PUSH_REQUIRES_ADMIN" },
		});

		expect(m.recordAuditFromRequest).not.toHaveBeenCalled();
	});

	it("allows DIRECT_PUSH with PROJECT_SETTINGS_EDIT and audits the mode", async () => {
		grant(ADMIN);

		const created = await call("create", {
			...createInput,
			mode: "DIRECT_PUSH",
		});

		expect(created).toMatchObject({ mode: "DIRECT_PUSH" });
		expect(m.recordAuditFromRequest).toHaveBeenCalledWith(
			expect.anything(),
			expect.objectContaining({
				action: "project.context.write_target_created",
				metadata: { folder: "docs/memory", mode: "DIRECT_PUSH" },
			}),
		);
	});

	it("checks the right to enable direct push before it judges the folder", async () => {
		grant(EDITOR);

		await expect(
			call("create", {
				projectId: "proj-1",
				folder: "other",
				mode: "DIRECT_PUSH",
			}),
		).rejects.toMatchObject({
			data: { code: "DIRECT_PUSH_REQUIRES_ADMIN" },
		});
	});

	it("takes a folder anywhere inside a whole-repository selection, and only there", async () => {
		await expect(
			call("create", { projectId: "proj-1", folder: "docs/ai" }),
		).resolves.toMatchObject({ folder: "docs/ai" });
		await expect(
			call("create", { projectId: "proj-1", folder: "memory" }),
		).rejects.toMatchObject({ data: { code: "TARGET_OUTSIDE_SELECTION" } });
		sync.paths = [""];
		try {
			await expect(
				call("create", { projectId: "proj-1", folder: "docs/ai" }),
			).resolves.toMatchObject({ folder: "docs/ai" });
			await expect(
				call("create", { projectId: "proj-1", folder: "memory" }),
			).resolves.toMatchObject({ folder: "memory" });
		} finally {
			sync.paths = ["docs", "notes/team.md"];
		}
	});

	it("refuses the repository root and CI or tool folders even under a whole-repository selection", async () => {
		sync.paths = [""];
		try {
			for (const folder of ["", ".github", "docs/.private/x"]) {
				await expect(
					call("create", { projectId: "proj-1", folder }),
				).rejects.toMatchObject({
					code: "BAD_REQUEST",
					data: { code: "TARGET_RESERVED", path: folder },
				});
			}
		} finally {
			sync.paths = ["docs", "notes/team.md"];
		}
		expect(m.recordAuditFromRequest).not.toHaveBeenCalled();
	});

	it("refuses a reserved folder for direct push too, once the right to enable it is held", async () => {
		grant(ADMIN);
		sync.paths = [""];
		try {
			await expect(
				call("create", {
					projectId: "proj-1",
					folder: ".github",
					mode: "DIRECT_PUSH",
				}),
			).rejects.toMatchObject({ data: { code: "TARGET_RESERVED" } });
		} finally {
			sync.paths = ["docs", "notes/team.md"];
		}
	});

	it.each([
		["INVALID_PATH", { folder: "docs/" }, {}],
		["TARGET_RESERVED", { folder: "" }, {}],
		["TARGET_RESERVED", { folder: ".github" }, {}],
		["TARGET_RESERVED", { folder: "docs/.private/x" }, {}],
		["TARGET_OUTSIDE_SELECTION", { folder: "elsewhere" }, {}],
		["TARGET_EXCLUDED", { folder: "docs/drafts" }, {}],
		["TARGET_EXCLUDED", { folder: "docs/skills" }, {}],
	])(
		"refuses with %s as BAD_REQUEST carrying the code and the path",
		async (code, input) => {
			await expect(
				call("create", { projectId: "proj-1", ...input }),
			).rejects.toMatchObject({
				code: "BAD_REQUEST",
				data: { code, path: input.folder },
			});

			expect(m.recordAuditFromRequest).not.toHaveBeenCalled();
		},
	);

	it("refuses an overlap with another folder, naming it", async () => {
		siblings = [{ id: "t-2", folder: "docs/memory" }];

		await expect(call("create", createInput)).rejects.toMatchObject({
			code: "BAD_REQUEST",
			data: {
				code: "TARGET_OVERLAP",
				path: "docs/memory",
				withPath: "docs/memory",
			},
		});
	});

	it("refuses a folder that overlaps the coding instructions, naming the root", async () => {
		instructionRoots = ["docs/coding"];

		await expect(
			call("create", { projectId: "proj-1", folder: "docs/coding/x" }),
		).rejects.toMatchObject({
			code: "BAD_REQUEST",
			data: {
				code: "TARGET_OVERLAPS_INSTRUCTIONS",
				path: "docs/coding/x",
				withPath: "docs/coding",
			},
		});
	});

	it("refuses an eleventh folder", async () => {
		siblings = Array.from({ length: 10 }, (_, i) => ({
			id: `t-${i}`,
			folder: `docs/t${i}`,
		}));

		await expect(call("create", createInput)).rejects.toMatchObject({
			code: "BAD_REQUEST",
			data: { code: "TOO_MANY_TARGETS" },
		});
	});

	it("says so when the project has no sync", async () => {
		m.createContextWriteTarget.mockResolvedValue({
			status: "not-configured",
		});

		await expect(call("create", createInput)).rejects.toMatchObject({
			code: "BAD_REQUEST",
			data: { code: "NOT_CONFIGURED" },
		});
		expect(m.recordAuditFromRequest).not.toHaveBeenCalled();
	});

	it("takes no organization from the request", () => {
		const parsed = procedures.create.inputSchema.safeParse({
			...createInput,
			organizationId: "org-other",
		});

		expect(parsed.success).toBe(true);
		expect(parsed.data).not.toHaveProperty("organizationId");
	});
});

// =============================================================================
// update
// =============================================================================

describe("update", () => {
	it("switches to PULL_REQUEST with only CONTEXT_CREATE, even from DIRECT_PUSH", async () => {
		stored = storedTarget({
			mode: "DIRECT_PUSH",
			directPushEnabledById: "user-admin",
		});
		grant(EDITOR);

		const updated = await call("update", {
			...updateInput,
			mode: "PULL_REQUEST",
		});

		expect(updated).toMatchObject({ mode: "PULL_REQUEST", version: 2 });
		expect(m.recordAuditFromRequest).toHaveBeenCalledWith(
			expect.anything(),
			expect.objectContaining({
				action: "project.context.write_target_updated",
				resource: expect.objectContaining({ id: "target-1" }),
				metadata: {
					folder: "docs/memory",
					mode: "PULL_REQUEST",
					previousFolder: "docs/memory",
					previousMode: "DIRECT_PUSH",
					version: 2,
				},
			}),
		);
	});

	it("refuses a move into DIRECT_PUSH without PROJECT_SETTINGS_EDIT", async () => {
		grant(EDITOR);

		await expect(
			call("update", { ...updateInput, mode: "DIRECT_PUSH" }),
		).rejects.toMatchObject({
			code: "FORBIDDEN",
			data: { code: "DIRECT_PUSH_REQUIRES_ADMIN" },
		});

		expect(m.recordAuditFromRequest).not.toHaveBeenCalled();
	});

	it("allows a move into DIRECT_PUSH with PROJECT_SETTINGS_EDIT", async () => {
		grant(ADMIN);

		await expect(
			call("update", { ...updateInput, mode: "DIRECT_PUSH" }),
		).resolves.toMatchObject({ mode: "DIRECT_PUSH", version: 2 });
	});

	it("refuses to re-point a DIRECT_PUSH folder without PROJECT_SETTINGS_EDIT", async () => {
		stored = storedTarget({ mode: "DIRECT_PUSH" });
		grant(EDITOR);

		await expect(
			call("update", { ...updateInput, folder: "docs/elsewhere" }),
		).rejects.toMatchObject({
			data: { code: "DIRECT_PUSH_REQUIRES_ADMIN" },
		});
	});

	it("lets an editor re-point a PULL_REQUEST folder, and judges the new folder", async () => {
		await expect(
			call("update", { ...updateInput, folder: "docs/elsewhere" }),
		).resolves.toMatchObject({
			folder: "docs/elsewhere",
			mode: "PULL_REQUEST",
		});
		await expect(
			call("update", { ...updateInput, folder: "docs/drafts" }),
		).rejects.toMatchObject({ data: { code: "TARGET_EXCLUDED" } });
		await expect(
			call("update", { ...updateInput, folder: "docs/.private" }),
		).rejects.toMatchObject({ data: { code: "TARGET_RESERVED" } });
	});

	it("lets a reserved folder from before the rule be made PULL_REQUEST, but never DIRECT_PUSH", async () => {
		stored = storedTarget({ folder: ".github", mode: "DIRECT_PUSH" });
		grant(ADMIN);

		await expect(
			call("update", { ...updateInput, mode: "PULL_REQUEST" }),
		).resolves.toMatchObject({ mode: "PULL_REQUEST", folder: ".github" });

		stored = storedTarget({ folder: ".github", mode: "PULL_REQUEST" });
		await expect(
			call("update", { ...updateInput, mode: "DIRECT_PUSH" }),
		).rejects.toMatchObject({ data: { code: "TARGET_RESERVED" } });
	});

	it("does not overlap the folder it replaces, only the others", async () => {
		siblings = [{ id: "t-2", folder: "docs/other" }];

		await expect(
			call("update", { ...updateInput, folder: "docs/memory/sub" }),
		).resolves.toMatchObject({ folder: "docs/memory/sub" });
		await expect(
			call("update", { ...updateInput, folder: "docs/other/sub" }),
		).rejects.toMatchObject({
			data: { code: "TARGET_OVERLAP", withPath: "docs/other" },
		});
	});

	it("lets a folder the sync has since left out be made PULL_REQUEST, but never DIRECT_PUSH", async () => {
		stored = storedTarget({ folder: "gone/away", mode: "DIRECT_PUSH" });
		grant(ADMIN);

		await expect(
			call("update", { ...updateInput, mode: "PULL_REQUEST" }),
		).resolves.toMatchObject({ mode: "PULL_REQUEST", folder: "gone/away" });

		stored = storedTarget({ folder: "gone/away", mode: "PULL_REQUEST" });
		await expect(
			call("update", { ...updateInput, mode: "DIRECT_PUSH" }),
		).rejects.toMatchObject({ data: { code: "TARGET_OUTSIDE_SELECTION" } });
	});

	it("refuses an update that changes nothing, before it touches the database", async () => {
		await expect(call("update", updateInput)).rejects.toMatchObject({
			code: "BAD_REQUEST",
			data: { code: "NOTHING_TO_UPDATE" },
		});

		NO_WRITES();
	});

	it("answers NOT_FOUND for a target that is not the project's", async () => {
		m.updateContextWriteTarget.mockResolvedValue({ status: "not-found" });

		await expect(
			call("update", { ...updateInput, mode: "PULL_REQUEST" }),
		).rejects.toMatchObject({ code: "NOT_FOUND" });
		expect(m.recordAuditFromRequest).not.toHaveBeenCalled();
	});

	it("says so when the project has no sync", async () => {
		m.updateContextWriteTarget.mockResolvedValue({
			status: "not-configured",
		});

		await expect(
			call("update", { ...updateInput, mode: "PULL_REQUEST" }),
		).rejects.toMatchObject({ data: { code: "NOT_CONFIGURED" } });
	});
});

// =============================================================================
// delete
// =============================================================================

describe("delete", () => {
	it("removes a folder with only CONTEXT_CREATE, even a DIRECT_PUSH one, and audits it", async () => {
		grant(EDITOR);

		await expect(call("delete", deleteInput)).resolves.toEqual({
			deleted: true,
		});

		expect(m.deleteContextWriteTarget).toHaveBeenCalledWith({
			projectId: "proj-1",
			organizationId: "org-host",
			targetId: "target-1",
		});
		expect(m.recordAuditFromRequest).toHaveBeenCalledWith(
			expect.anything(),
			expect.objectContaining({
				action: "project.context.write_target_deleted",
				metadata: { folder: "docs/memory", mode: "DIRECT_PUSH" },
			}),
		);
	});

	it("answers NOT_FOUND for a target that is not the project's, and audits nothing", async () => {
		m.deleteContextWriteTarget.mockResolvedValue({ status: "not-found" });

		await expect(call("delete", deleteInput)).rejects.toMatchObject({
			code: "NOT_FOUND",
		});
		expect(m.recordAuditFromRequest).not.toHaveBeenCalled();
	});

	it("says so when the project has no sync", async () => {
		m.deleteContextWriteTarget.mockResolvedValue({
			status: "not-configured",
		});

		await expect(call("delete", deleteInput)).rejects.toMatchObject({
			data: { code: "NOT_CONFIGURED" },
		});
	});
});

// =============================================================================
// validate
// =============================================================================

describe("validate", () => {
	const admission = {
		readOnlyMode: false,
		sync: { ...sync, automatic: true, automaticPausedReason: null },
		target: {
			id: "target-1",
			version: 4,
			folder: "docs/memory",
			mode: "PULL_REQUEST",
		},
		instructionRoots: [],
		managedCount: 3,
		managedKeys: [],
	};
	const validInput = {
		projectId: "proj-1",
		targetId: "target-1",
		message: "Add a note",
		entries: [{ path: "docs/memory/a.md", op: "PUT", content: "# A\n" }],
	};

	beforeEach(() => {
		m.getMemoryWriteAdmissionState.mockResolvedValue({ ...admission });
	});

	it("answers ok with the target and a digest, for the project's host organization", async () => {
		const result = await call("validate", validInput);

		expect(result).toMatchObject({
			ok: true,
			problems: [],
			target: {
				id: "target-1",
				version: 4,
				folder: "docs/memory",
				mode: "PULL_REQUEST",
				ref: "main",
			},
		});
		expect(result.digest).toMatch(/^[0-9a-f]{64}$/);
		expect(m.getMemoryWriteAdmissionState).toHaveBeenCalledWith({
			projectId: "proj-1",
			organizationId: "org-host",
			targetId: "target-1",
			putPaths: ["docs/memory/a.md"],
		});
	});

	it("persists nothing and audits nothing", async () => {
		await call("validate", validInput);

		NO_WRITES();
	});

	it("reports every problem together", async () => {
		const result = await call("validate", {
			...validInput,
			entries: [
				{ path: "docs/other/a.md", op: "PUT", content: "# A\n" },
				{ path: "docs/memory/b.png", op: "PUT", content: "x" },
				{ path: "docs/memory/c.md", op: "DELETE" },
			],
		});

		expect(result.ok).toBe(false);
		expect(
			(result.problems as Array<{ code: string }>)
				.map((p) => p.code)
				.sort(),
		).toEqual([
			"DELETE_REQUIRES_IF_MATCH",
			"PATH_OUTSIDE_TARGET",
			"UNSUPPORTED_EXTENSION",
		]);
	});

	it("checks that the member automatic runs act as can still create", async () => {
		m.resolveEffectiveProjectPermissions.mockImplementation(
			async (_projectId: string, userId: string) => ({
				permissions: userId === "user-delegate" ? VIEWER : EDITOR,
				source: "project-member",
				organizationId: "org-host",
			}),
		);

		const result = await call("validate", validInput);

		expect(result.problems).toContainEqual({
			code: "SYNC_DELEGATE_LOST_PERMISSION",
		});
		expect(m.resolveEffectiveProjectPermissions).toHaveBeenCalledWith(
			"proj-1",
			"user-delegate",
		);
	});

	it("reports a project in read-only mode", async () => {
		m.getMemoryWriteAdmissionState.mockResolvedValue({
			...admission,
			readOnlyMode: true,
		});

		const result = await call("validate", validInput);

		expect(result.problems).toContainEqual({ code: "READ_ONLY_MODE" });
	});

	it("never echoes a secret it found", async () => {
		const token = `ghp_${"A1".repeat(18)}`;

		const result = await call("validate", {
			...validInput,
			entries: [
				{ path: "docs/memory/a.md", op: "PUT", content: `k: ${token}` },
			],
		});

		expect(result.problems).toEqual([
			{
				path: "docs/memory/a.md",
				code: "SECRET_DETECTED",
				detail: "github-token",
			},
		]);
		expect(JSON.stringify(result)).not.toContain(token);
	});

	it("answers NOT_FOUND when the project is not in the resolved organization", async () => {
		m.getMemoryWriteAdmissionState.mockResolvedValue(null);

		await expect(call("validate", validInput)).rejects.toMatchObject({
			code: "NOT_FOUND",
		});
	});

	it.each([
		["no entries", { entries: [] }],
		[
			"more than fifty entries",
			{
				entries: Array.from({ length: 51 }, (_, i) => ({
					path: `docs/memory/${i}.md`,
					op: "PUT",
					content: "x",
				})),
			},
		],
		["an empty message", { message: "" }],
		["a message over 5000 characters", { message: "m".repeat(5001) }],
		[
			"an unknown operation",
			{ entries: [{ path: "docs/memory/a.md", op: "MOVE" }] },
		],
	])("rejects %s as invalid input", (_name, change) => {
		expect(
			procedures.validate.inputSchema.safeParse({
				...validInput,
				...change,
			}).success,
		).toBe(false);
	});

	it("accepts fifty entries and a message at its bound", () => {
		expect(
			procedures.validate.inputSchema.safeParse({
				...validInput,
				message: "m".repeat(5000),
				entries: Array.from({ length: 50 }, (_, i) => ({
					path: `docs/memory/${i}.md`,
					op: "PUT",
					content: "x",
				})),
			}).success,
		).toBe(true);
	});
});
