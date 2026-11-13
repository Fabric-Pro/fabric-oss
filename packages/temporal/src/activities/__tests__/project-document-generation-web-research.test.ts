/**
 * A person's per-action web research answer at the activity edge: the
 * re-issued token carries a `true`, bound to the run's project (and never
 * without one); the agent input carries a boolean only where the choice was
 * offered; a run allowed to research gets stream time to do it in and keeps
 * its row's last write recent meanwhile; and the gateway fallback is told
 * which research notice to write: incomplete for `true`, not authorized for
 * `false`, none when no choice was offered.
 */

import {
	afterEach,
	beforeEach,
	describe,
	expect,
	it,
	type MockInstance,
	vi,
} from "vitest";

const issueAIToken = vi.hoisted(() => vi.fn(async () => "example-token"));
vi.mock("@repo/ai-token", () => ({ issueAIToken }));

const mocks = vi.hoisted(() => ({
	runsStream: vi.fn(),
	hasProjectAccess: vi.fn(),
	projectFindUnique: vi.fn(),
	fetchAndRenderPrompt: vi.fn(),
	streamText: vi.fn(),
	heartbeat: vi.fn(),
	projectDocumentUpdateMany: vi.fn(),
	projectDocumentUpdate: vi.fn(),
}));

vi.mock("@langchain/langgraph-sdk", () => ({
	Client: class {
		assistants = { getSchemas: vi.fn().mockResolvedValue({}) };
		runs = {
			stream: (...args: unknown[]) => mocks.runsStream(...args),
		};
	},
}));

vi.mock("@repo/database", () => ({
	db: {
		project: {
			findUnique: (...args: unknown[]) =>
				mocks.projectFindUnique(...args),
		},
		projectDocument: {
			updateMany: (...args: unknown[]) =>
				mocks.projectDocumentUpdateMany(...args),
			update: (...args: unknown[]) =>
				mocks.projectDocumentUpdate(...args),
		},
	},
	hasProjectAccess: (...args: unknown[]) => mocks.hasProjectAccess(...args),
	recordAuditDurable: vi.fn(),
	listEmbeddedDocumentsForSweep: vi.fn().mockResolvedValue([]),
}));

vi.mock("@repo/rag", () => ({}));

vi.mock("@repo/ai", () => ({
	DEFAULT_BASE_URLS: {},
	getAIModelWithMetadata: vi.fn().mockResolvedValue({
		model: {},
		metadata: { modelString: "example-model", provider: "openai" },
		trackUsage: vi.fn(),
	}),
	logModelUsageAsync: vi.fn(),
	streamText: (...args: unknown[]) => mocks.streamText(...args),
}));

vi.mock("@repo/ai/skills", () => ({
	isTextContentType: vi.fn(),
	loadSkillBundle: vi.fn(),
	readSkillFile: vi.fn(),
}));

vi.mock("../prompt-activities", () => ({
	fetchAndRenderPrompt: (...args: unknown[]) =>
		mocks.fetchAndRenderPrompt(...args),
	renderPromptWithContext: vi.fn(),
}));

vi.mock("@temporalio/activity", async () => {
	const temporalCommon = await import("@temporalio/common");
	return {
		Context: { current: { heartbeat: vi.fn() } },
		heartbeat: (...args: unknown[]) => mocks.heartbeat(...args),
		ApplicationFailure: temporalCommon.ApplicationFailure,
	};
});

vi.mock("../lib/activity-logger", () => ({
	activityLogger: {
		info: vi.fn(),
		warn: vi.fn(),
		error: vi.fn(),
		debug: vi.fn(),
	},
}));

import { activityLogger } from "../lib/activity-logger";
import {
	FALLBACK_RESEARCH_INCOMPLETE_INSTRUCTION,
	FALLBACK_RESEARCH_NOT_AUTHORIZED_INSTRUCTION,
} from "../lib/fallback-research-notice";
import {
	agentStreamTimeoutMs,
	generateDocumentWithAgent,
	issueGenerationToken,
} from "../project-document-generation";

/** Today's stream limit with no override. */
const BASE_MS = 300_000;
/** (5 searches + 8 page reads) × the agent's 25 s per-call abort. */
const RESEARCH_ALLOWANCE_MS = 325_000;
/**
 * Ten of the child's fifteen minutes; the rest is the fallback's. Below
 * {@link BASE_MS} + {@link RESEARCH_ALLOWANCE_MS}, so it binds by default.
 */
const CAP_MS = 600_000;

/** The input the agent was handed on its only run. */
function agentInput(): Record<string, unknown> {
	const input = mocks.runsStream.mock.calls[0]?.[2]?.input;
	if (!input) {
		throw new Error("the agent was never called");
	}
	return input;
}

function generate(
	allowWebResearch?: boolean,
	extra: { generationStartedAt?: string } = {},
) {
	return generateDocumentWithAgent({
		projectId: "project-1",
		documentId: "doc-1",
		documentType: "BUSINESS_CASE",
		prompt: "",
		contexts: ["The client picks 4,000 orders a day on paper."],
		userId: "user-1",
		organizationId: "org-1",
		aiToken: "token-1",
		hasRagContexts: true,
		...(allowWebResearch !== undefined && { allowWebResearch }),
		...extra,
	});
}

const savedStreamTimeout = process.env.AGENT_STREAM_TIMEOUT_MS;

beforeEach(() => {
	vi.clearAllMocks();
	// The default limit is what these tests pin; a developer's override must
	// not leak in.
	delete process.env.AGENT_STREAM_TIMEOUT_MS;
	mocks.hasProjectAccess.mockResolvedValue(true);
	mocks.fetchAndRenderPrompt.mockResolvedValue(null);
	mocks.projectDocumentUpdateMany.mockResolvedValue({ count: 1 });
	mocks.projectDocumentUpdate.mockResolvedValue({});
	mocks.projectFindUnique.mockResolvedValue({
		name: "Warehouse modernization",
		description: "Replace paper-based picking.",
		goals: null,
		techStack: ["React"],
		features: ["Barcode scanning"],
		projectTypes: [],
		qaStrategyLevel: null,
	});
	mocks.runsStream.mockImplementation(() =>
		(async function* () {
			yield {
				event: "values",
				data: { document: "## Business Case\n\nBody." },
			};
		})(),
	);
});

afterEach(() => {
	if (savedStreamTimeout === undefined) {
		delete process.env.AGENT_STREAM_TIMEOUT_MS;
	} else {
		process.env.AGENT_STREAM_TIMEOUT_MS = savedStreamTimeout;
	}
});

describe("issueGenerationToken keeps the action's web research permission", () => {
	it("asks for webResearch when the run carried it", async () => {
		await issueGenerationToken({
			userId: "user-1",
			organizationId: "org-1",
			webResearch: true,
			webResearchProjectId: "project-1",
		});

		expect(issueAIToken).toHaveBeenCalledWith(
			expect.objectContaining({ webResearch: true }),
		);
	});

	it("asks for none when the field is absent", async () => {
		await issueGenerationToken({
			userId: "user-1",
			organizationId: "org-1",
		});

		expect(issueAIToken).toHaveBeenCalledWith(
			expect.objectContaining({ webResearch: false }),
		);
	});

	it("asks for none for anything but a literal true", async () => {
		for (const value of [false, "true", 1]) {
			issueAIToken.mockClear();

			await issueGenerationToken({
				userId: "user-1",
				organizationId: "org-1",
				webResearch: value as boolean,
			});

			expect(issueAIToken).toHaveBeenCalledWith(
				expect.objectContaining({ webResearch: false }),
			);
		}
	});
});

describe("issueGenerationToken binds the permission to the run's project", () => {
	/** The options of the only `issueAIToken` call. */
	const tokenOptions = () =>
		(
			issueAIToken.mock.calls as unknown as [Record<string, unknown>][]
		)[0]?.[0];

	it("binds the token to the project when research was allowed", async () => {
		await issueGenerationToken({
			userId: "user-1",
			organizationId: "org-1",
			webResearch: true,
			webResearchProjectId: "project-1",
		});

		expect(tokenOptions()?.webResearchProjectId).toBe("project-1");
	});

	it("binds no project when research was not allowed", async () => {
		for (const value of [undefined, false, "true", 1]) {
			issueAIToken.mockClear();

			await issueGenerationToken({
				userId: "user-1",
				organizationId: "org-1",
				webResearch: value as boolean | undefined,
				webResearchProjectId: "project-1",
			});

			expect(tokenOptions()).not.toHaveProperty("webResearchProjectId");
		}
	});

	it("issues no research at all when no project was handed over", async () => {
		for (const webResearchProjectId of [undefined, ""]) {
			issueAIToken.mockClear();
			vi.mocked(activityLogger.warn).mockClear();

			await issueGenerationToken({
				userId: "user-1",
				organizationId: "org-1",
				webResearch: true,
				webResearchProjectId,
			});

			// Fail closed: no research rather than research bound to nothing.
			expect(tokenOptions()?.webResearch).toBe(false);
			expect(tokenOptions()).not.toHaveProperty("webResearchProjectId");
			expect(activityLogger.warn).toHaveBeenCalledWith(
				"Web research was asked for a token with no project; issuing it without research",
				{ userId: "user-1", organizationId: "org-1" },
			);
		}
	});

	it("carries the research grant it was handed", async () => {
		await issueGenerationToken({
			userId: "user-1",
			organizationId: "org-1",
			webResearch: true,
			webResearchProjectId: "project-1",
			webResearchGrantId: "grant-1",
		});

		expect(tokenOptions()?.webResearchGrantId).toBe("grant-1");
	});

	it("starts a fresh research grant when none was handed over", async () => {
		for (const webResearchGrantId of [undefined, ""]) {
			issueAIToken.mockClear();

			await issueGenerationToken({
				userId: "user-1",
				organizationId: "org-1",
				webResearch: true,
				webResearchProjectId: "project-1",
				webResearchGrantId,
			});

			expect(tokenOptions()?.webResearchGrantId).toMatch(
				/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/,
			);
		}
	});

	it("writes no research grant when the token carries no research", async () => {
		for (const [webResearch, webResearchProjectId] of [
			[undefined, "project-1"],
			[false, "project-1"],
			[true, undefined],
		] as const) {
			issueAIToken.mockClear();

			await issueGenerationToken({
				userId: "user-1",
				organizationId: "org-1",
				webResearch,
				webResearchProjectId,
				webResearchGrantId: "grant-1",
			});

			expect(tokenOptions()).not.toHaveProperty("webResearchGrantId");
		}
	});

	it("warns about nothing when research was granted with its project", async () => {
		await issueGenerationToken({
			userId: "user-1",
			organizationId: "org-1",
			webResearch: true,
			webResearchProjectId: "project-1",
		});

		expect(activityLogger.warn).not.toHaveBeenCalled();
	});
});

describe("generateDocumentWithAgent hands the agent the permission", () => {
	it("sends allowWebResearch: true at the top level of the agent input", async () => {
		await generate(true);

		expect(agentInput().allowWebResearch).toBe(true);
	});

	it("sends allowWebResearch: false when the choice was offered and declined", async () => {
		await generate(false);

		const input = agentInput();
		expect(input).toHaveProperty("allowWebResearch");
		expect(input.allowWebResearch).toBe(false);
	});

	it("omits the key when no choice was offered", async () => {
		await generate();

		expect(agentInput()).not.toHaveProperty("allowWebResearch");
	});

	it("omits the key for a non-boolean, which is no answer to a choice", async () => {
		for (const value of ["true", 1]) {
			mocks.runsStream.mockClear();

			await generate(value as unknown as boolean);

			expect(agentInput()).not.toHaveProperty("allowWebResearch");
		}
	});
});

describe("generateDocumentWithAgent gives a research run stream time", () => {
	let setTimeoutSpy: MockInstance<typeof setTimeout>;

	beforeEach(() => {
		setTimeoutSpy = vi.spyOn(globalThis, "setTimeout");
	});

	afterEach(() => {
		setTimeoutSpy.mockRestore();
	});

	/** Every delay the activity armed a timer with. */
	const armedDelays = () => setTimeoutSpy.mock.calls.map(([, ms]) => ms);

	it("arms the stream timeout at the cap, which the default allowance reaches", async () => {
		await generate(true);

		expect(armedDelays()).toContain(CAP_MS);
		expect(armedDelays()).not.toContain(BASE_MS);
	});

	it("arms today's stream timeout when research was not allowed", async () => {
		await generate();

		expect(armedDelays()).toContain(BASE_MS);
		expect(armedDelays()).not.toContain(CAP_MS);
	});
});

describe("agentStreamTimeoutMs", () => {
	it("keeps today's limit when research was not allowed", () => {
		expect(agentStreamTimeoutMs({})).toBe(BASE_MS);
		expect(agentStreamTimeoutMs({ allowWebResearch: false })).toBe(BASE_MS);
	});

	it("gives a research run the cap by default, since base plus allowance passes it", () => {
		// 300 s + 325 s would be 625 s.
		expect(BASE_MS + RESEARCH_ALLOWANCE_MS).toBeGreaterThan(CAP_MS);
		expect(agentStreamTimeoutMs({ allowWebResearch: true })).toBe(CAP_MS);
	});

	it("treats anything but a literal true as not allowed", () => {
		expect(
			agentStreamTimeoutMs({
				allowWebResearch: "true" as unknown as boolean,
			}),
		).toBe(BASE_MS);
	});

	it("takes AGENT_STREAM_TIMEOUT_MS as the base when it is set", () => {
		expect(agentStreamTimeoutMs({ envValue: "120000" })).toBe(120_000);
		expect(
			agentStreamTimeoutMs({
				allowWebResearch: true,
				envValue: "120000",
			}),
		).toBe(445_000);
	});

	it("never lets a research run's stream past the cap left for the fallback", () => {
		// 400 s + 325 s would be 725 s: the cap bites.
		expect(
			agentStreamTimeoutMs({
				allowWebResearch: true,
				envValue: "400000",
			}),
		).toBe(CAP_MS);
		for (const envValue of [undefined, "0", "300000", "599999"]) {
			expect(
				agentStreamTimeoutMs({ allowWebResearch: true, envValue }),
			).toBeLessThanOrEqual(CAP_MS);
		}
	});

	it("leaves an override above the cap untouched when research was not allowed", () => {
		expect(agentStreamTimeoutMs({ envValue: "900000" })).toBe(900_000);
	});

	it("never gives a research run less time than the same run without it", () => {
		// An operator override above the cap: research must not shorten it.
		expect(
			agentStreamTimeoutMs({
				allowWebResearch: true,
				envValue: "900000",
			}),
		).toBe(900_000);
		for (const envValue of [undefined, "0", "120000", "599999", "900000"]) {
			expect(
				agentStreamTimeoutMs({ allowWebResearch: true, envValue }),
			).toBeGreaterThanOrEqual(agentStreamTimeoutMs({ envValue }));
		}
	});
});

describe("the gateway fallback is told which research notice to write", () => {
	/** The gateway fallback writes a whole document and stops by itself. */
	function fallbackProduces(text: string) {
		mocks.streamText.mockImplementation(() => ({
			textStream: (async function* () {
				yield text;
			})(),
			finishReason: Promise.resolve("stop"),
			usage: Promise.resolve({ outputTokens: 100 }),
		}));
	}

	/** The system prompt the only gateway fallback call was given, if any. */
	function fallbackInstructions(): string | undefined {
		expect(mocks.streamText).toHaveBeenCalledTimes(1);
		const call = mocks.streamText.mock.calls[0]?.[0] as {
			instructions?: unknown;
		};
		expect(["string", "undefined"]).toContain(typeof call.instructions);
		return call.instructions as string | undefined;
	}

	/** The phase of every heartbeat the activity sent, in order. */
	function heartbeatPhases(): unknown[] {
		return mocks.heartbeat.mock.calls.map(
			([details]) => (details as { phase?: unknown } | undefined)?.phase,
		);
	}

	const sites = {
		"the agent stream fails": {
			phase: "fallback_generation",
			arrange: () =>
				mocks.runsStream.mockImplementation(() => {
					throw new Error("agent unavailable");
				}),
		},
		"the agent writes no document": {
			phase: "direct_fallback_generation",
			arrange: () =>
				mocks.runsStream.mockImplementation(() =>
					(async function* () {})(),
				),
		},
	};

	beforeEach(() => {
		fallbackProduces("## Business Case\n\nBody.");
	});

	describe.each(Object.entries(sites))("when %s", (_label, site) => {
		beforeEach(() => {
			site.arrange();
		});

		it("asks for the research-incomplete notice when research was allowed", async () => {
			const result = await generate(true);

			expect(heartbeatPhases()).toContain(site.phase);
			expect(result.content).toBe("## Business Case\n\nBody.");
			const instructions = fallbackInstructions();
			expect(instructions).toContain(
				FALLBACK_RESEARCH_INCOMPLETE_INSTRUCTION,
			);
			expect(instructions).toContain("**Research incomplete.**");
			expect(instructions).not.toContain(
				FALLBACK_RESEARCH_NOT_AUTHORIZED_INSTRUCTION,
			);
		});

		it("asks for the not-authorized notice when research was offered and not allowed", async () => {
			await generate(false);

			expect(heartbeatPhases()).toContain(site.phase);
			const instructions = fallbackInstructions();
			expect(instructions).toContain(
				FALLBACK_RESEARCH_NOT_AUTHORIZED_INSTRUCTION,
			);
			expect(instructions).toContain(
				"**External research not authorized.**",
			);
			expect(instructions).not.toContain(
				FALLBACK_RESEARCH_INCOMPLETE_INSTRUCTION,
			);
		});

		it("asks for no notice, with today's system prompt, when no choice was offered", async () => {
			const result = await generate();

			expect(heartbeatPhases()).toContain(site.phase);
			expect(result.content).toBe("## Business Case\n\nBody.");
			// No rendered prompt: the fallback has no system prompt at all.
			expect(fallbackInstructions()).toBeUndefined();
		});

		it("asks for no notice for a non-boolean, which is no answer to a choice", async () => {
			await generate("true" as unknown as boolean);

			expect(fallbackInstructions()).toBeUndefined();
		});
	});

	it("appends the notice after a custom system prompt", async () => {
		sites["the agent stream fails"].arrange();
		mocks.fetchAndRenderPrompt.mockResolvedValue({
			rendered: "Write the business case in five sections.",
			promptVersionId: "version-1",
		});

		await generate(true);

		expect(fallbackInstructions()).toBe(
			`Write the business case in five sections.\n\n${FALLBACK_RESEARCH_INCOMPLETE_INSTRUCTION}`,
		);
	});

	it("keeps a custom system prompt exactly as it was when no choice was offered", async () => {
		sites["the agent stream fails"].arrange();
		mocks.fetchAndRenderPrompt.mockResolvedValue({
			rendered: "Write the business case in five sections.",
			promptVersionId: "version-1",
		});

		await generate();

		expect(fallbackInstructions()).toBe(
			"Write the business case in five sections.",
		);
	});
});

describe("a research run keeps its row's last write recent", () => {
	/** The attempt this run belongs to. */
	const STARTED_AT = "2026-11-10T09:00:00.000Z";
	const MINUTE = 60_000;

	/** The only kind of write the keepalive may make: the attempt's own. */
	const ATTEMPT_WRITE = {
		where: {
			id: "doc-1",
			generationStartedAt: new Date(STARTED_AT),
			status: { in: ["QUEUED", "GENERATING"] },
		},
		data: {
			status: "GENERATING",
			generationProgress: 35,
			updatedAt: expect.any(Date),
		},
	};

	/** The agent streams for `ms` on the fake clock, then writes the document. */
	function agentStreamsFor(ms: number) {
		mocks.runsStream.mockImplementation(() =>
			(async function* () {
				await new Promise((resolve) => setTimeout(resolve, ms));
				yield {
					event: "values",
					data: { document: "## Business Case\n\nBody." },
				};
			})(),
		);
	}

	/** Run the activity to its end on the fake clock. */
	async function runFor(ms: number, pending: Promise<unknown>) {
		await vi.advanceTimersByTimeAsync(ms);
		return await pending;
	}

	beforeEach(() => {
		vi.useFakeTimers();
	});

	afterEach(() => {
		vi.useRealTimers();
	});

	it("writes the attempt's progress about once a minute while an authorized stream runs", async () => {
		agentStreamsFor(3 * MINUTE + 5_000);

		const result = (await runFor(
			3 * MINUTE + 5_000,
			generate(true, { generationStartedAt: STARTED_AT }),
		)) as { content: string };

		expect(result.content).toBe("## Business Case\n\nBody.");
		expect(mocks.projectDocumentUpdateMany).toHaveBeenCalledTimes(3);
		for (const [args] of mocks.projectDocumentUpdateMany.mock.calls) {
			expect(args).toEqual(ATTEMPT_WRITE);
		}
		// Never the unscoped write, which would land on a newer attempt.
		expect(mocks.projectDocumentUpdate).not.toHaveBeenCalled();
	});

	it("stops writing when the stream ends", async () => {
		agentStreamsFor(65_000);

		await runFor(
			65_000,
			generate(true, { generationStartedAt: STARTED_AT }),
		);
		await vi.advanceTimersByTimeAsync(5 * MINUTE);

		expect(mocks.projectDocumentUpdateMany).toHaveBeenCalledTimes(1);
	});

	it.each([
		["offered and declined", false],
		["not offered", undefined],
	])(
		"writes nothing extra for a run whose research was %s",
		async (_label, value) => {
			agentStreamsFor(3 * MINUTE + 5_000);

			await runFor(
				3 * MINUTE + 5_000,
				generate(value, { generationStartedAt: STARTED_AT }),
			);

			expect(mocks.projectDocumentUpdateMany).not.toHaveBeenCalled();
			expect(mocks.projectDocumentUpdate).not.toHaveBeenCalled();
		},
	);

	it("writes nothing for an authorized run with no attempt identity, rather than an unscoped write", async () => {
		agentStreamsFor(3 * MINUTE + 5_000);

		await runFor(3 * MINUTE + 5_000, generate(true));

		expect(mocks.projectDocumentUpdateMany).not.toHaveBeenCalled();
		expect(mocks.projectDocumentUpdate).not.toHaveBeenCalled();
	});

	it("writes once when the gateway fallback takes over, before it starts", async () => {
		mocks.runsStream.mockImplementation(() => {
			throw new Error("agent unavailable");
		});
		mocks.streamText.mockImplementation(() => ({
			textStream: (async function* () {
				yield "## Business Case\n\nBody.";
			})(),
			finishReason: Promise.resolve("stop"),
			usage: Promise.resolve({ outputTokens: 100 }),
		}));

		const result = (await runFor(
			1_000,
			generate(true, { generationStartedAt: STARTED_AT }),
		)) as { content: string };

		expect(result.content).toBe("## Business Case\n\nBody.");
		expect(mocks.projectDocumentUpdateMany).toHaveBeenCalledTimes(1);
		expect(mocks.projectDocumentUpdateMany).toHaveBeenCalledWith(
			ATTEMPT_WRITE,
		);
		expect(
			mocks.projectDocumentUpdateMany.mock.invocationCallOrder[0],
		).toBeLessThan(mocks.streamText.mock.invocationCallOrder[0] ?? 0);
	});

	it("never fails the generation when a write fails, and logs ids only", async () => {
		mocks.projectDocumentUpdateMany.mockRejectedValue(
			new Error("connection reset"),
		);
		agentStreamsFor(2 * MINUTE + 5_000);

		const result = (await runFor(
			2 * MINUTE + 5_000,
			generate(true, { generationStartedAt: STARTED_AT }),
		)) as { content: string };

		expect(result.content).toBe("## Business Case\n\nBody.");
		expect(mocks.projectDocumentUpdateMany).toHaveBeenCalledTimes(2);
		expect(activityLogger.warn).toHaveBeenCalledWith(
			"Could not record a research run's progress; generation continues",
			{
				projectId: "project-1",
				documentId: "doc-1",
				error: "connection reset",
			},
		);
	});
});
