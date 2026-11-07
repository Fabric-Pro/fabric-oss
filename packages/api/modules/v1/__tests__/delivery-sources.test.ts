import { ORPCError } from "@orpc/server";
import { Hono } from "hono";
import { beforeEach, describe, expect, it, vi } from "vitest";
import type {
	ExternalApiContext,
	ExternalApiVariables,
} from "../../external-api/types";

const m = vi.hoisted(() => ({
	access: vi.fn(),
	org: vi.fn(),
	verifyOAuth: vi.fn(),
	list: vi.fn(),
	inspect: vi.fn(),
	configure: vi.fn(),
	state: vi.fn(),
	capture: vi.fn(),
	status: vi.fn(),
	cancel: vi.fn(),
	observations: vi.fn(),
	evidence: vi.fn(),
}));
vi.mock("@repo/database", () => ({
	OAUTH_ACCESS_TOKEN_PREFIX: "fat_",
	verifyOAuthAccessToken: m.verifyOAuth,
	db: { organization: { findFirst: m.org } },
	canExecuteOrganizationAgents: vi.fn(),
	canReadOrganizationReports: vi.fn(),
	canRunOrganizationWorkflows: vi.fn(),
}));
vi.mock("../../users/procedures/api-keys/verify", () => ({
	verifyUserApiKey: vi.fn(),
}));
vi.mock("../../projects/lib/delivery-source-commands", () => ({
	requirePrivateDeliverySourceProject: m.access,
	listDeliverySourceWatches: m.list,
	inspectDeliverySource: m.inspect,
	configureDeliverySource: m.configure,
	updateDeliverySourceState: m.state,
	startDeliverySourceCapture: m.capture,
	getDeliverySourceCaptureStatus: m.status,
	cancelDeliverySourceCapture: m.cancel,
	listDeliverySourceObservations: m.observations,
	getDeliverySourceEvidence: m.evidence,
}));

import { requireApiKey } from "../../external-api/middleware/api-key-auth";
import { isDeliverySourcePath } from "../../external-api/project-bound";
import { registerDeliverySourceRoutes } from "../delivery-sources";

const credential: ExternalApiContext = {
	keyType: "organization",
	keyId: "example-key",
	keyPrefix: "org_example",
	userId: "example-user",
	organizationId: "example-org",
	scopes: ["*"],
};
const root = "/projects/example-project/delivery/private-sources";
const requestId = "11111111-1111-4111-8111-111111111111";
const run = {
	version: 1,
	state: "RUNNING",
	requestId,
	coverage: null,
	captured: null,
	hasMore: false,
	message: null,
};
function request(
	suffix = "",
	options: {
		method?: string;
		body?: unknown;
		credential?: ExternalApiContext;
	} = {},
) {
	const app = new Hono<{ Variables: ExternalApiVariables }>();
	app.use("*", async (c, next) => {
		c.set("externalApiContext", options.credential ?? credential);
		await next();
	});
	registerDeliverySourceRoutes(app);
	return app.request(root + suffix, {
		method: options.method ?? "GET",
		...(options.body !== undefined
			? {
					body: JSON.stringify(options.body),
					headers: { "content-type": "application/json" },
				}
			: {}),
	});
}
beforeEach(() => {
	vi.clearAllMocks();
	m.access.mockResolvedValue({
		organizationId: "example-org",
		projectId: "example-project",
		userId: "example-user",
	});
	m.org.mockResolvedValue({ id: "example-org" });
	m.list.mockResolvedValue({
		version: 1,
		availability: { state: "ENABLED", reason: null },
		watches: [],
		connections: [],
	});
	m.status.mockResolvedValue(run);
	m.capture.mockResolvedValue(run);
	m.cancel.mockResolvedValue(run);
});
describe("private-source transport boundary", () => {
	it("binds org selectors only after the canonical current-object guard", async () => {
		const response = await request("?org=example-team");
		expect(response.status).toBe(200);
		expect(response.headers.get("cache-control")).toBe("private, no-store");
		expect(m.access).toHaveBeenCalledWith(
			{
				userId: "example-user",
				boundProjectId: undefined,
				organizationBinding: { organizationId: "example-org" },
			},
			"example-project",
			false,
		);
		expect(m.org).toHaveBeenCalledWith({
			where: { id: "example-org", slug: "example-team" },
			select: { id: true },
		});
		m.access.mockRejectedValue(
			new ORPCError("NOT_FOUND", { message: "Project not found" }),
		);
		m.org.mockClear();
		expect((await request("?org=foreign")).status).toBe(404);
		expect(m.org).not.toHaveBeenCalled();
	});
	it("requires exact operation ceilings before current binding, including RESUME network access", async () => {
		for (const [suffix, body, scopes] of [
			["", undefined, ["mcp:read"]],
			[
				"/example-watch/state",
				{ requestId, expectedVersion: 1, action: "RESUME" },
				["projects:write", "features:write", "integrations:read"],
			],
		] as const) {
			const response = await request(suffix, {
				method: body ? "POST" : "GET",
				body,
				credential: { ...credential, scopes: [...scopes] },
			});
			expect(response.status).toBe(403);
			expect((await response.json()).error.code).toBe(
				"INSUFFICIENT_SCOPE",
			);
		}
		expect(m.access).not.toHaveBeenCalled();
		expect(m.state).not.toHaveBeenCalled();
	});
	it("keeps wildcard current-actor refusals and safe retry identity", async () => {
		m.access.mockRejectedValueOnce(
			new ORPCError("FORBIDDEN", {
				message: "Current access denied.",
				data: { code: "INSUFFICIENT_PERMISSION" },
			}),
		);
		expect((await (await request()).json()).error.code).toBe(
			"INSUFFICIENT_PERMISSION",
		);
		const response = await request("/example-watch/capture", {
			method: "POST",
			body: { requestId, expectedVersion: 2, mode: "CONTINUE" },
		});
		expect(response.status).toBe(200);
		expect(m.capture).toHaveBeenCalledWith(
			expect.objectContaining({ userId: "example-user" }),
			{
				projectId: "example-project",
				watchId: "example-watch",
				requestId,
				expectedVersion: 2,
				mode: "CONTINUE",
			},
		);
	});
	it("rejects client actor/tenant injection and never echoes provider failures or unexpected output fields", async () => {
		for (const body of [
			{
				requestId,
				integrationId: "i",
				channelId: "c",
				userId: "private-actor",
			},
			{
				requestId,
				integrationId: "i",
				channelId: "c",
				organizationId: "private-org",
			},
			{ projectId: "foreign" },
		]) {
			const response = await request("", { method: "POST", body });
			expect(response.status).toBe(400);
			expect(JSON.stringify(await response.json())).not.toMatch(
				/private-actor|private-org/,
			);
		}
		m.list.mockRejectedValueOnce(Error("private-provider-token"));
		const failure = await request();
		expect(failure.status).toBe(503);
		expect(JSON.stringify(await failure.json())).not.toContain(
			"private-provider-token",
		);
		m.list.mockResolvedValueOnce({
			version: 1,
			watches: [],
			connections: [],
			token: "private-output",
		});
		expect(JSON.stringify(await (await request()).json())).not.toContain(
			"private-output",
		);
	});
	it.each([
		["CONFLICT", 409],
		["TOO_MANY_REQUESTS", 429],
		["SERVICE_UNAVAILABLE", 503],
	] as const)("retains %s status safely", async (code, status) => {
		m.list.mockRejectedValueOnce(
			new ORPCError(code, {
				message: "Safe source refusal.",
				data: { code: "SOURCE_REFUSED" },
			}),
		);
		expect((await request()).status).toBe(status);
	});
	it("scopes first through the real OAuth credential middleware, not a fixture middleware", async () => {
		m.verifyOAuth.mockResolvedValue({
			valid: true,
			tokenId: "example-token",
			clientRowId: "example-client",
			userId: "example-user",
			organizationId: "example-org",
			projectId: "foreign",
			audience: "api",
			scopes: ["projects:read"],
		});
		const app = new Hono<{ Variables: ExternalApiVariables }>().basePath(
			"/api/v1",
		);
		app.use("*", requireApiKey());
		registerDeliverySourceRoutes(app);
		const response = await app.request(`/api/v1${root}`, {
			headers: { Authorization: "Bearer fat_example-token" },
		});
		expect(response.status).toBe(403);
		expect((await response.json()).error.code).toBe("INSUFFICIENT_SCOPE");
		expect(m.access).not.toHaveBeenCalled();
	});
	it("bypasses global project binding only for implemented path/method pairs", () => {
		for (const path of [
			"",
			"/inspect",
			"/example-watch/state",
			"/example-watch/capture",
			"/example-watch/capture/cancel",
		]) {
			expect(isDeliverySourcePath(`/api/v1${root}${path}`, "POST")).toBe(
				true,
			);
		}
		for (const path of [
			"",
			"/example-watch/capture",
			"/example-watch/observations",
			"/example-watch/observations/example-observation",
		]) {
			expect(isDeliverySourcePath(`/api/v1${root}${path}`, "GET")).toBe(
				true,
			);
		}
		for (const [path, method] of [
			["/inspect", "GET"],
			["/example-watch/state", "GET"],
			["/example-watch/observations", "POST"],
			["/example-watch/observations/x/y", "GET"],
			["/capture", "DELETE"],
		]) {
			expect(isDeliverySourcePath(`/api/v1${root}${path}`, method)).toBe(
				false,
			);
		}
	});
});

it("preserves the deployment availability code on a sanitized503 response", async () => {
	m.list.mockRejectedValueOnce(
		new ORPCError("SERVICE_UNAVAILABLE", {
			message: "Private capture disabled.",
			data: { code: "PRIVATE_SOURCE_CAPTURE_UNAVAILABLE" },
		}),
	);
	const response = await request();
	expect(response.status).toBe(503);
	expect((await response.json()).error.code).toBe(
		"PRIVATE_SOURCE_CAPTURE_UNAVAILABLE",
	);
});
