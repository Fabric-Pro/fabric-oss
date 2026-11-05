import { beforeEach, describe, expect, it, vi } from "vitest";

const m = vi.hoisted(() => ({
	member: vi.fn(),
	user: vi.fn(),
	prompt: vi.fn(),
	update: vi.fn(),
	model: vi.fn(),
	object: vi.fn(),
	text: vi.fn(),
	usage: vi.fn(),
	announce: vi.fn(),
}));
vi.mock("../announce-default-change", () => ({
	announceDefaultChangeForWinningActions: m.announce,
}));
vi.mock("@repo/database", () => ({
	db: {
		member: { findFirst: m.member },
		prompt: { findUnique: m.prompt },
		user: { findUnique: m.user },
	},
	getPromptById: m.prompt,
	updatePromptWithVersion: m.update,
}));
vi.mock("@repo/ai", () => ({
	getAIModelWithMetadata: m.model,
	generateObject: m.object,
	generateText: m.text,
	zodSchema: (s: unknown) => s,
	Output: { json: () => ({ type: "json" }) },
	NoObjectGeneratedError: {
		isInstance: (error: unknown) =>
			Boolean(
				error &&
					typeof error === "object" &&
					"text" in error &&
					"structuredFailure" in error,
			),
	},
}));
vi.mock("../../../../lib/chatgpt-plan-errors", () => ({
	rethrowChatGptPlanRefusal: vi.fn(),
}));

import {
	assistPrompt,
	getPromptResponse,
	tryPrompt,
	updatePromptResponse,
} from "../workbench";
import { readPromptWorkbenchBody } from "../workbench-http";

const actor = { userId: "example-user", organizationId: "example-org" };
const draft = {
	name: "Delivery brief",
	description: "Summarize progress",
	format: "HANDLEBARS" as const,
	content: "Summarize {{topic}}.",
};
beforeEach(() => {
	vi.resetAllMocks();
	m.member.mockResolvedValue({ role: "admin" });
	m.model.mockResolvedValue({ model: {}, trackUsage: m.usage });
	m.text.mockResolvedValue({ text: "Example delivery update" });
	m.object.mockResolvedValue({
		object: { message: "Review this proposal", proposal: draft },
	});
});
describe("prompt workbench authority and real model execution", () => {
	it("resolves models in the current org and returns actual output and exact input without tools or persistence", async () => {
		const result = await tryPrompt(actor, {
			draft,
			variables: { topic: "example <release> & risks" },
		});
		expect(result.output).toBe("Example delivery update");
		expect(result.renderedPrompt).toBe(
			"Summarize example <release> & risks.",
		);
		expect(result.draftHash).toMatch(/^[a-f0-9]{64}$/);
		expect(result.sourceAccess).toBe("provided-inputs-only");
		expect(m.model).toHaveBeenCalledWith(
			{ taskType: "SIMPLE" },
			{ ...actor, featureKey: "prompt-preview" },
		);
		expect(m.text.mock.calls[0][0]).not.toHaveProperty("tools");
		expect(m.usage).toHaveBeenCalledTimes(1);
		expect(m.member.mock.calls[0][0].where).toEqual({
			userId: actor.userId,
			organizationId: actor.organizationId,
			organization: { deletedAt: null },
		});
	});
	it.each([null, { role: "viewer" }])(
		"denies missing or read-only membership before model resolution: %j",
		async (member) => {
			m.member.mockResolvedValue(member);
			await expect(
				tryPrompt(actor, { draft, variables: { topic: "release" } }),
			).rejects.toMatchObject({ code: "FORBIDDEN" });
			expect(m.model).not.toHaveBeenCalled();
		},
	);
	it("rechecks live authority after model configuration and refuses before spending when revoked", async () => {
		m.model.mockImplementation(async () => {
			m.member.mockResolvedValue(null);
			return { model: {}, trackUsage: m.usage };
		});
		await expect(
			tryPrompt(actor, { draft, variables: { topic: "release" } }),
		).rejects.toMatchObject({ code: "FORBIDDEN" });
		expect(m.text).not.toHaveBeenCalled();
	});
	it("does not release a result if membership was revoked during execution", async () => {
		m.text.mockImplementation(async () => {
			m.member.mockResolvedValue(null);
			return { text: "private output" };
		});
		await expect(
			tryPrompt(actor, { draft, variables: { topic: "release" } }),
		).rejects.toMatchObject({ code: "FORBIDDEN" });
	});
	it("proposes text without applying, binding or publishing", async () => {
		const result = await assistPrompt(actor, {
			draft,
			message: "Improve clarity",
		});
		expect(result.proposal).toEqual(draft);
		expect(m.object.mock.calls[0][0]).not.toHaveProperty("tools");
	});
	it("rejects actor/org overrides and oversized aggregate requests before model use", async () => {
		await expect(
			tryPrompt(actor, { draft, organizationId: "another-org" }),
		).rejects.toThrow();
		await expect(
			assistPrompt(actor, { draft, message: "x".repeat(600000) }),
		).rejects.toMatchObject({ code: "BAD_REQUEST" });
		expect(m.model).not.toHaveBeenCalled();
	});
	it.each(["MUSTACHE", "HANDLEBARS", "LIQUID", "JINJA2"] as const)(
		"previews text inputs in %s and refuses missing inputs",
		async (format) => {
			await expect(
				tryPrompt(actor, {
					draft: { ...draft, format },
					variables: { topic: "release" },
				}),
			).resolves.toMatchObject({ renderedPrompt: "Summarize release." });
			m.model.mockClear();
			await expect(
				tryPrompt(actor, {
					draft: { ...draft, format },
					variables: {},
				}),
			).rejects.toMatchObject({ code: "BAD_REQUEST" });
			expect(m.model).not.toHaveBeenCalled();
		},
	);
	it.each(["PLAIN_TEXT", "MARKDOWN"] as const)(
		"sends %s verbatim",
		async (format) => {
			await expect(
				tryPrompt(actor, {
					draft: { ...draft, format },
					variables: { topic: "release" },
				}),
			).resolves.toMatchObject({ renderedPrompt: draft.content });
		},
	);
	it.each([
		"{% for i in range(999999999) %}x{% endfor %}",
		"{{ config.secret }}",
		"{{constructor.constructor('return process')()}}",
		"{{> private}}",
		"{{topic | upper}}",
		"{{#each topic}}x{{/each}}",
	])(
		"refuses template programs rather than executing them: %s",
		async (content) => {
			await expect(
				tryPrompt(actor, {
					draft: { ...draft, format: "JINJA2", content },
					variables: { topic: "release" },
				}),
			).rejects.toMatchObject({ code: "BAD_REQUEST" });
			expect(m.model).not.toHaveBeenCalled();
		},
	);
	it("redacts upstream errors and does not retry the model invocation", async () => {
		m.text.mockRejectedValue(new Error("provider token private-value"));
		await expect(
			tryPrompt(actor, { draft, variables: { topic: "release" } }),
		).rejects.toMatchObject({
			code: "SERVICE_UNAVAILABLE",
			message: expect.not.stringContaining("private-value"),
		});
		expect(m.text).toHaveBeenCalledTimes(1);
	});
	it("rejects expanded input over the output bound", async () => {
		await expect(
			tryPrompt(actor, {
				draft: { ...draft, content: "{{topic}}".repeat(10) },
				variables: { topic: "x".repeat(10000) },
			}),
		).rejects.toMatchObject({ code: "BAD_REQUEST" });
		expect(m.model).not.toHaveBeenCalled();
	});
});
describe("bounded original HTTP body", () => {
	it("parses valid JSON", async () => {
		expect(
			await readPromptWorkbenchBody(
				new Request("https://example.com", {
					method: "POST",
					body: '{"draft":{}}',
				}),
			),
		).toEqual({ draft: {} });
	});
	it("rejects invalid JSON", async () => {
		await expect(
			readPromptWorkbenchBody(
				new Request("https://example.com", {
					method: "POST",
					body: "{",
				}),
			),
		).rejects.toMatchObject({ code: "BAD_REQUEST" });
	});
	it("bounds bytes even with no content-length", async () => {
		await expect(
			readPromptWorkbenchBody(
				new Request("https://example.com", {
					method: "POST",
					body: "x".repeat(512 * 1024 + 1),
				}),
			),
		).rejects.toMatchObject({ code: "PAYLOAD_TOO_LARGE" });
	});
});

it("accepts a full-size multilingual draft without an accidental UTF-8 request ceiling", async () => {
	const multilingual = {
		...draft,
		format: "MARKDOWN",
		content: "文".repeat(50000),
	};
	await expect(
		tryPrompt(actor, { draft: multilingual }),
	).resolves.toMatchObject({ renderedPrompt: multilingual.content });
	await expect(
		assistPrompt(actor, {
			draft: multilingual,
			message: "Improve clarity",
		}),
	).resolves.toMatchObject({ message: "Review this proposal" });
});

const responseSchema = {
	type: "object",
	properties: { summary: { type: "string" } },
	required: ["summary"],
	additionalProperties: false,
};
it("checks native JSON output against the requested schema without coercing fields", async () => {
	m.text.mockResolvedValue({ text: '{"summary":23}' });
	const result = await tryPrompt(actor, {
		draft: {
			...draft,
			responseContract: { format: "JSON", schema: responseSchema },
		},
		variables: { topic: "release" },
	});
	expect(result.validation).toMatchObject({
		status: "failed",
		issues: [
			{ path: "/summary", message: expect.stringContaining("string") },
		],
	});
	expect(result.output).toBe('{"summary":23}');
	expect(m.text.mock.calls[0][0]).toMatchObject({
		output: { type: "json" },
		maxRetries: 0,
	});
	m.text.mockResolvedValue({ text: '{"summary":"Ready"}' });
	expect(
		(
			await tryPrompt(actor, {
				draft: {
					...draft,
					responseContract: {
						format: "JSON",
						schema: responseSchema,
					},
				},
				variables: { topic: "release" },
			})
		).validation.status,
	).toBe("passed");
});
it("retains malformed native JSON output for correction", async () => {
	m.text.mockRejectedValue({ structuredFailure: true, text: "Not JSON" });
	const result = await tryPrompt(actor, {
		draft: {
			...draft,
			responseContract: { format: "JSON", schema: responseSchema },
		},
		variables: { topic: "release" },
	});
	expect(result.output).toBe("Not JSON");
	expect(result.validation.status).toBe("failed");
	expect(m.usage).toHaveBeenCalledOnce();
});
it("rejects unsafe or unsupported schemas before resolving a model", async () => {
	await expect(
		tryPrompt(actor, {
			draft: {
				...draft,
				responseContract: {
					format: "JSON",
					schema: {
						type: "object",
						properties: {
							x: { $ref: "https://example.com/schema" },
						},
					},
				},
			},
			variables: { topic: "release" },
		}),
	).rejects.toMatchObject({ code: "BAD_REQUEST" });
	expect(m.model).not.toHaveBeenCalled();
});
it("reads inherited settings and restricts writes to the current tenant and live editor", async () => {
	m.prompt.mockResolvedValue({
		id: "example-prompt",
		scope: "ORG",
		organizationId: actor.organizationId,
		versions: [{ id: "example-v1", responseContract: null }],
	});
	expect(
		await getPromptResponse(actor, { promptId: "example-prompt" }),
	).toMatchObject({ responseContract: { format: "AUTO" } });
	m.update.mockResolvedValue({
		version: { id: "example-v2", responseContract: { format: "XML" } },
	});
	expect(
		await updatePromptResponse(actor, {
			promptId: "example-prompt",
			responseContract: { format: "XML" },
		}),
	).toMatchObject({ versionId: "example-v2" });
	expect(m.update).toHaveBeenCalledWith(
		expect.objectContaining({
			id: "example-prompt",
			auditOrganizationId: actor.organizationId,
			responseContract: { format: "XML" },
		}),
	);
	expect(m.announce).toHaveBeenCalledWith(
		expect.objectContaining({
			promptId: "example-prompt",
			promptVersionId: "example-v2",
			actorUserId: actor.userId,
		}),
	);
	m.prompt.mockResolvedValue({
		id: "example-prompt",
		scope: "ORG",
		organizationId: "example-other-org",
		versions: [],
	});
	await expect(
		updatePromptResponse(actor, {
			promptId: "example-prompt",
			responseContract: { format: "XML" },
		}),
	).rejects.toMatchObject({ code: "NOT_FOUND" });
	m.prompt.mockResolvedValue({
		id: "example-prompt",
		scope: "ORG",
		organizationId: actor.organizationId,
		versions: [],
	});
	m.member.mockResolvedValue({ role: "member" });
	await expect(
		updatePromptResponse(actor, {
			promptId: "example-prompt",
			responseContract: { format: "XML" },
		}),
	).rejects.toMatchObject({ code: "FORBIDDEN" });
});

it("uses the portal's exact platform admin gate for system response writes", async () => {
	m.prompt.mockResolvedValue({
		id: "example-system-prompt",
		scope: "SYSTEM",
		organizationId: null,
		versions: [{ id: "example-v1" }],
	});
	m.user.mockResolvedValue({ role: "user,admin" });
	await expect(
		updatePromptResponse(actor, {
			promptId: "example-system-prompt",
			responseContract: { format: "XML" },
		}),
	).rejects.toMatchObject({ code: "FORBIDDEN" });
	expect(m.update).not.toHaveBeenCalled();
});
it("tracks a generated response even when it is too large to return", async () => {
	m.text.mockResolvedValue({ text: "a".repeat(64001) });
	await expect(
		tryPrompt(actor, { draft, variables: { topic: "release" } }),
	).rejects.toBeDefined();
	expect(m.usage).toHaveBeenCalledTimes(1);
});
