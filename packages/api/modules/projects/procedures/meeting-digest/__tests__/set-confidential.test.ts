import { beforeEach, describe, expect, it, vi } from "vitest";

const { captured, mocks } = vi.hoisted(() => ({
	captured: {
		handler: null as null | ((...args: never[]) => Promise<unknown>),
		permissions: [] as string[],
	},
	mocks: {
		findProject: vi.fn(),
		findFirst: vi.fn(),
		update: vi.fn(),
		recordAudit: vi.fn(),
		retireSummaries: vi.fn(),
	},
}));

vi.mock("@repo/database", () => ({
	db: {
		project: { findFirst: mocks.findProject },
		projectLinkedMeeting: {
			findFirst: mocks.findFirst,
			update: mocks.update,
		},
	},
	retireContextSummariesCoveringSeries: mocks.retireSummaries,
}));

vi.mock("../../../../../lib/audit", () => ({
	recordAuditFromRequest: mocks.recordAudit,
}));

vi.mock("../../../../../orpc/procedures", () => {
	const chainable: Record<string, unknown> = {};
	Object.assign(chainable, {
		use: () => chainable,
		route: () => chainable,
		input: () => chainable,
		handler: (handler: (...args: never[]) => Promise<unknown>) => {
			captured.handler = handler;
			return { _handler: handler };
		},
	});
	return {
		tenantProtectedProcedure: chainable,
		Permissions: { PROJECT_MEMBERS_MANAGE: "project:members:manage" },
		requireProjectPermission: (permission: string) => {
			captured.permissions.push(permission);
			return chainable;
		},
	};
});

await import("../set-confidential");

const context = {
	user: { id: "user-1", email: "dev@example.com", name: "Dev" },
	session: { activeOrganizationId: "org-1" },
};
const input = {
	projectId: "project-1",
	organizationId: "org-1",
	linkedMeetingId: "lm-1",
	confidential: true,
};

function run(overrides: Partial<typeof input> = {}) {
	const handler = captured.handler as unknown as (args: {
		input: typeof input;
		context: typeof context;
	}) => Promise<unknown>;
	return handler({ input: { ...input, ...overrides }, context });
}

beforeEach(() => {
	vi.clearAllMocks();
	mocks.findProject.mockResolvedValue({ organizationId: "org-1" });
	mocks.findFirst.mockResolvedValue({ id: "lm-1", subject: "Weekly sync" });
	mocks.update.mockImplementation(async ({ data }) => ({
		confidential: data.confidential,
	}));
});

describe("setConfidential", () => {
	it("needs the permission the series' other settings need", () => {
		expect(captured.permissions).toEqual(["project:members:manage"]);
	});

	it.each([true, false])(
		"stores confidential=%s on the series and returns it",
		async (confidential) => {
			await expect(run({ confidential })).resolves.toEqual({
				linkedMeetingId: "lm-1",
				confidential,
			});
			expect(mocks.update).toHaveBeenCalledWith({
				where: { id: "lm-1" },
				data: { confidential },
				select: { confidential: true },
			});
		},
	);

	it("looks the series up inside the project only", async () => {
		await run();

		expect(mocks.findFirst).toHaveBeenCalledWith(
			expect.objectContaining({
				where: { id: "lm-1", projectId: "project-1" },
			}),
		);
	});

	it("refuses a series of another project or organization as not found", async () => {
		mocks.findFirst.mockResolvedValue(null);

		await expect(
			run({ linkedMeetingId: "lm-other" }),
		).rejects.toMatchObject({ code: "NOT_FOUND" });
		expect(mocks.update).not.toHaveBeenCalled();
		expect(mocks.recordAudit).not.toHaveBeenCalled();
	});

	it("refuses a project with no organization as not found", async () => {
		mocks.findProject.mockResolvedValue({ organizationId: null });

		await expect(run()).rejects.toMatchObject({ code: "NOT_FOUND" });
		expect(mocks.findFirst).not.toHaveBeenCalled();
		expect(mocks.update).not.toHaveBeenCalled();
	});

	it("records the change against the project's organization, never the one the caller names", async () => {
		await run({ organizationId: "org-other", confidential: true });

		expect(mocks.recordAudit).toHaveBeenCalledWith(context, {
			action: "project.meeting_digest.confidentiality_changed",
			category: "project",
			organizationId: "org-1",
			projectId: "project-1",
			resource: {
				type: "linked_meeting",
				id: "lm-1",
				name: "Weekly sync",
			},
			metadata: { confidential: true },
		});
	});

	it("retires a summary that may hold the series when it turns confidential, and only then", async () => {
		await run({ confidential: true });
		expect(mocks.retireSummaries).toHaveBeenCalledWith({
			projectId: "project-1",
			linkedMeetingId: "lm-1",
		});

		mocks.retireSummaries.mockClear();
		await run({ confidential: false });
		expect(mocks.retireSummaries).not.toHaveBeenCalled();
	});
});
