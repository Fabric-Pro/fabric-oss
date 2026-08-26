import { describe, expect, it } from "vitest";
import { SessionValidationError } from "../src/lib/coding-execution/errors";
import {
	redactSensitiveData,
	sanitizeBranchName,
	sanitizeErrorMessage,
	validateBackgroundAgentsUrl,
	validateWorkingDirectory,
} from "../src/lib/coding-execution/security";

describe("security utilities", () => {
	describe("sanitizeBranchName", () => {
		it("allows valid branch names", () => {
			const validNames = [
				"main",
				"feature/my-feature",
				"bugfix/issue-123",
				"release/v1.0.0",
				"hotfix/emergency_fix",
				"user/feature_name-123",
			];

			for (const name of validNames) {
				expect(sanitizeBranchName(name, "KANBAN_LOCAL")).toBe(name);
			}
		});

		it("trims whitespace", () => {
			expect(sanitizeBranchName("  main  ", "KANBAN_LOCAL")).toBe("main");
		});

		it("rejects empty branch names", () => {
			expect(() => sanitizeBranchName("", "KANBAN_LOCAL")).toThrow(
				SessionValidationError,
			);
			expect(() => sanitizeBranchName("   ", "KANBAN_LOCAL")).toThrow(
				SessionValidationError,
			);
		});

		it("rejects branch names with shell metacharacters", () => {
			const dangerous = [
				"main; rm -rf /",
				"$(whoami)",
				"`cat /etc/passwd`",
				"main && evil",
				"main || evil",
				"main | cat",
				"main; cat /etc/passwd",
				"../etc/passwd",
				"..",
				"...",
			];

			for (const name of dangerous) {
				expect(() => sanitizeBranchName(name, "KANBAN_LOCAL")).toThrow(
					SessionValidationError,
				);
			}
		});

		it("rejects reserved branch names", () => {
			expect(() => sanitizeBranchName("HEAD", "KANBAN_LOCAL")).toThrow(
				SessionValidationError,
			);
			expect(() =>
				sanitizeBranchName("FETCH_HEAD", "KANBAN_LOCAL"),
			).toThrow(SessionValidationError);
		});

		it("rejects branch names starting/ending with special chars", () => {
			expect(() => sanitizeBranchName("/main", "KANBAN_LOCAL")).toThrow();
			expect(() => sanitizeBranchName("main/", "KANBAN_LOCAL")).toThrow();
			expect(() => sanitizeBranchName(".main", "KANBAN_LOCAL")).toThrow();
			expect(() => sanitizeBranchName("main.", "KANBAN_LOCAL")).toThrow();
		});

		it("rejects branch names with consecutive slashes", () => {
			expect(() =>
				sanitizeBranchName("feature//subtask", "KANBAN_LOCAL"),
			).toThrow(SessionValidationError);
		});

		it("rejects branch names that are too long", () => {
			const longName = "a".repeat(256);
			expect(() => sanitizeBranchName(longName, "KANBAN_LOCAL")).toThrow(
				SessionValidationError,
			);
		});
	});

	describe("validateWorkingDirectory", () => {
		it("allows paths within base directory", () => {
			const baseDir = "/home/user/projects";
			const workingDirectory = "/home/user/projects/my-app";
			const result = validateWorkingDirectory(
				workingDirectory,
				"KANBAN_LOCAL",
				baseDir,
			);
			expect(result).toBe(path.resolve(workingDirectory));
		});

		it("resolves relative paths", () => {
			// Using process.cwd() as base
			const result = validateWorkingDirectory(
				"./my-project",
				"KANBAN_LOCAL",
				process.cwd(),
			);
			expect(result).toBe(path.resolve("./my-project"));
		});

		it("rejects paths outside base directory", () => {
			const baseDir = "/home/user/projects";
			expect(() =>
				validateWorkingDirectory(
					"/etc/passwd",
					"KANBAN_LOCAL",
					baseDir,
				),
			).toThrow(SessionValidationError);
			expect(() =>
				validateWorkingDirectory(
					"/home/user/projects/../etc",
					"KANBAN_LOCAL",
					baseDir,
				),
			).toThrow(SessionValidationError);
		});

		it("rejects paths with null bytes", () => {
			expect(() =>
				validateWorkingDirectory("/path/with\x00null", "KANBAN_LOCAL"),
			).toThrow(SessionValidationError);
		});

		it("rejects paths with shell metacharacters", () => {
			const dangerousPaths = [
				"/path; rm -rf /",
				"/path | cat",
				"/path && evil",
				"/path`whoami`",
				"/path$(cmd)",
			];

			for (const pathStr of dangerousPaths) {
				expect(() =>
					validateWorkingDirectory(pathStr, "KANBAN_LOCAL"),
				).toThrow(SessionValidationError);
			}
		});

		it("rejects empty paths", () => {
			expect(() => validateWorkingDirectory("", "KANBAN_LOCAL")).toThrow(
				SessionValidationError,
			);
			expect(() =>
				validateWorkingDirectory("   ", "KANBAN_LOCAL"),
			).toThrow(SessionValidationError);
		});
	});

	describe("redactSensitiveData", () => {
		it("redacts sensitive fields", () => {
			const data = {
				name: "test",
				apiKey: "secret-key-123",
				token: "bearer-token-456",
				password: "my-password",
				secret: "top-secret",
				normalField: "visible",
			};

			const result = redactSensitiveData(data);

			expect(result.name).toBe("test");
			expect(result.normalField).toBe("visible");
			// Verify redaction format - actual lengths depend on input
			expect(result.apiKey).toMatch(/\[REDACTED:\d+chars\]/);
			expect(result.token).toMatch(/\[REDACTED:\d+chars\]/);
			expect(result.password).toMatch(/\[REDACTED:\d+chars\]/);
			expect(result.secret).toMatch(/\[REDACTED:\d+chars\]/);
			// Ensure original values are not present
			expect(result.apiKey).not.toContain("secret-key");
			expect(result.token).not.toContain("bearer-token");
			expect(result.password).not.toContain("my-password");
			expect(result.secret).not.toContain("top-secret");
		});

		it("redacts non-string sensitive values", () => {
			const data = {
				apiKey: 12345,
				normal: "visible",
			};

			const result = redactSensitiveData(data);
			expect(result.apiKey).toBe("[REDACTED]");
			expect(result.normal).toBe("visible");
		});

		it("recursively redacts nested objects", () => {
			const data = {
				config: {
					apiKey: "nested-secret",
					name: "visible",
				},
				auth: {
					token: "auth-token",
				},
			};

			const result = redactSensitiveData(data);
			// Verify nested config object is sanitized
			expect(result.config).toBeDefined();
			const config = result.config as Record<string, unknown>;
			expect(config.apiKey).toMatch(/\[REDACTED:\d+chars\]/);
			expect(config.apiKey).not.toContain("nested-secret");
			expect(config.name).toBe("visible");
			// Verify nested auth object is sanitized (stringify to check entire structure)
			const resultStr = JSON.stringify(result);
			expect(resultStr).not.toContain("auth-token");
			expect(resultStr).toMatch(/\[REDACTED:\d+chars\]/g);
		});

		it("does not recurse into arrays", () => {
			const data = {
				items: ["apiKey", "token", "secret"],
				normal: "visible",
			};

			const result = redactSensitiveData(data);
			expect(result.items).toEqual(["apiKey", "token", "secret"]);
			expect(result.normal).toBe("visible");
		});
	});

	describe("validateBackgroundAgentsUrl", () => {
		it("allows valid HTTPS URLs", () => {
			// In non-production mode, localhost is allowed
			const originalEnv = process.env.NODE_ENV;
			process.env.NODE_ENV = "development";

			expect(() =>
				validateBackgroundAgentsUrl("https://agents.example.com"),
			).not.toThrow();
			expect(() =>
				validateBackgroundAgentsUrl("http://localhost:3000"),
			).not.toThrow();

			process.env.NODE_ENV = originalEnv;
		});

		it("rejects URLs with credentials in production", () => {
			const originalEnv = process.env.NODE_ENV;
			process.env.NODE_ENV = "production";

			expect(() =>
				validateBackgroundAgentsUrl("https://user:pass@example.com"),
			).toThrow(SessionValidationError);

			process.env.NODE_ENV = originalEnv;
		});

		it("rejects localhost in production", () => {
			const originalEnv = process.env.NODE_ENV;
			process.env.NODE_ENV = "production";

			expect(() =>
				validateBackgroundAgentsUrl("http://localhost:3000"),
			).toThrow(SessionValidationError);
			expect(() =>
				validateBackgroundAgentsUrl("http://127.0.0.1:3000"),
			).toThrow(SessionValidationError);

			process.env.NODE_ENV = originalEnv;
		});

		it("rejects private IPs in production", () => {
			const originalEnv = process.env.NODE_ENV;
			process.env.NODE_ENV = "production";

			const privateUrls = [
				"https://10.0.0.1",
				"https://172.16.0.1",
				"https://192.168.1.1",
				"https://169.254.1.1",
			];

			for (const url of privateUrls) {
				expect(() => validateBackgroundAgentsUrl(url)).toThrow(
					SessionValidationError,
				);
			}

			process.env.NODE_ENV = originalEnv;
		});

		it("rejects HTTP in production", () => {
			const originalEnv = process.env.NODE_ENV;
			process.env.NODE_ENV = "production";

			expect(() =>
				validateBackgroundAgentsUrl("http://example.com"),
			).toThrow(SessionValidationError);

			process.env.NODE_ENV = originalEnv;
		});

		it("rejects suspicious URL patterns", () => {
			expect(() =>
				validateBackgroundAgentsUrl("https://example.com@evil.com"),
			).toThrow(SessionValidationError);
			expect(() =>
				validateBackgroundAgentsUrl("https://example.com/path\x00"),
			).toThrow(SessionValidationError);
		});
	});

	describe("sanitizeErrorMessage", () => {
		it("returns full message in development", () => {
			const error = new Error("Something failed at /path/to/file");
			const result = sanitizeErrorMessage(error, false);
			expect(result).toContain("Something failed");
		});

		it("redacts secrets in development messages", () => {
			const error = new Error("Failed with apiKey: super-secret-value");
			const result = sanitizeErrorMessage(error, false);
			expect(result).toContain("[REDACTED]");
			expect(result).not.toContain("super-secret-value");
		});

		it("returns generic messages in production", () => {
			const error = new Error("Detailed error with paths and secrets");
			const result = sanitizeErrorMessage(error, true);
			expect(result).toBe(
				"An error occurred while processing your request",
			);
		});

		it("returns specific generic messages for known errors", () => {
			const notFoundError = new Error("Not found") as Error & {
				code: string;
			};
			notFoundError.code = "ENOENT";
			expect(sanitizeErrorMessage(notFoundError, true)).toBe(
				"Resource not found",
			);

			const permError = new Error("Permission denied") as Error & {
				code: string;
			};
			permError.code = "EACCES";
			expect(sanitizeErrorMessage(permError, true)).toBe(
				"Permission denied",
			);
		});
	});
});

import path from "node:path";
