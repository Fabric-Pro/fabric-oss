/**
 * Tests for the REST-GitLab fallback branch in get-pm-capabilities.
 *
 * Existing MCP paths are covered by integration tests elsewhere; this file
 * focuses on the new branch added when no MCPConfig exists but the project's
 * server is `gitlab-official` and the tenant has an active GITLAB
 * WorkflowIntegration.
 */

import { beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("@repo/database", () => ({
	db: {
		project: { findUnique: vi.fn() },
		mCPServer: { findUnique: vi.fn() },
		workflowIntegration: { findFirst: vi.fn() },
	},
	resolvePMConfigForUser: vi.fn(),
	isPmServerIdKeySentinel: (id: string) => id.startsWith("key:"),
	readPmServerIdKeySentinel: (id: string) => id.slice("key:".length),
}));

vi.mock("../../../../../../orpc/procedures", () => {
	// `outputSchema` is captured, not discarded: the response shape is part of
	// the contract this procedure can break at runtime, so the tests validate
	// handler results against the schema the procedure actually declares.
	const chain: Record<string, unknown> = {
		outputSchema: null,
		route: () => chain,
		input: () => chain,
		output: (schema: unknown) => {
			chain.outputSchema = schema;
			return chain;
		},
		use: () => chain,
		handler: (fn: unknown) => ({ handler: fn }),
	};
	return {
		tenantProtectedProcedure: chain,
		requireProjectPermission: () => (handler: unknown) => handler,
		Permissions: { STORY_READ: "story:read" },
	};
});

import { db, resolvePMConfigForUser } from "@repo/database";
import { tenantProtectedProcedure } from "../../../../../../orpc/procedures";
import { getPMCapabilitiesProcedure } from "../get-pm-capabilities";

/** The `.output(...)` schema the procedure declares, captured by the mock above. */
const outputSchema = (
	tenantProtectedProcedure as unknown as {
		outputSchema: { parse: (value: unknown) => unknown };
	}
).outputSchema;

const handler = (
	getPMCapabilitiesProcedure as unknown as {
		handler: (args: {
			input: { projectId: string };
			context: { user: { id: string } };
		}) => Promise<Record<string, unknown>>;
	}
).handler;

const baseCtx = { user: { id: "user-1" } };

function setupProject(
	overrides: Partial<{
		organizationId: string | null;
		projectManagementMcpServerId: string | null;
		projectManagementMcpConfigId: string | null;
		projectManagementContainerId: string | null;
		projectManagementContainerName: string | null;
		projectManagementAdditionalContext: Record<string, unknown>;
	}> = {},
) {
	vi.mocked(db.project.findUnique).mockResolvedValue({
		id: "proj-1",
		organizationId: overrides.organizationId ?? null,
		projectManagementMcpServerId:
			overrides.projectManagementMcpServerId ?? null,
		projectManagementMcpConfigId:
			overrides.projectManagementMcpConfigId ?? null,
		projectManagementContainerId:
			overrides.projectManagementContainerId ?? null,
		projectManagementContainerName:
			overrides.projectManagementContainerName ?? null,
		projectManagementAdditionalContext:
			overrides.projectManagementAdditionalContext ?? {},
	} as never);
}

beforeEach(() => {
	vi.clearAllMocks();
});

describe("get-pm-capabilities — REST-GitLab branch", () => {
	it("returns configured=true with REST capabilities when server is gitlab-official + active WorkflowIntegration + no MCPConfig", async () => {
		setupProject({
			projectManagementMcpServerId: "srv-gl",
			projectManagementMcpConfigId: null,
			projectManagementContainerId: "100",
			projectManagementContainerName: "example-group/fabricgl",
		});
		vi.mocked(resolvePMConfigForUser).mockResolvedValue(null);
		vi.mocked(db.mCPServer.findUnique).mockResolvedValue({
			key: "gitlab-official",
		} as never);
		vi.mocked(db.workflowIntegration.findFirst).mockResolvedValue({
			id: "wi-1",
		} as never);

		const result = await handler({
			input: { projectId: "proj-1" },
			context: baseCtx,
		});

		expect(result).toMatchObject({
			configured: true,
			detectedType: "gitlab-rest",
			mcpConfigId: null,
			containerId: "100",
			containerName: "example-group/fabricgl",
			error: null,
			capabilities: {
				hasPMCapabilities: true,
				canCreate: true,
				canUpdate: true,
				canGet: true,
				canList: true,
				supportsPush: true,
				supportsPull: true,
				supportsTaskSync: false,
			},
		});
	});

	it("falls through to 'not connected' error when server is gitlab-official but no active WorkflowIntegration", async () => {
		setupProject({
			projectManagementMcpServerId: "srv-gl",
			projectManagementMcpConfigId: null,
			projectManagementContainerId: "100",
		});
		vi.mocked(resolvePMConfigForUser).mockResolvedValue(null);
		vi.mocked(db.mCPServer.findUnique).mockResolvedValue({
			key: "gitlab-official",
		} as never);
		vi.mocked(db.workflowIntegration.findFirst).mockResolvedValue(null);

		const result = await handler({
			input: { projectId: "proj-1" },
			context: baseCtx,
		});

		expect(result.configured).toBe(true);
		expect(result.capabilities).toBeNull();
		expect(result.error).toMatch(/not connected/i);
	});

	it("falls through to 'not connected' error when server is not gitlab-official", async () => {
		setupProject({
			projectManagementMcpServerId: "srv-fz",
			projectManagementMcpConfigId: null,
			projectManagementContainerId: "100",
		});
		vi.mocked(resolvePMConfigForUser).mockResolvedValue(null);
		vi.mocked(db.mCPServer.findUnique).mockResolvedValue({
			key: "fizzy",
		} as never);

		const result = await handler({
			input: { projectId: "proj-1" },
			context: baseCtx,
		});

		expect(result.error).toMatch(/not connected/i);
	});

	it("REST GitLab capabilities response does NOT include canFetch (internal-only field)", async () => {
		setupProject({
			projectManagementMcpServerId: "srv-gl",
			projectManagementMcpConfigId: null,
			projectManagementContainerId: "100",
			projectManagementContainerName: "example-group/fabricgl",
		});
		vi.mocked(resolvePMConfigForUser).mockResolvedValue(null);
		vi.mocked(db.mCPServer.findUnique).mockResolvedValue({
			key: "gitlab-official",
		} as never);
		vi.mocked(db.workflowIntegration.findFirst).mockResolvedValue({
			id: "wi-1",
		} as never);

		const result = await handler({
			input: { projectId: "proj-1" },
			context: baseCtx,
		});

		// Locks in the API contract: `canFetch` is consumed by internal
		// Temporal activities but is not part of the public surface. A future
		// contributor accidentally exposing it via the GITLAB_REST_CAPABILITIES
		// constant will see this test fail.
		expect(result.capabilities).not.toHaveProperty("canFetch");
	});

	it("uses XOR tenant filter (org context) for the WorkflowIntegration lookup", async () => {
		setupProject({
			organizationId: "org-x",
			projectManagementMcpServerId: "srv-gl",
			projectManagementMcpConfigId: null,
			projectManagementContainerId: "100",
		});
		vi.mocked(resolvePMConfigForUser).mockResolvedValue(null);
		vi.mocked(db.mCPServer.findUnique).mockResolvedValue({
			key: "gitlab-official",
		} as never);
		vi.mocked(db.workflowIntegration.findFirst).mockResolvedValue({
			id: "wi-1",
		} as never);

		await handler({
			input: { projectId: "proj-1" },
			context: baseCtx,
		});

		const call = vi.mocked(db.workflowIntegration.findFirst).mock
			.calls[0]?.[0];
		expect(call?.where).toMatchObject({
			provider: "GITLAB",
			isActive: true,
			userId: "user-1",
			organizationId: "org-x",
		});
	});

	it("returns REST capabilities when projectManagementMcpServerId is the key:gitlab-official sentinel", async () => {
		setupProject({
			projectManagementMcpServerId: "key:gitlab-official",
			projectManagementMcpConfigId: null,
			projectManagementContainerId: "100",
			projectManagementContainerName: "example-group/fabricgl",
		});
		vi.mocked(resolvePMConfigForUser).mockResolvedValue(null);
		vi.mocked(db.workflowIntegration.findFirst).mockResolvedValue({
			id: "wi-1",
		} as never);

		const result = await handler({
			input: { projectId: "proj-1" },
			context: baseCtx,
		});

		// Sentinel must short-circuit the catalog lookup entirely — if the code
		// calls findUnique on the sentinel id, that's a regression.
		expect(vi.mocked(db.mCPServer.findUnique)).not.toHaveBeenCalled();

		expect(result).toMatchObject({
			configured: true,
			detectedType: "gitlab-rest",
			mcpConfigId: null,
			containerId: "100",
			containerName: "example-group/fabricgl",
			error: null,
			capabilities: {
				hasPMCapabilities: true,
				canList: true,
				supportsPull: true,
			},
		});
	});

	it("returns the not-connected error when sentinel is set but WorkflowIntegration is missing", async () => {
		setupProject({
			projectManagementMcpServerId: "key:gitlab-official",
			projectManagementMcpConfigId: null,
			projectManagementContainerId: "100",
		});
		vi.mocked(resolvePMConfigForUser).mockResolvedValue(null);
		vi.mocked(db.workflowIntegration.findFirst).mockResolvedValue(null);

		const result = await handler({
			input: { projectId: "proj-1" },
			context: baseCtx,
		});

		expect(result).toMatchObject({
			configured: true,
			capabilities: null,
			// detectedType is now derived from the stored server key even in
			// degraded branches (PR: pm-tool-label-fallback): a gitlab-official
			// project surfaces "gitlab" instead of null so the UI can label the
			// connected tool while the per-user connection is still unresolved.
			detectedType: "gitlab",
		});
		// Verify the sentinel resolved without hitting the catalog.
		expect(vi.mocked(db.mCPServer.findUnique)).not.toHaveBeenCalled();
		// Verify the gitlab-official branch was actually entered (WorkflowIntegration
		// is the gatekeeper — only reached when serverKey === "gitlab-official").
		expect(vi.mocked(db.workflowIntegration.findFirst)).toHaveBeenCalled();
		expect(typeof result.error).toBe("string");
	});
});

describe("get-pm-capabilities — detectedType fallback from stored server key", () => {
	it("surfaces detectedType from a catalog server key when the user has no resolvable MCP config (github)", async () => {
		setupProject({
			projectManagementMcpServerId: "srv-gh",
			projectManagementMcpConfigId: null,
			projectManagementContainerId: "200",
			projectManagementContainerName: "techfabric/fabric",
		});
		vi.mocked(resolvePMConfigForUser).mockResolvedValue(null);
		vi.mocked(db.mCPServer.findUnique).mockResolvedValue({
			key: "github",
		} as never);

		const result = await handler({
			input: { projectId: "proj-1" },
			context: baseCtx,
		});

		// The teammate-configured GitHub PM tool can't be probed for this user,
		// but the label must still read "GitHub" rather than the generic
		// fallback — so detectedType is derived from the stored server key.
		expect(result.detectedType).toBe("github");
		expect(result.capabilities).toBeNull();
		expect(result.error).toMatch(/not connected/i);
	});

	it("surfaces detectedType for azure-devops in the degraded branch", async () => {
		setupProject({
			projectManagementMcpServerId: "srv-ado",
			projectManagementContainerId: "1",
		});
		vi.mocked(resolvePMConfigForUser).mockResolvedValue(null);
		vi.mocked(db.mCPServer.findUnique).mockResolvedValue({
			key: "azure-devops",
		} as never);

		const result = await handler({
			input: { projectId: "proj-1" },
			context: baseCtx,
		});

		expect(result.detectedType).toBe("azure-devops");
	});

	it("leaves detectedType null when the stored server key is not a known PM tool", async () => {
		setupProject({
			projectManagementMcpServerId: "srv-x",
			projectManagementContainerId: "1",
		});
		vi.mocked(resolvePMConfigForUser).mockResolvedValue(null);
		vi.mocked(db.mCPServer.findUnique).mockResolvedValue({
			key: "some-random-mcp",
		} as never);

		const result = await handler({
			input: { projectId: "proj-1" },
			context: baseCtx,
		});

		expect(result.detectedType).toBeNull();
	});
});

describe("get-pm-capabilities — additionalContext with structured settings", () => {
	/**
	 * Saving an inbound field mapping writes a nested object into
	 * `projectManagementAdditionalContext`, which the response publishes as
	 * `Record<string, string>`. Passing the column through verbatim made every
	 * capability read fail output validation with a 500, which the UI reported
	 * as "couldn't determine the connected project management tool".
	 */
	const contextWithFieldMapping = {
		workItemType: "User Story",
		fieldMapping: {
			provider: "azure-devops",
			fields: [{ id: "System.Description", displayName: "Summary" }],
		},
	};

	it("publishes only the string-valued entries", async () => {
		setupProject({
			projectManagementMcpServerId: "srv-ado",
			projectManagementContainerId: "1",
			projectManagementContainerName: "Board",
			projectManagementAdditionalContext: contextWithFieldMapping,
		});
		vi.mocked(resolvePMConfigForUser).mockResolvedValue(null);
		vi.mocked(db.mCPServer.findUnique).mockResolvedValue({
			key: "azure-devops",
		} as never);

		const result = await handler({
			input: { projectId: "proj-1" },
			context: baseCtx,
		});

		expect(result.additionalContext).toEqual({
			workItemType: "User Story",
		});
	});

	it("returns a response that satisfies the declared output schema", async () => {
		setupProject({
			projectManagementMcpServerId: "srv-ado",
			projectManagementContainerId: "1",
			projectManagementContainerName: "Board",
			projectManagementAdditionalContext: contextWithFieldMapping,
		});
		vi.mocked(resolvePMConfigForUser).mockResolvedValue(null);
		vi.mocked(db.mCPServer.findUnique).mockResolvedValue({
			key: "azure-devops",
		} as never);

		const result = await handler({
			input: { projectId: "proj-1" },
			context: baseCtx,
		});

		expect(() => outputSchema.parse(result)).not.toThrow();
	});
});
