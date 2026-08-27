import { describe, expect, it } from "vitest";
import {
	CreateSessionParamsSchema,
	SessionResultSchema,
	SessionStatusSchema,
	validateCreateSessionParams,
	validateSessionStatus,
} from "../src/lib/coding-execution/schemas";

describe("coding execution schemas", () => {
	describe("CreateSessionParamsSchema", () => {
		it("validates valid params", () => {
			const params = {
				repoOwner: "acme",
				repoName: "my-project",
				projectName: "My Project",
				workingDirectory: "/tmp/projects/my-project",
			};

			const result = CreateSessionParamsSchema.safeParse(params);
			expect(result.success).toBe(true);
			if (result.success) {
				expect(result.data.repoOwner).toBe("acme");
				expect(result.data.repoName).toBe("my-project");
			}
		});

		it("requires repoOwner", () => {
			const params = {
				repoName: "my-project",
			};

			const result = CreateSessionParamsSchema.safeParse(params);
			expect(result.success).toBe(false);
			if (!result.success) {
				expect(result.error.issues[0].path).toContain("repoOwner");
			}
		});

		it("requires repoName", () => {
			const params = {
				repoOwner: "acme",
			};

			const result = CreateSessionParamsSchema.safeParse(params);
			expect(result.success).toBe(false);
			if (!result.success) {
				expect(result.error.issues[0].path).toContain("repoName");
			}
		});

		it("rejects empty strings", () => {
			const params = {
				repoOwner: "",
				repoName: "my-project",
			};

			const result = CreateSessionParamsSchema.safeParse(params);
			expect(result.success).toBe(false);
		});

		it("allows optional fields to be undefined", () => {
			const params = {
				repoOwner: "acme",
				repoName: "my-project",
			};

			const result = CreateSessionParamsSchema.safeParse(params);
			expect(result.success).toBe(true);
		});
	});

	describe("SessionStatusSchema", () => {
		it("validates valid session status", () => {
			const status = {
				id: "session-123",
				status: "active" as const,
				branchName: "feature/my-branch",
				artifacts: [
					{
						id: "art-1",
						type: "pull_request",
						url: "https://github.com/acme/my-project/pull/42",
						metadata: { number: 42 },
						createdAt: Date.now(),
					},
				],
			};

			const result = SessionStatusSchema.safeParse(status);
			expect(result.success).toBe(true);
		});

		it("accepts all valid status values", () => {
			const validStatuses = [
				"created",
				"active",
				"completed",
				"failed",
				"stopped",
				"archived",
			] as const;

			for (const status of validStatuses) {
				const result = SessionStatusSchema.safeParse({
					id: "session-123",
					status,
					branchName: null,
					artifacts: [],
				});
				expect(result.success).toBe(true);
			}
		});

		it("rejects invalid status values", () => {
			const result = SessionStatusSchema.safeParse({
				id: "session-123",
				status: "invalid_status",
				branchName: null,
				artifacts: [],
			});
			expect(result.success).toBe(false);
		});

		it("allows null branchName", () => {
			const result = SessionStatusSchema.safeParse({
				id: "session-123",
				status: "created",
				branchName: null,
				artifacts: [],
			});
			expect(result.success).toBe(true);
		});

		it("allows empty artifacts array", () => {
			const result = SessionStatusSchema.safeParse({
				id: "session-123",
				status: "created",
				branchName: null,
				artifacts: [],
			});
			expect(result.success).toBe(true);
		});
	});

	describe("SessionResultSchema", () => {
		it("validates minimal session result", () => {
			const result = SessionResultSchema.safeParse({
				sessionId: "sess-123",
			});
			expect(result.success).toBe(true);
		});

		it("validates full session result", () => {
			const result = SessionResultSchema.safeParse({
				sessionId: "sess-123",
				externalUrl: "https://example.com/sessions/sess-123",
				externalStatus: "created",
				providerMetadata: { key: "value" },
			});
			expect(result.success).toBe(true);
		});

		it("requires sessionId", () => {
			const result = SessionResultSchema.safeParse({});
			expect(result.success).toBe(false);
		});
	});

	describe("validateCreateSessionParams", () => {
		it("returns validated params on success", () => {
			const params = {
				repoOwner: "acme",
				repoName: "my-project",
			};

			const result = validateCreateSessionParams(params);
			expect(result.repoOwner).toBe("acme");
			expect(result.repoName).toBe("my-project");
		});

		it("throws on invalid params", () => {
			const params = {
				repoName: "my-project",
			};

			expect(() => validateCreateSessionParams(params)).toThrow(
				"Invalid session params",
			);
		});
	});

	describe("validateSessionStatus", () => {
		it("returns validated status on success", () => {
			const status = {
				id: "session-123",
				status: "active" as const,
				branchName: "feature/test",
				artifacts: [],
			};

			const result = validateSessionStatus(status);
			expect(result.id).toBe("session-123");
			expect(result.status).toBe("active");
		});

		it("throws on invalid status", () => {
			const status = {
				id: "session-123",
				status: "invalid",
				branchName: null,
				artifacts: [],
			};

			expect(() => validateSessionStatus(status)).toThrow(
				"Invalid session status",
			);
		});
	});
});
