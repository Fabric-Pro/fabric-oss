/**
 * `failGlossyBuildActivity` (Fizzy #2589, R9, R30, KTD4, KTD24): the guarded
 * FAILED write persists a code and a fixed message only, the failure's own
 * text reaches the log redacted and truncated, and `build_failed` is audited
 * only when the write applied.
 */

import { beforeEach, describe, expect, it, vi } from "vitest";

const database = vi.hoisted(() => ({
	failGlossyBuild: vi.fn(),
	markGlossyBuildSuperseded: vi.fn(),
	recordAudit: vi.fn(),
	getGlossyBuildSnapshot: vi.fn(),
	heartbeatGlossyBuild: vi.fn(),
}));

vi.mock("@repo/database", () => ({ db: {}, ...database }));
vi.mock("../../../lib/glossy/model", () => ({
	GLOSSY_AI_PROVIDER_NOT_CONFIGURED_MESSAGE: "Configure an AI provider.",
}));

import {
	failGlossyBuildActivity,
	redactGlossyFailureDetail,
} from "../fail-build";
import { GLOSSY_BUILD_FAILURE_MESSAGES } from "../shared";
import { REF } from "./glossy-fixtures";

const SECRET_DETAIL = [
	"Provider call failed: 401 from https://llm-gateway.internal.example.com/v1/chat",
	"with key sk-proj-AbCdEfGhIjKlMnOpQrStUvWx and Authorization: Bearer abcdefghijklmnop.",
	`Section text: ${"We propose a pilot for Example Org. ".repeat(40)}`,
].join(" ");

let warn: ReturnType<typeof vi.spyOn>;

beforeEach(() => {
	vi.clearAllMocks();
	database.failGlossyBuild.mockResolvedValue("applied");
	database.markGlossyBuildSuperseded.mockResolvedValue("marked");
	warn = vi.spyOn(console, "warn").mockImplementation(() => {});
});

describe("failGlossyBuildActivity", () => {
	it("persists only the code and its fixed message, never the failure's text", async () => {
		await failGlossyBuildActivity({
			...REF,
			code: "BUILD_FAILED",
			detail: SECRET_DETAIL,
		});

		expect(database.failGlossyBuild).toHaveBeenCalledWith({
			buildId: "build-1",
			errorCode: "BUILD_FAILED",
			errorMessage: GLOSSY_BUILD_FAILURE_MESSAGES.BUILD_FAILED,
		});
		const { errorMessage } = database.failGlossyBuild.mock.calls[0][0];
		expect(errorMessage).not.toContain("sk-");
		expect(errorMessage).not.toContain("internal");
		expect(errorMessage).not.toContain("Example Org");
		expect(errorMessage.length).toBeLessThanOrEqual(500);
	});

	it("logs the failure's text redacted and truncated", async () => {
		await failGlossyBuildActivity({
			...REF,
			code: "BUILD_FAILED",
			detail: SECRET_DETAIL,
		});

		const [, logged] = warn.mock.calls[0] as [string, { detail: string }];
		expect(logged.detail).not.toContain("sk-proj");
		expect(logged.detail).not.toContain("llm-gateway.internal");
		expect(logged.detail).not.toContain("abcdefghijklmnop");
		expect(logged.detail.length).toBeLessThanOrEqual(300);
		expect(logged.detail).toContain("Provider call failed");
	});

	it("keeps each verdict code and maps anything else to BUILD_FAILED", async () => {
		await failGlossyBuildActivity({
			...REF,
			code: "AI_PROVIDER_NOT_CONFIGURED",
		});
		await failGlossyBuildActivity({ ...REF, code: "TypeError" });

		expect(
			database.failGlossyBuild.mock.calls.map(([call]) => call),
		).toEqual([
			{
				buildId: "build-1",
				errorCode: "AI_PROVIDER_NOT_CONFIGURED",
				errorMessage: "Configure an AI provider.",
			},
			{
				buildId: "build-1",
				errorCode: "BUILD_FAILED",
				errorMessage: GLOSSY_BUILD_FAILURE_MESSAGES.BUILD_FAILED,
			},
		]);
	});

	it("records build_failed with the code once the write applied", async () => {
		await expect(
			failGlossyBuildActivity({ ...REF, code: "ACCESS_REVOKED" }),
		).resolves.toEqual({ outcome: "applied", code: "ACCESS_REVOKED" });

		expect(database.recordAudit).toHaveBeenCalledWith({
			action: "project.glossy_edition.build_failed",
			category: "project",
			severity: "warning",
			outcome: "failure",
			actor: { type: "user", userId: "user-1" },
			organizationId: "org-1",
			projectId: "proj-1",
			resource: { type: "project_document", id: "doc-1" },
			metadata: { buildId: "build-1", errorCode: "ACCESS_REVOKED" },
		});
	});

	it("marks its own attempt superseded and records nothing when the claim is gone", async () => {
		database.failGlossyBuild.mockResolvedValue("superseded");

		await expect(
			failGlossyBuildActivity({ ...REF, code: "NOT_ELIGIBLE" }),
		).resolves.toEqual({ outcome: "superseded", code: "NOT_ELIGIBLE" });
		expect(database.markGlossyBuildSuperseded).toHaveBeenCalledWith(
			"build-1",
		);
		expect(database.recordAudit).not.toHaveBeenCalled();
	});
});

describe("redactGlossyFailureDetail", () => {
	it("returns null for no detail", () => {
		expect(redactGlossyFailureDetail(undefined)).toBeNull();
		expect(redactGlossyFailureDetail("")).toBeNull();
	});

	it("removes URLs, key-shaped tokens, and what the log redactor covers", () => {
		const redacted = redactGlossyFailureDetail(
			"fetch https://10.0.0.5:8443/admin failed for dev@example.com with rk-live_1234567890abcdef",
		);
		expect(redacted).toBe(
			"fetch [URL] failed for [REDACTED] with [REDACTED]",
		);
	});
});
