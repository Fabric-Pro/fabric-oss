import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import {
	guardOpenApiAttachment,
	OPENAPI_MALFORMED_IN_CHAT,
	OPENAPI_TOO_LARGE_FOR_CHAT,
} from "@saas/shared/components/copilot/openapi-attachment-guard";
import { describe, expect, it } from "vitest";

const spec = (operationCount: number): string => {
	const paths: Record<string, unknown> = {};
	for (let i = 0; i < operationCount; i++) {
		paths[`/thing-${i}`] = {
			get: {
				operationId: `getThing${i}`,
				description: "d".repeat(400),
				responses: { "200": { description: "ok" } },
			},
		};
	}
	return JSON.stringify({
		openapi: "3.0.0",
		info: { title: "Big API", version: "1.0" },
		paths,
	});
};

describe("guardOpenApiAttachment", () => {
	it("does nothing at all when the feature flag is off", () => {
		// Rollback has to cover this surface too. With the feature disabled a
		// spec-shaped attachment must behave exactly as it does today — refusing
		// it here while nothing downstream can do better is a regression the flag
		// is supposed to prevent.
		expect(
			guardOpenApiAttachment({
				filename: "openapi.json",
				content: spec(400),
				budgetedOutcome: {
					status: "truncated",
					sheets: [],
					reason: "budget",
					omittedCharCount: 50_000,
				},
				enabled: false,
			}),
		).toBeNull();
	});

	it("refuses a spec the budget would cut, pointing at project context", () => {
		// The failure this prevents: a truncated spec makes the model deny that
		// the endpoints past the cut exist, with nothing telling the user.
		const outcome = guardOpenApiAttachment({
			filename: "openapi.json",
			content: spec(400),
			budgetedOutcome: {
				status: "truncated",
				sheets: [],
				reason: "budget",
				omittedCharCount: 50_000,
			},
			enabled: true,
		});
		expect(outcome).toEqual({
			status: "failed",
			reason: OPENAPI_TOO_LARGE_FOR_CHAT,
		});
		expect(outcome?.reason).toContain("project's context");
	});

	it("leaves a spec that already fits completely alone", () => {
		expect(
			guardOpenApiAttachment({
				filename: "small.yaml",
				content: spec(2),
				budgetedOutcome: { status: "extracted", sheets: [] },
				enabled: true,
			}),
		).toBeNull();
	});

	it("ignores a large non-spec JSON file", () => {
		// Ordinary JSON keeps today's truncation behaviour — this feature must
		// not change what happens to files it is not about.
		expect(
			guardOpenApiAttachment({
				filename: "package-lock.json",
				content: JSON.stringify({ name: "x", deps: "y".repeat(5000) }),
				budgetedOutcome: {
					status: "truncated",
					sheets: [],
					reason: "budget",
					omittedCharCount: 10,
				},
				enabled: true,
			}),
		).toBeNull();
	});

	it("ignores files that cannot carry a spec", () => {
		expect(
			guardOpenApiAttachment({
				filename: "notes.md",
				content: spec(400),
				budgetedOutcome: {
					status: "truncated",
					sheets: [],
					reason: "budget",
					omittedCharCount: 10,
				},
				enabled: true,
			}),
		).toBeNull();
	});

	it("reports a malformed spec even when it fits", () => {
		const outcome = guardOpenApiAttachment({
			filename: "broken.yaml",
			content: JSON.stringify({ openapi: "3.0.0", info: { title: "x" } }),
			budgetedOutcome: { status: "extracted", sheets: [] },
			enabled: true,
		});
		expect(outcome?.status).toBe("failed");
		expect(outcome?.reason).toContain(OPENAPI_MALFORMED_IN_CHAT);
	});
});

describe("how the chat surface gets the flag", () => {
	const webRoot = join(
		dirname(fileURLToPath(import.meta.url)),
		"..",
		"..",
		"..",
		"..",
		"..",
	);
	const read = (relativePath: string): string =>
		readFileSync(join(webRoot, relativePath), "utf-8");

	it("takes the resolved flag from the provider, never from a NEXT_PUBLIC env var", () => {
		// `NEXT_PUBLIC_*` is inlined by Next.js at build time, so a flag read
		// that way can only change with a redeploy — the admin toggle could
		// never reach it, and neither could a rollback in a hurry. The value
		// has to come from `useFeatureFlag`, which is fed by the server-resolved
		// flags in the app layout.
		const guard = read(
			"modules/saas/shared/components/copilot/openapi-attachment-guard.ts",
		);
		const hook = read(
			"modules/saas/shared/components/copilot/use-copilot-document-upload.ts",
		);

		// Matches a *read*, not a mention: the comment in the guard names the
		// variable it replaced, and that history is worth keeping.
		expect(guard).not.toMatch(/process\.env\.NEXT_PUBLIC_/);
		expect(hook).not.toMatch(/process\.env\.NEXT_PUBLIC_/);
		expect(hook).toContain('useFeatureFlag("OPENAPI_SPEC_CONTEXT")');
	});
});
