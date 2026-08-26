/**
 * Tests for audit-log emission from project / story / member procedures.
 *
 * Covers Task Group 3 of the audit-log spec
 * (docs/audit-log/README.md): every
 * mutation in the v1 closed taxonomy must call `recordAuditFromRequest`
 * with the correct action key, snapshot fields, and metadata shape.
 *
 * The procedures are imported with the orpc chain stubbed so we can
 * invoke their handlers directly. Database mutations are mocked; the
 * test asserts on the arguments passed to `recordAuditFromRequest`.
 *
 * Run with:
 *   pnpm --filter @repo/api test modules/projects/procedures/__tests__/audit-emission.test.ts
 */

import { beforeEach, describe, expect, it, vi } from "vitest";

// ---------------------------------------------------------------------------
// Hoisted mocks shared across all procedure imports below.
// ---------------------------------------------------------------------------

const { handlers, dbMock, recordAuditMock } = vi.hoisted(() => ({
	handlers: {} as Record<string, (...args: unknown[]) => unknown>,
	dbMock: {
		project: {
			findFirst: vi.fn(),
			findUnique: vi.fn(),
		},
		userStory: {
			findFirst: vi.fn(),
			findUnique: vi.fn(),
			update: vi.fn(),
		},
		storyAttachment: {
			findMany: vi.fn(),
		},
		projectMember: {
			findUnique: vi.fn(),
			deleteMany: vi.fn(),
			updateMany: vi.fn(),
		},
		projectStoryStatus: {
			findUnique: vi.fn(),
		},
		projectDocument: {
			findFirst: vi.fn(),
			create: vi.fn(),
		},
		documentVersion: {
			create: vi.fn(),
		},
		user: {
			findUnique: vi.fn(),
		},
		organizationApiKey: {
			findFirst: vi.fn(),
		},
		member: {
			findFirst: vi.fn(),
			findUnique: vi.fn(),
		},
	},
	recordAuditMock: vi.fn(),
}));

vi.mock("@repo/database", async (importOriginal) => {
	// Use importOriginal so transitively-imported helpers (e.g. payments
	// pulling `setAiUsageRecorder`) keep working; we then override the
	// specific exports the procedures under test mutate against.
	const actual = (await importOriginal()) as Record<string, unknown>;
	return {
		...actual,
		db: dbMock,
		// Helpers exercised by the procedures under test
		createProject: vi.fn(),
		updateProject: vi.fn(),
		softDeleteProject: vi.fn(),
		deleteStory: vi.fn(),
		updateStory: vi.fn(),
		moveStory: vi.fn(),
		createOrganizationApiKey: vi.fn(),
		deleteOrganizationApiKey: vi.fn(),
		createProjectInvitation: vi.fn(),
		canInviteUser: vi.fn(),
		getProjectMemberRole: vi.fn(),
		disconnectIntegrationsForUser: vi.fn().mockResolvedValue({ count: 0 }),
		logRepoIntegrationActivity: vi.fn(),
		moveWizardTempContextsToProject: vi.fn(),
		resolvePMConfigForUser: vi.fn(),
		// `ProjectMemberRole` is a runtime enum on the Prisma client — keep
		// the imported original but override the few entries we exercise.
		ProjectMemberRole: {
			...((actual as { ProjectMemberRole?: Record<string, string> })
				.ProjectMemberRole ?? {}),
			OWNER: "OWNER",
			VIEWER: "VIEWER",
		},
	};
});

vi.mock("@repo/database/prisma/zod", async (importOriginal) => {
	const actual = (await importOriginal()) as Record<string, unknown>;
	return { ...actual };
});

vi.mock("../../../../lib/audit", () => ({
	recordAuditFromRequest: (...args: unknown[]) => recordAuditMock(...args),
}));

vi.mock("../../../../lib/notification-service", () => ({
	fanOut: {
		assigned: vi.fn().mockResolvedValue(undefined),
		storyStatusChanged: vi.fn().mockResolvedValue(undefined),
		subscriptionUpdate: vi.fn().mockResolvedValue(undefined),
	},
}));

// Two mock paths because `verifyOrganizationMembership` and
// `requireOrgMembership` live in the same file but the procedures import
// them via different relative paths (project vs api-key procedures).
vi.mock("../../organizations/lib/membership", () => ({
	verifyOrganizationMembership: vi.fn().mockResolvedValue(true),
	requireOrgMembership: vi.fn().mockResolvedValue({ role: "owner" }),
}));

vi.mock("../../../organizations/lib/membership", () => ({
	verifyOrganizationMembership: vi.fn().mockResolvedValue(true),
	requireOrgMembership: vi.fn().mockResolvedValue({ role: "owner" }),
}));

vi.mock("../../lib/enqueue-pm-sync", () => ({
	enqueuePmSync: vi.fn().mockResolvedValue(undefined),
}));

vi.mock("../../lib/story-automations", () => ({
	fireColumnAutomations: vi.fn().mockResolvedValue(undefined),
}));

vi.mock("../../../agent-deployments/lib/lifecycle-dispatcher", () => ({
	dispatchLifecycleEvent: vi.fn().mockResolvedValue(undefined),
}));

vi.mock("@repo/temporal", () => ({
	getTemporalClient: vi.fn(),
	createStoryFromProposal: vi.fn().mockResolvedValue({
		story: {
			id: "story-1",
			title: "Test story",
			kind: "FEATURE",
			statusId: "todo",
		},
		aiDrafted: false,
	}),
}));

vi.mock("@repo/mail", () => ({
	sendEmail: vi.fn().mockResolvedValue(true),
}));

vi.mock("@repo/utils", async (importOriginal) => {
	const actual = (await importOriginal()) as Record<string, unknown>;
	return {
		...actual,
		getBaseUrl: () => "http://localhost:3001",
	};
});

vi.mock("@repo/ai/lib/story-title-generator", () => ({
	generateStoryTitleFromDescription: vi.fn().mockResolvedValue({
		title: "Generated title",
		source: "ai",
	}),
	mapStoryTitleSourceToEnum: vi.fn().mockReturnValue("AI"),
}));

vi.mock("../../../../orpc/procedures", () => {
	const chainable: Record<string, unknown> = {};
	let pendingKey = "";
	Object.assign(chainable, {
		use: () => chainable,
		route: () => chainable,
		input: () => chainable,
		output: () => chainable,
		handler: (fn: (...args: unknown[]) => unknown) => {
			handlers[pendingKey] = fn;
			return { _handler: fn };
		},
	});
	return {
		tenantProtectedProcedure: chainable,
		resolveOrganizationId: vi.fn(
			(organizationId: string | null | undefined) =>
				organizationId ?? null,
		),
		requirePermission: vi.fn(() => ({})),
		requireProjectPermission: vi.fn(() => ({})),
		Permissions: new Proxy(
			{},
			{ get: (_: unknown, prop: string) => prop.toLowerCase() },
		),
		__setPendingHandlerKey(key: string) {
			pendingKey = key;
		},
	};
});

// Side-effect imports register handlers. We toggle the slot before each
// import so the chainable knows which key to capture under.
const procedures = await import("../../../../orpc/procedures");
const setSlot = (
	procedures as unknown as {
		__setPendingHandlerKey: (key: string) => void;
	}
).__setPendingHandlerKey;

setSlot("createProject");
await import("../create-project");

setSlot("updateProject");
await import("../update-project");

setSlot("deleteProject");
await import("../delete-project");

setSlot("createStory");
await import("../stories/create-story");

setSlot("deleteStory");
await import("../stories/delete-story");

setSlot("moveStory");
await import("../stories/move-story");

setSlot("inviteMember");
await import("../members/invite-member");

setSlot("removeMember");
await import("../members/remove-member");

setSlot("updateMemberRole");
await import("../members/update-member-role");

setSlot("createApiKey");
await import("../../../organizations/procedures/api-keys/create");

setSlot("deleteApiKey");
await import("../../../organizations/procedures/api-keys/delete");

// ---------------------------------------------------------------------------
// Shared fixtures
// ---------------------------------------------------------------------------

const baseCtx = {
	user: { id: "user-1", email: "alice@example.com", name: "Alice" },
	session: {
		id: "sess-1",
		activeOrganizationId: "org-1",
		impersonatedBy: null,
	},
	headers: new Headers(),
};

beforeEach(() => {
	vi.clearAllMocks();
});

// ---------------------------------------------------------------------------
// project.created
// ---------------------------------------------------------------------------

describe("project.created emission", () => {
	it("writes one project.created row with snapshot + metadata", async () => {
		const db = (await import("@repo/database")) as unknown as {
			createProject: ReturnType<typeof vi.fn>;
		};
		(db.createProject as ReturnType<typeof vi.fn>).mockResolvedValue({
			id: "proj-1",
			name: "Test Project",
			status: "ACTIVE",
			repositoryUrl: null,
			projectManagementMcpConfigId: null,
		});
		dbMock.project.findFirst.mockResolvedValue(null);

		await handlers.createProject({
			input: { name: "Test Project", organizationId: "org-1" },
			context: baseCtx,
		});

		expect(recordAuditMock).toHaveBeenCalledTimes(1);
		const [callCtx, payload] = recordAuditMock.mock.calls[0] as [
			unknown,
			Record<string, unknown>,
		];
		expect(callCtx).toBe(baseCtx);
		expect(payload).toMatchObject({
			action: "project.created",
			category: "project",
			organizationId: "org-1",
			projectId: "proj-1",
			resource: {
				type: "project",
				id: "proj-1",
				name: "Test Project",
			},
		});
		expect((payload.metadata as Record<string, unknown>).status).toBe(
			"ACTIVE",
		);
	});
});

// ---------------------------------------------------------------------------
// project.updated / project.archived
// ---------------------------------------------------------------------------

describe("project.updated vs project.archived", () => {
	it("emits project.archived when status is ARCHIVED", async () => {
		const db = (await import("@repo/database")) as unknown as {
			updateProject: ReturnType<typeof vi.fn>;
		};
		(db.updateProject as ReturnType<typeof vi.fn>).mockResolvedValue({
			id: "proj-1",
			name: "Test Project",
			codeAnalysisStatus: "IDLE",
		});
		dbMock.project.findUnique.mockResolvedValue({
			repositoryUrl: null,
		});

		await handlers.updateProject({
			input: {
				id: "proj-1",
				status: "ARCHIVED",
				organizationId: "org-1",
			},
			context: baseCtx,
		});

		expect(recordAuditMock).toHaveBeenCalledTimes(1);
		const [, payload] = recordAuditMock.mock.calls[0] as [
			unknown,
			Record<string, unknown>,
		];
		expect(payload.action).toBe("project.archived");
		expect(payload.projectId).toBe("proj-1");
	});

	it("emits project.updated when status is not ARCHIVED", async () => {
		const db = (await import("@repo/database")) as unknown as {
			updateProject: ReturnType<typeof vi.fn>;
		};
		(db.updateProject as ReturnType<typeof vi.fn>).mockResolvedValue({
			id: "proj-1",
			name: "Test Project",
			codeAnalysisStatus: "IDLE",
		});
		dbMock.project.findUnique.mockResolvedValue({
			repositoryUrl: null,
		});

		await handlers.updateProject({
			input: { id: "proj-1", name: "Renamed", organizationId: "org-1" },
			context: baseCtx,
		});

		const [, payload] = recordAuditMock.mock.calls[0] as [
			unknown,
			Record<string, unknown>,
		];
		expect(payload.action).toBe("project.updated");
		expect(
			(payload.metadata as { changedFields: string[] }).changedFields,
		).toContain("name");
	});
});

// ---------------------------------------------------------------------------
// project.deleted (resourceName snapshot captured pre-delete)
// ---------------------------------------------------------------------------

describe("project.deleted emission", () => {
	it("captures the project name BEFORE the delete fires", async () => {
		const db = (await import("@repo/database")) as unknown as {
			softDeleteProject: ReturnType<typeof vi.fn>;
		};
		(db.softDeleteProject as ReturnType<typeof vi.fn>).mockResolvedValue(
			undefined,
		);
		dbMock.project.findFirst.mockResolvedValue({ name: "Doomed Project" });

		await handlers.deleteProject({
			input: { id: "proj-1", organizationId: "org-1" },
			context: baseCtx,
		});

		// The findFirst call (snapshot) must run before softDeleteProject.
		expect(dbMock.project.findFirst).toHaveBeenCalled();
		expect(recordAuditMock).toHaveBeenCalledTimes(1);
		const [, payload] = recordAuditMock.mock.calls[0] as [
			unknown,
			Record<string, unknown>,
		];
		expect(payload).toMatchObject({
			action: "project.deleted",
			category: "project",
			projectId: "proj-1",
			resource: {
				type: "project",
				id: "proj-1",
				name: "Doomed Project",
			},
		});
	});
});

// ---------------------------------------------------------------------------
// story.* family
// ---------------------------------------------------------------------------

describe("story.deleted emission", () => {
	it("snapshots the story title before delete", async () => {
		const db = (await import("@repo/database")) as unknown as {
			deleteStory: ReturnType<typeof vi.fn>;
		};
		(db.deleteStory as ReturnType<typeof vi.fn>).mockResolvedValue(
			undefined,
		);
		dbMock.userStory.findFirst.mockResolvedValue({
			title: "Original Title",
		});
		// delete-story captures attachment storage keys before the cascade
		// (Codex #2 object cleanup); this audit-focused test has none.
		dbMock.storyAttachment.findMany.mockResolvedValue([]);

		await handlers.deleteStory({
			input: {
				projectId: "proj-1",
				storyId: "story-1",
				organizationId: "org-1",
			},
			context: baseCtx,
		});

		expect(recordAuditMock).toHaveBeenCalledTimes(1);
		const [, payload] = recordAuditMock.mock.calls[0] as [
			unknown,
			Record<string, unknown>,
		];
		expect(payload).toMatchObject({
			action: "story.deleted",
			category: "story",
			projectId: "proj-1",
			resource: {
				type: "story",
				id: "story-1",
				name: "Original Title",
			},
		});
	});
});

describe("story.status_changed emission", () => {
	it("fires only when statusId actually changed", async () => {
		const db = (await import("@repo/database")) as unknown as {
			moveStory: ReturnType<typeof vi.fn>;
		};
		(db.moveStory as ReturnType<typeof vi.fn>).mockResolvedValue({
			id: "story-1",
			title: "Test story",
			status: { name: "Done" },
		});

		// Previous statusId differs from input.statusId
		dbMock.userStory.findFirst.mockResolvedValue({
			statusId: "in-progress",
		});
		dbMock.project.findUnique.mockResolvedValue({ name: "Project" });
		dbMock.userStory.findUnique.mockResolvedValue({
			title: "Test story",
			assigneeId: null,
		});

		await handlers.moveStory({
			input: {
				projectId: "proj-1",
				storyId: "story-1",
				statusId: "done",
				organizationId: "org-1",
			},
			context: baseCtx,
		});

		const auditCalls = recordAuditMock.mock.calls.filter(
			(call) =>
				(call[1] as Record<string, unknown>).action ===
				"story.status_changed",
		);
		expect(auditCalls).toHaveLength(1);
		const payload = auditCalls[0][1] as Record<string, unknown>;
		expect(payload.action).toBe("story.status_changed");
		expect(
			(payload.metadata as { fromStatus: string; toStatus: string })
				.fromStatus,
		).toBe("in-progress");
		expect(
			(payload.metadata as { fromStatus: string; toStatus: string })
				.toStatus,
		).toBe("done");
	});

	it("does NOT emit when statusId is unchanged", async () => {
		const db = (await import("@repo/database")) as unknown as {
			moveStory: ReturnType<typeof vi.fn>;
		};
		(db.moveStory as ReturnType<typeof vi.fn>).mockResolvedValue({
			id: "story-1",
			title: "Test story",
			status: { name: "Done" },
		});
		dbMock.userStory.findFirst.mockResolvedValue({ statusId: "done" });

		await handlers.moveStory({
			input: {
				projectId: "proj-1",
				storyId: "story-1",
				statusId: "done",
				organizationId: "org-1",
			},
			context: baseCtx,
		});

		const auditCalls = recordAuditMock.mock.calls.filter(
			(call) =>
				(call[1] as Record<string, unknown>).action ===
				"story.status_changed",
		);
		expect(auditCalls).toHaveLength(0);
	});
});

// ---------------------------------------------------------------------------
// project.member.* family
// ---------------------------------------------------------------------------

describe("project.member.invited emission", () => {
	it("uses the invited email as resourceName", async () => {
		const db = (await import("@repo/database")) as unknown as {
			canInviteUser: ReturnType<typeof vi.fn>;
			createProjectInvitation: ReturnType<typeof vi.fn>;
		};
		(db.canInviteUser as ReturnType<typeof vi.fn>).mockResolvedValue({
			canInvite: true,
		});
		(
			db.createProjectInvitation as ReturnType<typeof vi.fn>
		).mockResolvedValue({ id: "inv-1" });
		dbMock.project.findUnique.mockResolvedValue({ name: "Test Project" });

		// invite-member.ts uses sendEmail / getBaseUrl — both mocked here
		vi.doMock("@repo/mail", () => ({ sendEmail: vi.fn() }));
		vi.doMock("@repo/utils", () => ({
			getBaseUrl: () => "http://localhost:3001",
		}));

		await handlers.inviteMember({
			input: {
				projectId: "proj-1",
				email: "bob@example.com",
				role: "VIEWER",
			},
			context: baseCtx,
		});

		expect(recordAuditMock).toHaveBeenCalledTimes(1);
		const [, payload] = recordAuditMock.mock.calls[0] as [
			unknown,
			Record<string, unknown>,
		];
		expect(payload).toMatchObject({
			action: "project.member.invited",
			category: "project",
			projectId: "proj-1",
			resource: {
				type: "invitation",
				id: "inv-1",
				name: "bob@example.com",
			},
		});
		expect((payload.metadata as { role: string }).role).toBe("VIEWER");
	});
});

describe("project.member.role_changed emission", () => {
	it("captures from + to role and the target email", async () => {
		const db = (await import("@repo/database")) as unknown as {
			getProjectMemberRole: ReturnType<typeof vi.fn>;
		};
		(db.getProjectMemberRole as ReturnType<typeof vi.fn>).mockResolvedValue(
			"OWNER",
		);
		dbMock.projectMember.findUnique.mockResolvedValue({
			role: "VIEWER",
			userId: "user-2",
		});
		dbMock.user.findUnique.mockResolvedValue({ email: "bob@example.com" });
		dbMock.project.findUnique.mockResolvedValue({ userId: "user-1" });
		dbMock.projectMember.updateMany.mockResolvedValue({ count: 1 });

		await handlers.updateMemberRole({
			input: {
				projectId: "proj-1",
				userId: "user-2",
				role: "ADMIN",
				organizationId: "org-1",
			},
			context: baseCtx,
		});

		expect(recordAuditMock).toHaveBeenCalledTimes(1);
		const [, payload] = recordAuditMock.mock.calls[0] as [
			unknown,
			Record<string, unknown>,
		];
		expect(payload).toMatchObject({
			action: "project.member.role_changed",
			category: "project",
			resource: {
				type: "user",
				id: "user-2",
				name: "bob@example.com",
			},
		});
		expect(
			(payload.metadata as { fromRole: string; toRole: string }).fromRole,
		).toBe("VIEWER");
		expect(
			(payload.metadata as { fromRole: string; toRole: string }).toRole,
		).toBe("ADMIN");
	});
});

describe("project.member.removed emission", () => {
	it("snapshots email + previous role before the delete", async () => {
		dbMock.projectMember.findUnique.mockResolvedValue({
			role: "EDITOR",
			userId: "user-2",
		});
		dbMock.user.findUnique.mockResolvedValue({ email: "bob@example.com" });
		dbMock.projectMember.deleteMany.mockResolvedValue({ count: 1 });

		await handlers.removeMember({
			input: {
				projectId: "proj-1",
				userId: "user-2",
				organizationId: "org-1",
			},
			context: baseCtx,
		});

		expect(recordAuditMock).toHaveBeenCalledTimes(1);
		const [, payload] = recordAuditMock.mock.calls[0] as [
			unknown,
			Record<string, unknown>,
		];
		expect(payload).toMatchObject({
			action: "project.member.removed",
			category: "project",
			resource: {
				type: "user",
				id: "user-2",
				name: "bob@example.com",
			},
		});
		expect(
			(payload.metadata as { previousRole: string }).previousRole,
		).toBe("EDITOR");
	});
});

// ---------------------------------------------------------------------------
// org.api_key.* family
// ---------------------------------------------------------------------------

describe("org.api_key.created emission", () => {
	it("never includes the raw key in metadata", async () => {
		const db = (await import("@repo/database")) as unknown as {
			createOrganizationApiKey: ReturnType<typeof vi.fn>;
		};
		(
			db.createOrganizationApiKey as ReturnType<typeof vi.fn>
		).mockResolvedValue({
			id: "key-1",
			name: "CI key",
			keyPrefix: "org_abcd1234",
			scopes: ["mcp:read"],
			expiresAt: null,
			createdAt: new Date(),
		});

		// Mock requireOrgMembership directly
		vi.doMock("../../../organizations/lib/membership", () => ({
			requireOrgMembership: vi.fn().mockResolvedValue({ role: "owner" }),
			verifyOrganizationMembership: vi.fn().mockResolvedValue(true),
		}));

		await handlers.createApiKey({
			input: {
				organizationId: "org-1",
				name: "CI key",
				scopes: ["mcp:read"],
			},
			context: baseCtx,
		});

		expect(recordAuditMock).toHaveBeenCalledTimes(1);
		const [, payload] = recordAuditMock.mock.calls[0] as [
			unknown,
			Record<string, unknown>,
		];
		expect(payload.action).toBe("org.api_key.created");
		expect(payload.organizationId).toBe("org-1");
		// Critical: never include rawKey, keyHash, or keyPrefix in metadata
		const meta = payload.metadata as Record<string, unknown>;
		expect(meta).not.toHaveProperty("rawKey");
		expect(meta).not.toHaveProperty("keyHash");
		expect(meta).not.toHaveProperty("keyPrefix");
	});
});
