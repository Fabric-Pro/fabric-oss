import { beforeEach, describe, expect, it, vi } from "vitest";

const state = vi.hoisted(() => ({
	/** organizationId -> userId -> role */
	members: {} as Record<string, Record<string, string>>,
	deletedConfigIds: [] as string[],
}));

vi.mock("@repo/database", async (importOriginal) => {
	const actual = await importOriginal<Record<string, unknown>>();
	return {
		...actual,
		getMcpConfigById: async (
			id: string,
			opts?: { userId: string; organizationId?: string },
		) => ({
			id,
			userId: opts?.userId ?? USER,
			organizationId: opts?.organizationId ?? null,
			displayName: "Example MCP",
			isManagedDefault: false,
			mcpServer: { key: "example-mcp", name: "Example MCP" },
		}),
		deleteMcpConfig: async (id: string) => {
			state.deletedConfigIds.push(id);
		},
		recordAudit: async () => undefined,
		clearMcpConfigFromReportInstances: async () => 0,
	};
});

vi.mock("@repo/temporal", () => ({
	triggerMcpServerIngestion: vi.fn(),
	triggerMcpToolDeletion: vi.fn().mockResolvedValue(undefined),
	triggerMcpToolIngestion: vi.fn(),
}));

vi.mock("../../../organizations/lib/membership", () => ({
	verifyOrganizationMembership: async (
		organizationId: string,
		userId: string,
	) => {
		const role = state.members[organizationId]?.[userId];
		return role ? { role } : null;
	},
}));

import { PERMISSION_MIDDLEWARE_TAG } from "../../../../orpc/middleware/require-permission";
import { configProcedures } from "../configs";

const USER = "user-1";
const ORG = "example-org";
const CONFIG_ID = "config-1";

type Definition = {
	"~orpc": {
		middlewares: unknown[];
		handler: (options: Record<string, unknown>) => Promise<unknown>;
	};
};

async function call(
	procedure: unknown,
	input: Record<string, unknown>,
	session: { org: string | null; role?: string | null },
): Promise<any> {
	const def = (procedure as Definition)["~orpc"];
	const permissionMiddlewares = def.middlewares.filter(
		(mw) =>
			typeof mw === "function" &&
			(mw as unknown as Record<symbol, unknown>)[
				PERMISSION_MIDDLEWARE_TAG
			] !== undefined,
	);
	expect(permissionMiddlewares.length).toBeGreaterThan(0);
	const base = {
		user: { id: USER, email: "dev@example.com", name: "Dev" },
		session: { id: "session-1", activeOrganizationId: session.org },
		tenantContext: session.org
			? {
					userId: USER,
					type: "organization",
					organizationId: session.org,
				}
			: { userId: USER, type: "personal", organizationId: null },
		activeOrganizationRole: session.role ?? null,
		allowedProjectIds: [],
	};
	const step = async (
		index: number,
		context: Record<string, unknown>,
	): Promise<{ output: unknown }> => {
		if (index === permissionMiddlewares.length) {
			return {
				output: await def.handler({
					input,
					context,
					path: [],
					procedure,
					signal: undefined,
					lastEventId: undefined,
					errors: {},
				}),
			};
		}
		const mw = permissionMiddlewares[index] as (
			options: Record<string, unknown>,
			input: unknown,
			output: unknown,
		) => Promise<{ output: unknown }>;
		return mw(
			{
				context,
				path: [],
				procedure,
				signal: undefined,
				lastEventId: undefined,
				errors: {},
				next: (options?: { context?: Record<string, unknown> }) =>
					step(index + 1, {
						...context,
						...(options?.context ?? {}),
					}),
			},
			input,
			undefined,
		);
	};
	return (await step(0, base)).output;
}

beforeEach(() => {
	state.members = { [ORG]: { [USER]: "member" } };
	state.deletedConfigIds = [];
});

describe("mcp.configs.delete authorization", () => {
	it("allows a member to delete their own config", async () => {
		const result = await call(
			configProcedures.delete,
			{ id: CONFIG_ID, organizationId: ORG },
			{ org: ORG, role: "member" },
		);

		expect(result).toEqual({ success: true });
		expect(state.deletedConfigIds).toEqual([CONFIG_ID]);
	});

	it("refuses a viewer with FORBIDDEN without calling deleteMcpConfig", async () => {
		state.members[ORG][USER] = "viewer";

		await expect(
			call(
				configProcedures.delete,
				{ id: CONFIG_ID, organizationId: ORG },
				{ org: ORG, role: "viewer" },
			),
		).rejects.toMatchObject({ code: "FORBIDDEN" });

		expect(state.deletedConfigIds).toEqual([]);
	});
});
