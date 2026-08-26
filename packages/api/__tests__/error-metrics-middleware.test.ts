/**
 * Tests for the oRPC error-metrics middleware.
 *
 * Exercises the pure `recordProcedureError` function directly. No oRPC
 * framework plumbing is needed — the middleware itself is a one-liner
 * wrapper around this function. No mocks for prom-client: we read from
 * the real shared registry.
 */

import { appErrorsTotal, register } from "@repo/observability";
import { beforeEach, describe, expect, it } from "vitest";
import {
	deriveFeatureFromPath,
	recordProcedureError,
} from "../orpc/middleware/error-metrics-middleware";

beforeEach(() => {
	appErrorsTotal.reset();
});

describe("deriveFeatureFromPath", () => {
	it("maps ai.* to ai_generation", () => {
		expect(deriveFeatureFromPath(["ai", "generateTitle"])).toBe(
			"ai_generation",
		);
	});

	it("maps agents.* to ai_generation", () => {
		expect(deriveFeatureFromPath(["agents", "invoke"])).toBe(
			"ai_generation",
		);
	});

	it("maps chats.* to ai_generation", () => {
		expect(deriveFeatureFromPath(["chats", "send"])).toBe("ai_generation");
	});

	it("maps payments.* to payments", () => {
		expect(deriveFeatureFromPath(["payments", "checkout"])).toBe(
			"payments",
		);
	});

	it("maps billing.* to payments", () => {
		expect(deriveFeatureFromPath(["billing", "subscribe"])).toBe(
			"payments",
		);
	});

	it("maps documents.* to document_processing", () => {
		expect(deriveFeatureFromPath(["documents", "upload"])).toBe(
			"document_processing",
		);
	});

	it("maps rag.* to document_processing", () => {
		expect(deriveFeatureFromPath(["rag", "search"])).toBe(
			"document_processing",
		);
	});

	it("maps projects.* to pm_sync", () => {
		expect(deriveFeatureFromPath(["projects", "list"])).toBe("pm_sync");
	});

	it("maps integrations.* to pm_sync", () => {
		expect(deriveFeatureFromPath(["integrations", "connect"])).toBe(
			"pm_sync",
		);
	});

	it("falls back to auth for unknown paths", () => {
		expect(deriveFeatureFromPath(["account", "delete"])).toBe("auth");
	});

	it("falls back to auth on empty path", () => {
		expect(deriveFeatureFromPath([])).toBe("auth");
	});
});

describe("recordProcedureError", () => {
	it("does not throw — never crashes a request", () => {
		expect(() =>
			recordProcedureError(new Error("boom"), {}, ["ai", "x"]),
		).not.toThrow();
	});

	it("increments app_errors_total with the bounded label set", async () => {
		recordProcedureError(new Error("boom"), {}, ["ai", "generateTitle"]);

		const text = await register.metrics();
		expect(text).toContain('service="api"');
		expect(text).toContain('feature="ai_generation"');
		expect(text).toContain('error_class="unhandled"');
		expect(text).toContain('organization_id="personal"');
	});

	it("emits organization_id='personal' when no session/tenant is present", async () => {
		recordProcedureError(new Error("boom"), {}, ["ai", "x"]);
		const text = await register.metrics();
		expect(text).toContain('organization_id="personal"');
	});

	it("emits the cuid for organization_id when tenantContext is org-scoped", async () => {
		recordProcedureError(
			new Error("boom"),
			{
				tenantContext: {
					type: "organization",
					organizationId: "org_abc123",
				},
			},
			["ai", "x"],
		);
		const text = await register.metrics();
		expect(text).toContain('organization_id="org_abc123"');
	});

	it("falls back to session.activeOrganizationId when tenantContext is absent", async () => {
		recordProcedureError(
			new Error("boom"),
			{
				session: { activeOrganizationId: "org_session" },
			},
			["ai", "x"],
		);
		const text = await register.metrics();
		expect(text).toContain('organization_id="org_session"');
	});

	it("personal tenantContext emits 'personal'", async () => {
		recordProcedureError(
			new Error("boom"),
			{
				tenantContext: { type: "personal" },
			},
			["ai", "x"],
		);
		const text = await register.metrics();
		expect(text).toContain('organization_id="personal"');
	});

	it("classifies a 503 status error as error_class='5xx'", async () => {
		const err = Object.assign(new Error("server down"), { status: 503 });
		recordProcedureError(err, {}, ["ai", "x"]);
		const text = await register.metrics();
		expect(text).toContain('error_class="5xx"');
	});

	it("classifies a TimeoutError as error_class='timeout'", async () => {
		const err = new Error("upstream timed out");
		err.name = "TimeoutError";
		recordProcedureError(err, {}, ["ai", "x"]);
		const text = await register.metrics();
		expect(text).toContain('error_class="timeout"');
	});

	it("classifies a NOT_FOUND ORPCError as error_class='downstream_4xx'", async () => {
		const err = Object.assign(new Error("not found"), {
			code: "NOT_FOUND",
		});
		recordProcedureError(err, {}, ["documents", "get"]);
		const text = await register.metrics();
		expect(text).toContain('error_class="downstream_4xx"');
	});

	it("never emits user_id as a label (cardinality guard)", async () => {
		recordProcedureError(
			new Error("boom"),
			{ session: { activeOrganizationId: "org_x" } },
			["ai", "x"],
		);
		const text = await register.metrics();
		expect(text).not.toContain("user_id=");
		expect(text).not.toContain("userId=");
	});

	it("increments exactly once per call", async () => {
		recordProcedureError(new Error("boom"), {}, ["ai", "x"]);
		const text = await register.metrics();
		// Find the app_errors_total{... organization_id="personal"} line and
		// parse the count.
		const match = text.match(
			/app_errors_total\{[^}]*organization_id="personal"[^}]*\} (\d+)/,
		);
		expect(match).toBeTruthy();
		expect(Number(match![1])).toBe(1);
	});
});
