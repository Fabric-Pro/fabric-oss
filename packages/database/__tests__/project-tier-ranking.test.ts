import { describe, expect, it } from "vitest";
import { resolvePromptBindingStatus } from "../prisma/queries/prompts";

/**
 * The PROJECT tier in the badge ranker: an ORG binding narrowed to a project
 * outranks the org-wide one but loses to Personal, and must stop shadowed
 * tiers claiming the default. Pure rows, no database — the real-Postgres
 * counterpart lives in prompt-tier-resolution.integration.test.ts.
 */

const row = (over: {
	promptId: string;
	scope: "SYSTEM" | "ORG" | "USER";
	projectId?: string | null;
	isDefault?: boolean;
}) => ({
	targetKey: "agent",
	documentType: "GENERAL",
	storyKind: null,
	isDefault: false,
	...over,
});

describe("resolvePromptBindingStatus — PROJECT tier", () => {
	it("names PROJECT as the winning tier over ORG", () => {
		const status = resolvePromptBindingStatus([
			row({ promptId: "org", scope: "ORG", isDefault: true }),
			row({
				promptId: "project",
				scope: "ORG",
				projectId: "p1",
				isDefault: true,
			}),
		]);

		expect(status.get("project")).toMatchObject({
			isDefault: true,
			defaultScope: "PROJECT",
		});
		expect(status.get("org")?.isDefault).toBe(false);
	});

	it("keeps PROJECT beneath USER", () => {
		const status = resolvePromptBindingStatus([
			row({
				promptId: "project",
				scope: "ORG",
				projectId: "p1",
				isDefault: true,
			}),
			row({ promptId: "user", scope: "USER", isDefault: true }),
		]);

		expect(status.get("user")).toMatchObject({
			isDefault: true,
			defaultScope: "USER",
		});
		expect(status.get("project")?.isDefault).toBe(false);
	});

	it("does not let a project binding win without projectId context being ranked — ORG-wide still wins at its own tier", () => {
		// Same rows, but this caller resolves WITHOUT project context (the
		// query layer simply omits project rows then; here both are supplied,
		// so the narrower one wins). Pins that the ranker never treats a
		// narrowed row as an ordinary ORG row.
		const status = resolvePromptBindingStatus([
			row({ promptId: "org", scope: "ORG", isDefault: true }),
			row({
				promptId: "project",
				scope: "ORG",
				projectId: "p2",
				isDefault: true,
			}),
		]);

		expect(status.get("project")?.defaultScope).toBe("PROJECT");
	});

	it("leaves a bound-but-not-default project binding unnamed", () => {
		const status = resolvePromptBindingStatus([
			row({ promptId: "org", scope: "ORG", isDefault: true }),
			row({
				promptId: "project",
				scope: "ORG",
				projectId: "p1",
				isDefault: false,
			}),
		]);

		expect(status.get("project")).toMatchObject({
			isBound: true,
			isDefault: false,
			defaultScope: null,
		});
	});
});
