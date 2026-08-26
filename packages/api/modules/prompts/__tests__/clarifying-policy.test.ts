import { beforeEach, describe, expect, it, vi } from "vitest";
import { z } from "zod";

// Mock the bound-prompt resolver the procedure delegates to.
const { getBoundPromptForAgent } = vi.hoisted(() => ({
	getBoundPromptForAgent: vi.fn(),
}));

vi.mock("@repo/database/prisma/queries/prompts", () => ({
	getBoundPromptForAgent,
	listAvailablePromptsForAgent: vi.fn(),
}));

vi.mock("@repo/database", () => ({
	StoryKindSchema: z.enum(["FEATURE", "BUG"]),
}));

vi.mock("@repo/logs", () => ({
	logger: { info: vi.fn(), warn: vi.fn(), error: vi.fn() },
}));

vi.mock("../../../orpc/procedures", () => {
	const builder: Record<string, unknown> = {};
	builder.use = () => builder;
	builder.route = () => builder;
	builder.input = () => builder;
	builder.output = () => builder;
	builder.handler = (fn: unknown) => fn;
	return {
		tenantProtectedProcedure: builder,
		requirePermission: () => (next: unknown) => next,
		requireInputOrgPermission: () => (next: unknown) => next,
		resolveOrganizationId: (o: string | null | undefined) => o ?? null,
		Permissions: new Proxy({}, { get: (_t, p) => String(p) }),
	};
});

import { agentsProcedures } from "../procedures/agents";

type Handler = (args: {
	input: Record<string, unknown>;
	context: { user: { id: string }; session: { id: string } };
}) => Promise<{ policy: string | null }>;

const handler = agentsProcedures.clarifyingPolicy as unknown as Handler;
const ctx = { user: { id: "u1" }, session: { id: "s1" } };

beforeEach(() => getBoundPromptForAgent.mockReset());

describe("prompts.agents.clarifyingPolicy", () => {
	it("resolves the editable bound prompt content for the requested tier", async () => {
		getBoundPromptForAgent.mockResolvedValue({
			version: { content: "Edited THOROUGH policy" },
		});
		const res = await handler({
			input: { frequency: "THOROUGH", organizationId: null },
			context: ctx,
		});
		expect(res.policy).toBe("Edited THOROUGH policy");
		expect(getBoundPromptForAgent).toHaveBeenCalledWith(
			expect.objectContaining({
				agentName: "clarifying_questions",
				documentType: "THOROUGH",
				storyKind: null,
			}),
		);
	});

	it("returns null when no prompt is bound (caller falls back to the built-in default)", async () => {
		getBoundPromptForAgent.mockResolvedValue(null);
		const res = await handler({
			input: { frequency: "MINIMAL", organizationId: null },
			context: ctx,
		});
		expect(res.policy).toBeNull();
	});

	it("treats blank content as null", async () => {
		getBoundPromptForAgent.mockResolvedValue({
			version: { content: "   " },
		});
		const res = await handler({
			input: { frequency: "BALANCED", organizationId: null },
			context: ctx,
		});
		expect(res.policy).toBeNull();
	});
});
