/**
 * Unit tests for the audit-error sanitizers (D16).
 *
 * Coverage:
 *  - `sanitizeStack`: strips node_modules / node internals / absolute
 *    repo root, normalises path separators, caps at 30 frames, drops
 *    the header line.
 *  - `buildException`: returns OTEL-shaped { type, message, stacktrace }.
 *  - `extractCauseChain`: walks `.cause` recursively, caps at depth 5.
 *  - `sanitizeInput`: redacts sensitive keys, handles circular refs,
 *    truncates over 8 KiB, returns undefined for undefined input.
 *  - `computeFingerprint`: stable hash, type-sensitive.
 */

import { describe, expect, it } from "vitest";
import {
	buildException,
	computeFingerprint,
	extractCauseChain,
	sanitizeInput,
	sanitizeStack,
} from "../audit-error-sanitize";

describe("sanitizeStack", () => {
	it("returns undefined for undefined input", () => {
		expect(sanitizeStack(undefined)).toBeUndefined();
	});

	it("returns undefined for empty input", () => {
		expect(sanitizeStack("")).toBeUndefined();
	});

	it("drops the leading error-header line", () => {
		const stack = "Error: kaboom\n    at foo (/repo/src/foo.ts:1:1)";
		const result = sanitizeStack(stack, "/repo");
		expect(result).toBeDefined();
		expect(result?.[0]).not.toContain("Error:");
		expect(result?.[0]).toContain("foo");
	});

	it("strips repo-root prefix", () => {
		const repoRoot = "/tmp/fabric";
		const stack =
			"Error: x\n    at handler (/tmp/fabric/packages/api/foo.ts:1:1)";
		const result = sanitizeStack(stack, repoRoot);
		expect(result).toBeDefined();
		expect(result?.[0]).toContain("packages/api/foo.ts");
		expect(result?.[0]).not.toContain("/tmp/fabric/packages");
	});

	it("drops node_modules frames", () => {
		const stack = [
			"Error: x",
			"    at userCode (/repo/src/foo.ts:1:1)",
			"    at libCode (/repo/node_modules/some-pkg/dist/lib.js:1:1)",
			"    at moreUser (/repo/src/bar.ts:1:1)",
		].join("\n");
		const result = sanitizeStack(stack, "/repo");
		expect(result).toBeDefined();
		expect(result!.some((f) => f.includes("node_modules"))).toBe(false);
		expect(result!.length).toBe(2);
	});

	it("drops node internal frames", () => {
		const stack = [
			"Error: x",
			"    at user (/repo/src/foo.ts:1:1)",
			"    at process.processTicksAndRejections (node:internal/process/task_queues:96:5)",
		].join("\n");
		const result = sanitizeStack(stack, "/repo");
		expect(result).toBeDefined();
		expect(result!.some((f) => f.includes("node:"))).toBe(false);
	});

	it("normalises Windows backslashes to forward slashes", () => {
		const stack = "Error: x\n    at handler (C:\\repo\\src\\foo.ts:1:1)";
		const result = sanitizeStack(stack, "C:\\repo");
		expect(result).toBeDefined();
		expect(result?.[0]).toContain("src/foo.ts");
		expect(result?.[0]).not.toContain("\\");
	});

	it("caps at 30 frames", () => {
		const frames = Array.from(
			{ length: 50 },
			(_, i) => `    at handler${i} (/repo/src/file${i}.ts:1:1)`,
		);
		const stack = ["Error: x", ...frames].join("\n");
		const result = sanitizeStack(stack, "/repo");
		expect(result).toBeDefined();
		expect(result!.length).toBe(30);
	});
});

describe("buildException", () => {
	it("captures Error type/message/stack", () => {
		const err = new Error("test error");
		const result = buildException(err);
		expect(result.type).toBe("Error");
		expect(result.message).toBe("test error");
		expect(result.stacktrace).toBeDefined();
	});

	it("uses constructor name when type is missing", () => {
		class CustomError extends Error {
			constructor(message: string) {
				super(message);
				this.name = "CustomError";
			}
		}
		const err = new CustomError("oh no");
		const result = buildException(err);
		expect(result.type).toBe("CustomError");
	});

	it("survives a plain non-error object", () => {
		const result = buildException({ message: "literal" });
		expect(result.message).toBe("literal");
	});

	it("survives a primitive thrown value", () => {
		const result = buildException("string thrown");
		expect(result.message).toBe("string thrown");
	});

	it("truncates an oversize message", () => {
		const huge = "x".repeat(5000);
		const err = new Error(huge);
		const result = buildException(err);
		expect(result.message.length).toBeLessThanOrEqual(1024);
		expect(result.message.endsWith("…")).toBe(true);
	});
});

describe("extractCauseChain", () => {
	it("returns undefined when no cause exists", () => {
		const err = new Error("a");
		expect(extractCauseChain(err)).toBeUndefined();
	});

	it("captures a single-level cause", () => {
		const inner = new Error("inner");
		const outer = new Error("outer");
		(outer as { cause: unknown }).cause = inner;
		const chain = extractCauseChain(outer);
		expect(chain).toBeDefined();
		expect(chain?.message).toBe("inner");
	});

	it("walks a multi-level cause chain", () => {
		const level3 = new Error("level3");
		const level2 = new Error("level2");
		(level2 as { cause: unknown }).cause = level3;
		const level1 = new Error("level1");
		(level1 as { cause: unknown }).cause = level2;
		const outer = new Error("outer");
		(outer as { cause: unknown }).cause = level1;

		const chain = extractCauseChain(outer);
		expect(chain).toBeDefined();
		expect(chain?.message).toBe("level1");
		expect(chain?.cause?.message).toBe("level2");
		expect(chain?.cause?.cause?.message).toBe("level3");
	});

	it("caps the cause-chain at depth 5", () => {
		// Build a chain 10 deep — only the first 5 should appear.
		let prev: Error | null = null;
		for (let i = 0; i < 10; i++) {
			const err = new Error(`level-${i}`);
			if (prev) {
				(err as { cause: unknown }).cause = prev;
			}
			prev = err;
		}
		const top = new Error("top");
		(top as { cause: unknown }).cause = prev!;

		let depth = 0;
		let cursor = extractCauseChain(top);
		while (cursor?.cause) {
			depth++;
			cursor = cursor.cause;
		}
		// Maximum 5 cause hops (the initial `cause` plus 4 nested).
		expect(depth).toBeLessThanOrEqual(5);
	});
});

describe("sanitizeInput", () => {
	it("returns undefined for undefined input", () => {
		expect(sanitizeInput(undefined)).toBeUndefined();
	});

	it("preserves null", () => {
		expect(sanitizeInput(null)).toBeNull();
	});

	it("redacts sensitive keys", () => {
		const result = sanitizeInput({
			username: "alice",
			password: "secret123",
			apiKey: "sk-abc",
		}) as Record<string, unknown>;
		expect(result.username).toBe("alice");
		expect(result.password).toBe("[REDACTED]");
		expect(result.apiKey).toBe("[REDACTED]");
	});

	it("handles circular references without crashing", () => {
		const a: Record<string, unknown> = { name: "a" };
		const b: Record<string, unknown> = { name: "b" };
		a.next = b;
		b.next = a;
		const result = sanitizeInput(a);
		expect(result).toBeDefined();
		// Circular refs are converted to "[Circular]" by safeStringify.
		const serialized = JSON.stringify(result);
		expect(serialized).toContain("[Circular]");
	});

	it("truncates payloads over 8 KiB", () => {
		const big = { data: "x".repeat(9000) };
		const result = sanitizeInput(big) as Record<string, unknown>;
		// Over budget → wrapped in `_truncated`.
		expect(result._truncated).toBeDefined();
		expect((result._truncated as string).endsWith("…")).toBe(true);
	});

	it("preserves a small payload as parsed JSON", () => {
		const result = sanitizeInput({ a: 1, b: "hello" }) as Record<
			string,
			unknown
		>;
		expect(result.a).toBe(1);
		expect(result.b).toBe("hello");
	});
});

describe("computeFingerprint", () => {
	it("produces a 16-char hex string", () => {
		const fp = computeFingerprint(
			"Error",
			"INTERNAL_SERVER_ERROR",
			"at foo",
		);
		expect(fp).toMatch(/^[0-9a-f]{16}$/);
	});

	it("is stable for identical input", () => {
		const a = computeFingerprint("Error", "INTERNAL", "at foo");
		const b = computeFingerprint("Error", "INTERNAL", "at foo");
		expect(a).toBe(b);
	});

	it("differs when type differs", () => {
		const a = computeFingerprint("Error", "X", "at foo");
		const b = computeFingerprint("TypeError", "X", "at foo");
		expect(a).not.toBe(b);
	});

	it("differs when topFrame differs", () => {
		const a = computeFingerprint("Error", "X", "at foo");
		const b = computeFingerprint("Error", "X", "at bar");
		expect(a).not.toBe(b);
	});

	it("handles missing topFrame", () => {
		const fp = computeFingerprint("Error", "X", undefined);
		expect(fp).toMatch(/^[0-9a-f]{16}$/);
	});
});
