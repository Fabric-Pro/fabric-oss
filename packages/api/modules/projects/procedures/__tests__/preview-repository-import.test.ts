/**
 * `projects.previewRepositoryImport`: the phase it proposes from the
 * repository's file list, and the membership check in the resolved
 * organization that guards the GitHub read.
 */
import { beforeEach, describe, expect, it, vi } from "vitest";

const m = vi.hoisted(() => ({
	verifyMembership: vi.fn(),
	credential: vi.fn(),
	listTree: vi.fn(),
	readFile: vi.fn(),
	getModel: vi.fn(),
}));

vi.mock("../../../organizations/lib/membership", () => ({
	verifyOrganizationMembership: m.verifyMembership,
}));
vi.mock("@repo/integrations/github", () => ({
	getGitHubWorkflowCredential: m.credential,
}));
vi.mock("@repo/connectors", () => ({
	listRepositoryTree: m.listTree,
	readRepositoryFile: m.readFile,
}));
vi.mock("@repo/ai", () => ({
	getAIModelWithMetadata: m.getModel,
	generateText: vi.fn(),
}));
vi.mock("@repo/logs", () => ({
	logger: { warn: vi.fn(), info: vi.fn(), error: vi.fn() },
}));
vi.mock("../../../../orpc/procedures", () => {
	const builder: Record<string, unknown> = {};
	builder.use = () => builder;
	builder.route = () => builder;
	builder.input = () => builder;
	builder.handler = (fn: unknown) => ({ handler: fn });
	return {
		tenantProtectedProcedure: builder,
		resolveOrganizationId: (orgId: string | null | undefined) =>
			orgId ?? null,
		Permissions: new Proxy({}, { get: (_t, p) => String(p) }),
		requirePermission: () => (c: unknown) => c,
	};
});

import { repositoryProfile } from "@repo/instructions";
import {
	previewRepositoryImportProcedure,
	proposedPhaseOf,
} from "../preview-repository-import";

type Handler = (args: {
	input: Record<string, unknown>;
	context: { user: { id: string }; session: { id: string } };
}) => Promise<{ projectPhase: string | null; name: string }>;

const handler = (
	previewRepositoryImportProcedure as unknown as { handler: Handler }
).handler;

const context = { user: { id: "user-1" }, session: { id: "s-1" } };

function files(...paths: string[]) {
	return {
		ok: true,
		entries: paths.map((path) => ({ path, type: "file" })),
	};
}

beforeEach(() => {
	vi.clearAllMocks();
	m.verifyMembership.mockResolvedValue(true);
	m.credential.mockResolvedValue({ kind: "pat", token: "test-token" });
	m.readFile.mockResolvedValue({ ok: true, state: "missing" });
	m.getModel.mockRejectedValue(new Error("no model in tests"));
	vi.stubGlobal(
		"fetch",
		vi.fn(async () => ({
			ok: true,
			status: 200,
			json: async () => ({
				name: "booking-app",
				owner: { login: "example-org" },
				html_url: "https://github.com/example-org/booking-app",
				default_branch: "main",
				description: null,
				language: null,
			}),
		})),
	);
});

describe("proposedPhaseOf", () => {
	it("proposes development for a repository with application code", () => {
		expect(
			proposedPhaseOf(
				repositoryProfile(["README.md", "src/app.ts", "docs/a.md"]),
			),
		).toBe("DEVELOPMENT_EXECUTION");
	});

	it("proposes planning for a repository of documents only", () => {
		expect(
			proposedPhaseOf(repositoryProfile(["README.md", "docs/vision.md"])),
		).toBe("DISCOVERY_PLANNING");
	});

	it("proposes nothing for an empty or unread repository", () => {
		expect(proposedPhaseOf(repositoryProfile([]))).toBeNull();
		expect(proposedPhaseOf(null)).toBeNull();
	});
});

describe("previewRepositoryImport", () => {
	const input = {
		organizationId: "org-1",
		owner: "example-org",
		repo: "booking-app",
	};

	it("returns the phase the file list suggests", async () => {
		m.listTree.mockResolvedValue(files("README.md", "src/Program.cs"));
		const result = await handler({ input, context });
		expect(result.projectPhase).toBe("DEVELOPMENT_EXECUTION");
		expect(result.name).toBe("booking-app");
	});

	it("proposes planning for a docs repository", async () => {
		m.listTree.mockResolvedValue(files("README.md", "docs/roadmap.md"));
		const result = await handler({ input, context });
		expect(result.projectPhase).toBe("DISCOVERY_PLANNING");
	});

	it("proposes no phase when the file list could not be read", async () => {
		m.listTree.mockResolvedValue({ ok: false, outcome: "timeout" });
		const result = await handler({ input, context });
		expect(result.projectPhase).toBeNull();
	});

	it("refuses an organization the caller is not a member of, before reading GitHub", async () => {
		m.verifyMembership.mockResolvedValue(false);
		await expect(
			handler({
				input: { ...input, organizationId: "org-other" },
				context,
			}),
		).rejects.toMatchObject({ code: "FORBIDDEN" });
		expect(m.verifyMembership).toHaveBeenCalledWith("org-other", "user-1");
		expect(m.credential).not.toHaveBeenCalled();
		expect(fetch).not.toHaveBeenCalled();
	});

	it("reads with the caller's credential in the resolved organization", async () => {
		m.listTree.mockResolvedValue(files("src/app.ts"));
		await handler({ input, context });
		expect(m.credential).toHaveBeenCalledWith("user-1", "org-1");
	});
});
