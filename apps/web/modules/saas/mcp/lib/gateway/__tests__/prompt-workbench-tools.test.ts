import { beforeEach, expect, it, vi } from "vitest";
import type { GatewaySession } from "../types";

const m = vi.hoisted(() => ({
	assist: vi.fn(),
	preview: vi.fn(),
	getResponse: vi.fn(),
	updateResponse: vi.fn(),
}));
vi.mock("@repo/api/modules/prompts/lib/workbench", () => ({
	assistPrompt: m.assist,
	tryPrompt: m.preview,
	getPromptResponse: m.getResponse,
	updatePromptResponse: m.updateResponse,
}));

import { createPromptWorkbenchTools } from "../tools/prompt-workbench-tools";

const family = createPromptWorkbenchTools();
const session = {
	userId: "example-user",
	organizationId: "example-org",
	credential: "api-key",
	scopes: ["prompts:read", "prompts:write"],
} as GatewaySession;
const input = { draft: { content: "Reply briefly" } };
beforeEach(() => {
	vi.clearAllMocks();
	m.preview.mockResolvedValue({ output: "actual preview" });
});
it("declares non-idempotent previews and confirmation for model spending", () => {
	expect(
		family.definitions.find((t) => t.name === "fabric_preview_prompt"),
	).toMatchObject({
		annotations: { idempotentHint: false },
		_meta: expect.any(Object),
	});
	expect(family.scopes.fabric_preview_prompt.scope).toBe("prompts:read");
});
it("propagates the resolved current actor instead of client-supplied identity", async () => {
	const result = await family.handlers.get("fabric_preview_prompt")?.(
		input,
		session,
	);
	expect(result.isError).not.toBe(true);
	expect(m.preview).toHaveBeenCalledWith(
		{ userId: "example-user", organizationId: "example-org" },
		expect.objectContaining({
			draft: expect.objectContaining({ content: "Reply briefly" }),
		}),
	);
});
it.each([
	{ scopes: ["mcp:*"] },
	{ scopes: [] },
	{ organizationId: null },
	{ projectId: "example-project" },
	{ pinnedProjectId: "example-project" },
	{ pageProjectId: "example-project" },
	{ credential: "service" },
])("fails closed for constrained credentials: %j", async (patch) => {
	const result = await family.handlers.get("fabric_preview_prompt")?.(input, {
		...session,
		...patch,
	} as GatewaySession);
	expect(result.isError).toBe(true);
	expect(m.preview).not.toHaveBeenCalled();
});
it("refuses authority overrides in the input", async () => {
	const result = await family.handlers.get("fabric_preview_prompt")?.(
		{ ...input, organizationId: "other-org" },
		session,
	);
	expect(result.isError).toBe(true);
	expect(m.preview).not.toHaveBeenCalled();
});
it("registers response settings as an audited mutation and keeps current identity server-derived", async () => {
	const name = "fabric_update_prompt_response";
	expect(
		family.definitions.find((tool) => tool.name === name)?.annotations
			?.readOnlyHint,
	).toBe(false);
	m.updateResponse.mockResolvedValue({ versionId: "example-v2" });
	const result = await family.handlers.get(name)?.(
		{ promptId: "example-prompt", responseContract: { format: "XML" } },
		session,
	);
	expect(result.isError).not.toBe(true);
	expect(m.updateResponse).toHaveBeenCalledWith(
		{ userId: session.userId, organizationId: session.organizationId },
		{ promptId: "example-prompt", responseContract: { format: "XML" } },
	);
	const denied = await family.handlers.get(name)?.(
		{ promptId: "example-prompt", responseContract: { format: "XML" } },
		{ ...session, scopes: ["prompts:read"] },
	);
	expect(denied.isError).toBe(true);
	expect(m.updateResponse).toHaveBeenCalledOnce();
});
