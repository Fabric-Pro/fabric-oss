import { describe, expect, it, vi } from "vitest";

const m = vi.hoisted(() => ({ audit: vi.fn() }));
vi.mock("../../../lib/request-span", () => ({ flushSpansOnFailure: vi.fn() }));
vi.mock("@repo/database", async (importOriginal) => ({
	...(await importOriginal<Record<string, unknown>>()),
	recordAudit: m.audit,
	hasOrganizationTie: vi.fn().mockResolvedValue(true),
}));
vi.mock("@repo/auth/lib/client-ip", () => ({
	getTrustedClientIp: () => "203.0.113.42",
}));
vi.mock("@repo/auth", () => ({
	auth: { api: { getSession: vi.fn().mockResolvedValue(null) } },
}));
vi.mock("@repo/observability", () => ({
	auditWriteFailures: { inc: vi.fn() },
	auditWritesTotal: { inc: vi.fn() },
}));

import {
	__captureErrorForTest,
	__redactBodyFieldsForTest,
} from "../audit-error-middleware";

const privateText =
	"Example private authoring body that must not appear in audit";
describe("Skills authoring error audit keeps source bodies private", () => {
	it.each(["skills.create", "skills.update"])(
		"summarizes %s content and description while retaining identity/version",
		(path) => {
			const input = {
				id: "example-skill",
				expectedVersion: 2,
				content: privateText,
				description: privateText,
			};
			const safe = __redactBodyFieldsForTest(path, input);
			expect(JSON.stringify(safe)).not.toContain(privateText);
			expect(safe).toMatchObject({
				id: "example-skill",
				expectedVersion: 2,
			});
			expect(input.content).toBe(privateText);
		},
	);
	it("does not copy private draft or conversation messages into assistance failure capture", () => {
		const input = {
			organizationId: "example-org",
			draft: { content: privateText, name: privateText },
			message: privateText,
			history: [{ role: "user", content: privateText }],
		};
		const safe = __redactBodyFieldsForTest("skills.assist", input);
		expect(JSON.stringify(safe)).not.toContain(privateText);
		expect(safe).toEqual({ redacted: true });
	});
	it.each([
		"skills.import.preview",
		"skills.import.create",
		"skills.import.readFile",
	])(
		"summarizes %s source URLs and base64, including malformed sources",
		(path) => {
			for (const source of [
				{ kind: "file", base64: privateText },
				{ kind: "github", url: `https://example.com/${privateText}` },
				privateText,
			]) {
				const safe = __redactBodyFieldsForTest(path, {
					source,
					candidateKey: "example/SKILL.md",
					expectedHash: "a".repeat(64),
					overrides: { description: privateText },
				});
				expect(JSON.stringify(safe)).not.toContain(privateText);
				expect(safe).toEqual({ redacted: true });
			}
		},
	);
	it("never copies validation/provider error text, causes or stacks for confidential authoring routes", async () => {
		vi.stubEnv("FABRIC_AUDIT_ERROR_CAPTURE_DISABLED", "");
		vi.stubEnv("FABRIC_AUDIT_ERROR_CAPTURE_SKIP_PATHS", "");
		m.audit.mockClear();
		const input = {
			source: { base64: privateText },
			unexpected: privateText,
		};
		await __captureErrorForTest(
			new Error(privateText, { cause: new Error(privateText) }),
			{
				headers: new Headers(),
				user: { id: "example-user" },
				session: {
					id: "example-session",
					activeOrganizationId: "example-org",
					impersonatedBy: null,
				},
			},
			input,
			["skills", "import", "preview"],
		);
		const captured = m.audit.mock.calls[0]?.[0];
		expect(captured).toBeDefined();
		expect(captured.metadata.input).toEqual({ redacted: true });
		expect(captured.metadata.exception.message).toBe(
			"Skill authoring failed.",
		);
		expect(captured.metadata).not.toHaveProperty("cause");
		expect(captured.metadata.exception).not.toHaveProperty("stacktrace");
		expect(JSON.stringify(captured)).not.toContain(privateText);
		vi.unstubAllEnvs();
	});
});
