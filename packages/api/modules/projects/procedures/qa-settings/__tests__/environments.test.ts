import { beforeEach, describe, expect, it, vi } from "vitest";

const { handlers, mocks } = vi.hoisted(() => ({
	handlers: [] as Array<
		(args: {
			input: Record<string, unknown>;
			context: Record<string, unknown>;
		}) => Promise<unknown>
	>,
	mocks: {
		create: vi.fn(),
		update: vi.fn(),
		remove: vi.fn(),
		get: vi.fn(),
		list: vi.fn(),
		audit: vi.fn(),
		assertSafeUrl: vi.fn(),
	},
}));

vi.mock("@repo/database", () => ({
	createProjectEnvironment: (...args: unknown[]) => mocks.create(...args),
	updateProjectEnvironment: (...args: unknown[]) => mocks.update(...args),
	deleteProjectEnvironment: (...args: unknown[]) => mocks.remove(...args),
	getProjectEnvironment: (...args: unknown[]) => mocks.get(...args),
	listProjectEnvironments: (...args: unknown[]) => mocks.list(...args),
}));

vi.mock("@repo/utils/url-security", () => ({
	assertSafeOutboundUrlResolved: (...args: unknown[]) =>
		mocks.assertSafeUrl(...args),
}));

vi.mock("../../../../../lib/audit", () => ({
	recordAuditFromRequest: (...args: unknown[]) => mocks.audit(...args),
}));

vi.mock("../../../../../orpc/procedures", () => {
	const chainable = {
		use: () => chainable,
		route: () => chainable,
		input: () => chainable,
		handler: (handler: (typeof handlers)[number]) => {
			handlers.push(handler);
			return { _handler: handler };
		},
	};
	return {
		tenantProtectedProcedure: chainable,
		requireProjectPermission: () => ({}),
		Permissions: {
			PROJECT_SETTINGS_READ: "project-settings-read",
			PROJECT_SETTINGS_EDIT: "project-settings-edit",
		},
	};
});

await import("../environments");

const [, createEnvironment, updateEnvironment, deleteEnvironment] = handlers;
const context = { user: { id: "user-1" }, headers: new Headers() };
const currentEnvironment = {
	id: "env-1",
	type: "PRODUCTION",
	name: "Production",
	baseUrl: "https://app.example.com",
	signInUrl: "https://app.example.com/auth/login",
	createdAt: new Date("2026-07-28T08:00:00Z"),
};

beforeEach(() => {
	vi.clearAllMocks();
	mocks.get.mockResolvedValue(currentEnvironment);
	mocks.create.mockResolvedValue(currentEnvironment);
	mocks.update.mockResolvedValue(currentEnvironment);
	mocks.remove.mockResolvedValue(currentEnvironment);
	mocks.assertSafeUrl.mockResolvedValue(undefined);
});

describe("project environment URL policy", () => {
	it("rejects a cross-origin sign-in URL before creating the environment", async () => {
		await expect(
			createEnvironment({
				input: {
					projectId: "project-1",
					type: "PRODUCTION",
					name: "Production",
					baseUrl: "https://app.example.com",
					signInUrl: "https://attacker.example/auth/login",
				},
				context,
			}),
		).rejects.toMatchObject({ code: "BAD_REQUEST" });

		expect(mocks.create).not.toHaveBeenCalled();
		expect(mocks.audit).not.toHaveBeenCalled();
	});

	it("rejects a base-URL update that would strand the saved sign-in URL on another origin", async () => {
		await expect(
			updateEnvironment({
				input: {
					projectId: "project-1",
					environmentId: "env-1",
					baseUrl: "https://new.example.com",
				},
				context,
			}),
		).rejects.toMatchObject({ code: "BAD_REQUEST" });

		expect(mocks.update).not.toHaveBeenCalled();
		expect(mocks.audit).not.toHaveBeenCalled();
	});

	it("rejects an environment URL that resolves to a non-public address", async () => {
		mocks.assertSafeUrl.mockRejectedValueOnce(
			new Error("Private network access is not allowed"),
		);

		await expect(
			createEnvironment({
				input: {
					projectId: "project-1",
					type: "STAGING",
					name: "Staging",
					baseUrl: "https://internal.example.com",
				},
				context,
			}),
		).rejects.toMatchObject({
			code: "BAD_REQUEST",
			message:
				"Environment URLs must resolve to public HTTP or HTTPS addresses",
		});

		expect(mocks.create).not.toHaveBeenCalled();
		expect(mocks.audit).not.toHaveBeenCalled();
	});
});

describe("project environment audit trail", () => {
	it("records the environment without query strings or credentials on create", async () => {
		await createEnvironment({
			input: {
				projectId: "project-1",
				type: "PRODUCTION",
				name: "Production",
				baseUrl: "https://app.example.com/path?token=never-log-this",
				signInUrl: "https://app.example.com/auth/login",
			},
			context,
		});

		expect(mocks.audit).toHaveBeenCalledWith(
			context,
			expect.objectContaining({
				action: "project.environment.created",
				projectId: "project-1",
				resource: {
					type: "project_environment",
					id: "env-1",
					name: "Production",
				},
				metadata: expect.objectContaining({
					baseUrlOrigin: "https://app.example.com",
					signInUrlOrigin: "https://app.example.com",
					isProduction: true,
				}),
			}),
		);
		expect(JSON.stringify(mocks.audit.mock.calls[0])).not.toContain(
			"never-log-this",
		);
	});

	it("records changed fields after an update", async () => {
		await updateEnvironment({
			input: {
				projectId: "project-1",
				environmentId: "env-1",
				name: "Primary production",
			},
			context,
		});

		expect(mocks.audit).toHaveBeenCalledWith(
			context,
			expect.objectContaining({
				action: "project.environment.updated",
				metadata: expect.objectContaining({
					changedFields: ["name"],
				}),
			}),
		);
	});

	it("uses the deleted row as the audit snapshot", async () => {
		await deleteEnvironment({
			input: {
				projectId: "project-1",
				environmentId: "env-1",
			},
			context,
		});

		expect(mocks.audit).toHaveBeenCalledWith(
			context,
			expect.objectContaining({
				action: "project.environment.deleted",
				resource: {
					type: "project_environment",
					id: "env-1",
					name: "Production",
				},
			}),
		);
	});
});
