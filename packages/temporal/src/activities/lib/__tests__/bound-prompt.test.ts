import { beforeEach, describe, expect, it, vi } from "vitest";

const getBoundPromptForAgent = vi.hoisted(() => vi.fn());

vi.mock("@repo/database", () => ({ getBoundPromptForAgent }));
vi.mock("@repo/logs", () => ({
	logger: { info: vi.fn(), warn: vi.fn(), error: vi.fn() },
}));

import { resolveBoundPromptText } from "../bound-prompt";
import { renderBoundPromptBody } from "../render-bound-prompt-body";

const FALLBACK = "Default for {{subject}}.";
const scope = {
	userId: "user-1",
	organizationId: "org-1",
	projectId: "project-1",
};

function bound(content: string, format = "HANDLEBARS") {
	return {
		id: "prompt-1",
		key: "example_agent",
		name: "Example",
		scope: "ORGANIZATION",
		format,
		version: { id: "v-2", version: 2, content, variables: null },
	};
}

function resolve(overrides: { escape?: boolean } = {}) {
	return resolveBoundPromptText({
		agentKey: "example_agent",
		fallbackBody: FALLBACK,
		variables: { subject: "Q&A" },
		scope,
		...overrides,
	});
}

beforeEach(() => {
	vi.clearAllMocks();
	getBoundPromptForAgent.mockResolvedValue(null);
});

describe("resolveBoundPromptText", () => {
	it("asks the library for the key in the caller's scope", async () => {
		await resolve();

		expect(getBoundPromptForAgent).toHaveBeenCalledExactlyOnceWith({
			agentName: "example_agent",
			documentType: "GENERAL",
			storyKind: null,
			userId: "user-1",
			organizationId: "org-1",
			projectId: "project-1",
		});
	});

	it("renders the bound body and reports its version", async () => {
		getBoundPromptForAgent.mockResolvedValue(
			bound("Bound for {{subject}}."),
		);

		const resolved = await resolve();

		expect(resolved).toMatchObject({
			text: "Bound for Q&amp;A.",
			source: "BOUND",
			promptVersion: 2,
			formatOverridden: false,
		});
		expect(resolved.prompt?.id).toBe("prompt-1");
	});

	it("leaves values unescaped when asked to", async () => {
		getBoundPromptForAgent.mockResolvedValue(
			bound("Bound for {{subject}}."),
		);

		const resolved = await resolve({ escape: false });

		expect(resolved.text).toBe("Bound for Q&A.");
	});

	it("uses the fallback body when nothing is bound", async () => {
		const resolved = await resolve({ escape: false });

		expect(resolved).toMatchObject({
			text: "Default for Q&A.",
			source: "DEFAULT_UNBOUND",
			promptVersion: null,
			prompt: null,
		});
	});

	it("uses the fallback body when the library cannot be read", async () => {
		getBoundPromptForAgent.mockRejectedValue(new Error("db down"));

		const resolved = await resolve({ escape: false });

		expect(resolved).toMatchObject({
			text: "Default for Q&A.",
			source: "DEFAULT_UNBOUND",
		});
	});

	it.each([
		["a body that cannot be parsed", "{{#if subject}}broken"],
		["a body that renders to nothing", "{{#unknown}}x{{/unknown}}"],
		["a body of zero-width characters", "​{{#unknown}}x{{/unknown}}"],
	])("recovers with the fallback for %s", async (_label, content) => {
		getBoundPromptForAgent.mockResolvedValue(bound(content));

		const resolved = await resolve({ escape: false });

		expect(resolved).toMatchObject({
			text: "Default for Q&A.",
			source: "DEFAULT_RENDER_FAILED",
			promptVersion: null,
		});
	});

	it("renders a body bound under a non-templating format as Handlebars", async () => {
		getBoundPromptForAgent.mockResolvedValue(
			bound("Bound for {{subject}}.", "MARKDOWN"),
		);

		const resolved = await resolve({ escape: false });

		expect(resolved).toMatchObject({
			text: "Bound for Q&A.",
			source: "BOUND",
			formatOverridden: true,
		});
	});
});

describe("renderBoundPromptBody", () => {
	it("does not mistake a bare mustache in the facts for an unrendered body", async () => {
		const rendered = await renderBoundPromptBody({
			body: "Note: {{note}}",
			format: "HANDLEBARS",
			fallbackBody: FALLBACK,
			variables: { note: "wrote {{ twice" },
			escape: false,
			logTag: "example",
		});

		expect(rendered).toEqual({
			text: "Note: wrote {{ twice",
			recovered: false,
			formatOverridden: false,
		});
	});
});
