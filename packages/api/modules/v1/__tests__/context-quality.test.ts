import { contextQualitySourceRevision } from "@repo/rag/lib/context-quality";
import { Hono } from "hono";
import { beforeEach, describe, expect, it, vi } from "vitest";
import type { ExternalApiVariables } from "../../external-api/types";

const mocks = vi.hoisted(() => ({
	read: vi.fn(),
	verifyOrganizationApiKey: vi.fn(),
	verifyOAuthAccessToken: vi.fn(),
	permissions: vi.fn(),
	hasProjectAccess: vi.fn(),
	findOrganization: vi.fn(),
}));

vi.mock("@repo/database", () => ({
	db: {
		organization: { findFirst: mocks.findOrganization },
		project: {
			findUnique: vi.fn(async () => ({ name: "Example project" })),
		},
	},
	hasProjectAccess: mocks.hasProjectAccess,
	resolveUserOrganization: vi.fn(),
	verifyOrganizationApiKey: mocks.verifyOrganizationApiKey,
	verifyOAuthAccessToken: mocks.verifyOAuthAccessToken,
	OAUTH_ACCESS_TOKEN_PREFIX: "fat_",
	canCreateOrganizationPrompts: vi.fn(),
	canCreateProjectInOrganization: vi.fn(),
	canExecuteOrganizationAgents: vi.fn(),
	canRunOrganizationWorkflows: vi.fn(),
	canUpdateOrganizationPrompts: vi.fn(),
	canUseOrganizationAiChat: vi.fn(),
	canUseOrganizationIntegrations: vi.fn(),
}));
vi.mock("@repo/utils", () => ({ getBaseUrl: () => "https://example.com" }));
vi.mock("../../users/procedures/api-keys/verify", () => ({
	verifyUserApiKey: vi.fn(),
}));
vi.mock("../../../lib/effective-project-permissions", () => ({
	resolveEffectiveProjectPermissions: mocks.permissions,
}));
vi.mock("../../context-quality/lib/context-reader", async (importOriginal) => ({
	...(await importOriginal<
		typeof import("../../context-quality/lib/context-reader")
	>()),
	readProjectContextSnapshot: mocks.read,
}));

import { evaluateProjectContext } from "../../context-quality/lib/commands";
import {
	ContextReadError,
	type ProjectContextReadInput,
} from "../../context-quality/lib/context-reader";
import { requireApiKey } from "../../external-api/middleware/api-key-auth";
import { registerContextQualityRoutes } from "../context-quality";

const ORG = "org-example-alpha";
const PROJECT = "project-example-alpha";
const USER = "user-example-alpha";
const SOURCE = "source-example-alpha";
const CONTENT = "Confidential example appointment context.";
const REVISION = contextQualitySourceRevision(CONTENT);
const BASE = `/api/v1/projects/${PROJECT}/context-quality`;

function evaluation() {
	return {
		version: 1,
		sources: [{ sourceId: SOURCE, expectedRevision: REVISION }],
		cases: [
			{
				id: "case-example-alpha",
				recordedAnswer: "Patients may cancel appointments online.",
				retrievedSourceIds: [SOURCE],
				citedSourceIds: [SOURCE],
				expectations: {
					expectedSourceIds: [SOURCE],
					requiredPhrases: ["cancel appointments online"],
					forbiddenPhrases: [],
				},
			},
		],
	};
}

function snapshot() {
	return {
		sourceId: SOURCE,
		sourceKind: "project_context" as const,
		projectId: PROJECT,
		organizationId: ORG,
		title: "Example policy",
		content: CONTENT,
		revision: REVISION,
		byteLength: Buffer.byteLength(CONTENT),
		indexingExcluded: false,
		readMode: "direct" as const,
	};
}

function key(scopes = ["projects:read"], organizationId = ORG) {
	return {
		id: "key-example-alpha",
		createdByUserId: USER,
		organizationId,
		scopes,
	};
}

function app() {
	const routes = new Hono<{ Variables: ExternalApiVariables }>();
	routes.use("*", requireApiKey());
	registerContextQualityRoutes(routes);
	return new Hono().route("/api/v1", routes);
}

function request(
	method = "GET",
	path = `${BASE}/sources/${SOURCE}`,
	body?: unknown,
	token = "org_example_key",
) {
	return new Request(`http://localhost${path}`, {
		method,
		headers: {
			authorization: `Bearer ${token}`,
			"content-type": "application/json",
		},
		...(body !== undefined
			? { body: typeof body === "string" ? body : JSON.stringify(body) }
			: {}),
	});
}

beforeEach(() => {
	vi.clearAllMocks();
	mocks.verifyOrganizationApiKey.mockResolvedValue(key());
	mocks.verifyOAuthAccessToken.mockResolvedValue({
		valid: true,
		audience: "api",
		clientRowId: "client-example-alpha",
		userId: USER,
		organizationId: ORG,
		scopes: ["projects:read"],
		projectId: PROJECT,
	});
	mocks.permissions.mockResolvedValue({
		organizationId: ORG,
		source: "org",
		permissions: ["context:read"],
	});
	mocks.hasProjectAccess.mockResolvedValue(true);
	mocks.findOrganization.mockResolvedValue({ id: ORG });
	mocks.read.mockImplementation(async (input: ProjectContextReadInput) => {
		if (input.sourceId !== SOURCE) {
			throw new ContextReadError("NOT_FOUND");
		}
		if (input.expectedRevision && input.expectedRevision !== REVISION) {
			throw new ContextReadError("STALE_REVISION");
		}
		return snapshot();
	});
});

describe("v1 context quality with real authentication/scope middleware and project resolver", () => {
	it("returns exactly the shared command report for the same recorded snapshot", async () => {
		const raw = evaluation();
		const direct = await evaluateProjectContext(
			{ organizationId: ORG, projectId: PROJECT, userId: USER },
			raw,
		);
		const response = await app().request(
			request("POST", `${BASE}/evaluate`, raw),
		);
		expect(response.status).toBe(200);
		expect((await response.json()).data).toEqual(direct);
	});
	it("inspects exact current content under the key creator and hosting organization", async () => {
		const response = await app().request(request());
		expect(response.status).toBe(200);
		expect(await response.json()).toEqual({ data: snapshot() });
		expect(mocks.read).toHaveBeenCalledWith({
			projectId: PROJECT,
			organizationId: ORG,
			userId: USER,
			sourceId: SOURCE,
		});
		expect(response.headers.get("cache-control")).toBe("private, no-store");
	});

	it("evaluates through the real shared command/engine and returns a bounded private report", async () => {
		const response = await app().request(
			request("POST", `${BASE}/evaluate`, evaluation()),
		);
		expect(response.status).toBe(200);
		const report = (await response.json()).data;
		expect(report).toMatchObject({
			status: "passed",
			projectId: PROJECT,
			organizationId: ORG,
			counts: { cases: 1, passed: 1, failed: 0 },
		});
		expect(mocks.read).toHaveBeenCalledTimes(2);
		expect(JSON.stringify(report)).not.toContain(CONTENT);
		expect(JSON.stringify(report)).not.toContain(
			evaluation().cases[0].recordedAnswer,
		);
		expect(response.headers.get("cache-control")).toBe("private, no-store");
	});

	it("keeps failed cases in a successfully completed evaluation response", async () => {
		const input = evaluation();
		input.cases.push({
			...structuredClone(input.cases[0]),
			id: "case-example-failed",
			recordedAnswer: "Wrong answer",
		});
		const response = await app().request(
			request("POST", `${BASE}/evaluate`, input),
		);
		expect(response.status).toBe(200);
		expect((await response.json()).data).toMatchObject({
			status: "failed",
			counts: { cases: 2, passed: 1, failed: 1 },
		});
	});

	it("distinguishes missing scope from current project permission refusal", async () => {
		mocks.verifyOrganizationApiKey.mockResolvedValue(
			key(["workspaces:read"]),
		);
		const scope = await app().request(request());
		expect(scope.status).toBe(403);
		expect(await scope.json()).toEqual({
			error: "Missing required scope: projects:read",
		});
		expect(mocks.permissions).not.toHaveBeenCalled();
		mocks.verifyOrganizationApiKey.mockResolvedValue(key());
		mocks.permissions.mockResolvedValue({
			organizationId: ORG,
			source: "project-member",
			permissions: [],
		});
		const permission = await app().request(request());
		expect(permission.status).toBe(403);
		expect(await permission.json()).toEqual({
			error: {
				message:
					"No permission to read context sources of this project",
			},
		});
		expect(mocks.read).not.toHaveBeenCalled();
	});

	it("rechecks the wildcard key creator's current permission on every request", async () => {
		mocks.verifyOrganizationApiKey.mockResolvedValue(key(["*"]));
		const server = app();
		expect((await server.request(request())).status).toBe(200);
		mocks.permissions.mockResolvedValue({
			organizationId: ORG,
			source: "org",
			permissions: [],
		});
		expect(
			(
				await server.request(
					request("POST", `${BASE}/evaluate`, evaluation()),
				)
			).status,
		).toBe(403);
		expect(mocks.permissions).toHaveBeenCalledTimes(2);
		expect(mocks.read).toHaveBeenCalledTimes(1);
	});

	it("hides another organization's project even when the key has a wildcard scope", async () => {
		mocks.verifyOrganizationApiKey.mockResolvedValue(
			key(["*"], "org-example-bravo"),
		);
		const response = await app().request(request());
		expect(response.status).toBe(404);
		expect(mocks.read).not.toHaveBeenCalled();
		expect(mocks.hasProjectAccess).not.toHaveBeenCalled();
	});

	it("keeps object visibility separate from organization-level read permission", async () => {
		mocks.hasProjectAccess.mockResolvedValue(false);
		const response = await app().request(request());
		expect(response.status).toBe(404);
		expect(mocks.read).not.toHaveBeenCalled();
	});

	it("supports an invited project guest through a project-bound OAuth credential", async () => {
		mocks.permissions.mockResolvedValue({
			organizationId: ORG,
			source: "project-member",
			permissions: ["context:read"],
		});
		const response = await app().request(
			request(
				"POST",
				`${BASE}/evaluate`,
				evaluation(),
				"fat_example_token",
			),
		);
		expect(response.status).toBe(200);
		expect((await response.json()).data.organizationId).toBe(ORG);
		expect(mocks.read).toHaveBeenCalledWith({
			projectId: PROJECT,
			organizationId: ORG,
			userId: USER,
			...evaluation().sources[0],
		});
	});

	it("refuses a project-bound credential before dispatch to another project", async () => {
		const response = await app().request(
			request(
				"GET",
				"/api/v1/projects/project-example-bravo/context-quality/sources/source-example-alpha",
				undefined,
				"fat_example_token",
			),
		);
		// Authentication's global route classifier intentionally uses a project-
		// bound refusal (403) before this route's visibility-hiding resolver.
		expect(response.status).toBe(403);
		expect(mocks.read).not.toHaveBeenCalled();
	});

	it("does not accept an org query override outside the hosting organization", async () => {
		mocks.findOrganization.mockResolvedValue({ id: "org-example-bravo" });
		const response = await app().request(
			request("GET", `${BASE}/sources/${SOURCE}?org=example-bravo`),
		);
		expect(response.status).toBe(404);
		expect(mocks.read).not.toHaveBeenCalled();
	});

	it.each([
		["NOT_FOUND", 404],
		["FORBIDDEN", 403],
		["NOT_READY", 409],
		["STALE_REVISION", 409],
		["TOO_LARGE", 413],
	] as const)(
		"maps %s without source data in the error",
		async (code, status) => {
			mocks.read.mockRejectedValue(new ContextReadError(code));
			const response = await app().request(
				request("POST", `${BASE}/evaluate`, evaluation()),
			);
			expect(response.status).toBe(status);
			expect(await response.text()).not.toContain(CONTENT);
			expect(response.headers.get("cache-control")).toBe(
				"private, no-store",
			);
		},
	);

	it("refuses source erasure after loading rather than returning a stale successful report", async () => {
		mocks.read
			.mockResolvedValueOnce(snapshot())
			.mockRejectedValueOnce(new ContextReadError("NOT_FOUND"));
		const response = await app().request(
			request("POST", `${BASE}/evaluate`, evaluation()),
		);
		expect(response.status).toBe(404);
		expect(await response.text()).not.toContain('"status":"passed"');
	});

	it.each([
		["malformed JSON", "{"],
		[
			"unknown tenant",
			{ ...evaluation(), organizationId: "org-example-bravo" },
		],
		[
			"caller bytes",
			{
				...evaluation(),
				sources: [{ ...evaluation().sources[0], content: CONTENT }],
			},
		],
		["empty cases", { ...evaluation(), cases: [] }],
	])("rejects %s without echoing the payload", async (_label, body) => {
		const response = await app().request(
			request("POST", `${BASE}/evaluate`, body),
		);
		expect(response.status).toBe(400);
		expect(await response.text()).not.toContain(CONTENT);
		expect(mocks.read).not.toHaveBeenCalled();
	});

	it("bounds the raw body before JSON parsing or source loading", async () => {
		const response = await app().request(
			request("POST", `${BASE}/evaluate`, "x".repeat(128 * 1024 + 1)),
		);
		expect(response.status).toBe(413);
		expect(mocks.read).not.toHaveBeenCalled();
	});

	it("requires a valid credential before any read", async () => {
		mocks.verifyOrganizationApiKey.mockResolvedValue(null);
		const response = await app().request(request());
		expect(response.status).toBe(401);
		expect(mocks.read).not.toHaveBeenCalled();
	});
});
