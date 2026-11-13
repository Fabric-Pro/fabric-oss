/**
 * A retried attempt of a research run re-authorizes the requester and hands
 * the agent a freshly minted token with the same permission, project and
 * research grant; the dispatch token may have expired during the earlier
 * attempt. The first attempt, and every run that did not research, keeps the
 * token it was handed.
 */

import { ApplicationFailure } from "@temporalio/common";
import { beforeEach, describe, expect, it, vi } from "vitest";

const issueAIToken = vi.hoisted(() => vi.fn(async () => "minted-token"));
vi.mock("@repo/ai-token", async (importOriginal) => ({
	...(await importOriginal<Record<string, unknown>>()),
	issueAIToken,
}));

const mocks = vi.hoisted(() => ({
	attempt: 1 as number | undefined,
	clientHeaders: vi.fn(),
	runsStream: vi.fn(),
	projectFindUnique: vi.fn(),
	projectDocumentFindUnique: vi.fn(),
	resolveProjectAccess: vi.fn(),
	fetchAndRenderPrompt: vi.fn(),
}));

vi.mock("@langchain/langgraph-sdk", () => ({
	Client: class {
		assistants = { getSchemas: vi.fn().mockResolvedValue({}) };
		runs = {
			stream: (...args: unknown[]) => mocks.runsStream(...args),
		};
		constructor(options: { defaultHeaders?: Record<string, string> }) {
			mocks.clientHeaders(options.defaultHeaders);
		}
	},
}));

vi.mock("@repo/database", () => ({
	db: {
		project: {
			findUnique: (...args: unknown[]) =>
				mocks.projectFindUnique(...args),
		},
		projectDocument: {
			findUnique: (...args: unknown[]) =>
				mocks.projectDocumentFindUnique(...args),
			updateMany: vi.fn().mockResolvedValue({ count: 1 }),
			update: vi.fn().mockResolvedValue({}),
		},
	},
	hasProjectAccess: vi.fn().mockResolvedValue(true),
	resolveProjectAccess: (...args: unknown[]) =>
		mocks.resolveProjectAccess(...args),
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
	streamText: vi.fn(),
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
		Context: {
			current: () => {
				if (mocks.attempt === undefined) {
					throw new Error("not in an activity context");
				}
				return {
					info: {
						attempt: mocks.attempt,
						workflowExecution: { workflowId: "workflow-1" },
					},
					cancellationSignal: new AbortController().signal,
					heartbeat: vi.fn(),
				};
			},
		},
		heartbeat: vi.fn(),
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
import { generateDocumentWithAgent } from "../project-document-generation";

/** An unsigned token carrying `payload`; only decoded, never verified here. */
function unsignedToken(payload: Record<string, unknown>): string {
	const encode = (value: object) =>
		Buffer.from(JSON.stringify(value)).toString("base64url");
	return `${encode({ alg: "HS256" })}.${encode(payload)}.signature`;
}

const HANDED_TOKEN = unsignedToken({
	sub: "user-1",
	org: "org-1",
	src: "project-document-generation",
	jti: "nonce-1",
	wr: true,
	wrp: "project-1",
	wrg: "grant-1",
});

function generate(
	options: {
		allowWebResearch?: boolean;
		documentId?: string | null;
		aiToken?: string;
	} = {},
) {
	return generateDocumentWithAgent({
		projectId: "project-1",
		...(options.documentId !== null && {
			documentId: options.documentId ?? "doc-1",
		}),
		documentType: "BUSINESS_CASE",
		prompt: "",
		contexts: ["The client picks 4,000 orders a day on paper."],
		userId: "user-1",
		organizationId: "org-1",
		aiToken: options.aiToken ?? HANDED_TOKEN,
		hasRagContexts: true,
		...(options.allowWebResearch !== undefined && {
			allowWebResearch: options.allowWebResearch,
		}),
	});
}

/** The X-AI-Token header the agent client was built with. */
function agentToken(): string | undefined {
	return mocks.clientHeaders.mock.calls.at(-1)?.[0]?.["X-AI-Token"];
}

/** The options of the only `issueAIToken` call. */
function mintOptions(): Record<string, unknown> | undefined {
	return (
		issueAIToken.mock.calls as unknown as [Record<string, unknown>][]
	)[0]?.[0];
}

beforeEach(() => {
	vi.clearAllMocks();
	mocks.attempt = 1;
	mocks.fetchAndRenderPrompt.mockResolvedValue(null);
	mocks.projectDocumentFindUnique.mockResolvedValue({
		projectId: "project-1",
	});
	mocks.resolveProjectAccess.mockResolvedValue({
		organizationId: "org-1",
		source: "owner",
		permissions: [],
	});
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

describe("the first attempt of a research run", () => {
	it("uses the token it was handed, without re-authorizing", async () => {
		await generate({ allowWebResearch: true });

		expect(agentToken()).toBe(HANDED_TOKEN);
		expect(issueAIToken).not.toHaveBeenCalled();
		expect(mocks.projectDocumentFindUnique).not.toHaveBeenCalled();
	});

	it("uses the token it was handed outside an activity context", async () => {
		mocks.attempt = undefined;

		await generate({ allowWebResearch: true });

		expect(agentToken()).toBe(HANDED_TOKEN);
		expect(issueAIToken).not.toHaveBeenCalled();
	});
});

describe("a retried attempt of a research run", () => {
	beforeEach(() => {
		mocks.attempt = 2;
	});

	it("re-authorizes the requester, then hands the agent a freshly minted token", async () => {
		await generate({ allowWebResearch: true });

		expect(mocks.projectDocumentFindUnique).toHaveBeenCalledWith(
			expect.objectContaining({ where: { id: "doc-1" } }),
		);
		expect(mocks.resolveProjectAccess).toHaveBeenCalledWith(
			"project-1",
			"user-1",
		);
		expect(
			mocks.resolveProjectAccess.mock.invocationCallOrder[0],
		).toBeLessThan(issueAIToken.mock.invocationCallOrder[0] ?? 0);
		expect(agentToken()).toBe("minted-token");
	});

	it("mints with the same permission, project and research grant", async () => {
		await generate({ allowWebResearch: true });

		expect(mintOptions()).toMatchObject({
			userId: "user-1",
			organizationId: "org-1",
			webResearch: true,
			webResearchProjectId: "project-1",
			// The handed token's grant, not its own nonce.
			webResearchGrantId: "grant-1",
		});
		// Covers the attempt's fifteen minutes with margin.
		expect(mintOptions()?.expirySeconds).toBe(1800);
	});

	it("takes the handed token's nonce as the grant when it carries none", async () => {
		await generate({
			allowWebResearch: true,
			aiToken: unsignedToken({
				sub: "user-1",
				org: "org-1",
				src: "project-document-generation",
				jti: "nonce-1",
				wr: true,
				wrp: "project-1",
			}),
		});

		expect(mintOptions()?.webResearchGrantId).toBe("nonce-1");
	});

	it.each([
		[
			"names another project and organization",
			{
				sub: "user-2",
				org: "org-2",
				src: "project-document-generation",
				jti: "nonce-1",
				wr: true,
				wrp: "project-2",
				wrg: "grant-1",
			},
		],
		[
			"does not carry the permission",
			{
				sub: "user-1",
				org: "org-1",
				src: "project-document-generation",
				jti: "nonce-1",
				wr: false,
				wrg: "grant-1",
			},
		],
	])(
		"mints from the activity input when the handed token %s",
		async (_label, payload) => {
			await generate({
				allowWebResearch: true,
				aiToken: unsignedToken(payload),
			});

			expect(mintOptions()).toMatchObject({
				userId: "user-1",
				organizationId: "org-1",
				webResearch: true,
				webResearchProjectId: "project-1",
			});
			expect(agentToken()).toBe("minted-token");
		},
	);

	it("uses the nonce, not a grant id that is too long or malformed", async () => {
		for (const wrg of ["g".repeat(200), "grant 1/other"]) {
			issueAIToken.mockClear();
			await generate({
				allowWebResearch: true,
				aiToken: unsignedToken({
					sub: "user-1",
					org: "org-1",
					jti: "nonce-1",
					wr: true,
					wrp: "project-1",
					wrg,
				}),
			});

			expect(mintOptions()?.webResearchGrantId).toBe("nonce-1");
		}
	});

	it("starts a fresh grant when the handed token carries no usable id", async () => {
		await generate({
			allowWebResearch: true,
			aiToken: unsignedToken({
				sub: "user-1",
				org: "org-1",
				jti: "x".repeat(200),
				wr: true,
				wrp: "project-1",
			}),
		});

		const grantId = mintOptions()?.webResearchGrantId;
		expect(grantId).toMatch(
			/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/,
		);
		expect(mintOptions()).toMatchObject({
			webResearch: true,
			webResearchProjectId: "project-1",
		});
	});

	it("fails for good, minting nothing, when the requester lost access", async () => {
		mocks.resolveProjectAccess.mockResolvedValue({
			organizationId: "org-1",
			source: "organization",
			permissions: [],
		});

		const failure = await generate({ allowWebResearch: true }).catch(
			(error: unknown) => error,
		);

		expect(failure).toBeInstanceOf(ApplicationFailure);
		expect((failure as ApplicationFailure).type).toBe(
			"DOCUMENT_GENERATION_NOT_AUTHORIZED",
		);
		expect((failure as ApplicationFailure).nonRetryable).toBe(true);
		expect(issueAIToken).not.toHaveBeenCalled();
		expect(mocks.runsStream).not.toHaveBeenCalled();
	});

	it("keeps the handed token when there is no document to re-authorize against", async () => {
		await generate({ allowWebResearch: true, documentId: null });

		expect(agentToken()).toBe(HANDED_TOKEN);
		expect(issueAIToken).not.toHaveBeenCalled();
		expect(activityLogger.warn).toHaveBeenCalledWith(
			"A retried research attempt has no document to re-authorize against; keeping its token",
			{ projectId: "project-1", attempt: 2 },
		);
	});
});

describe("a retried attempt of a run that did not research", () => {
	beforeEach(() => {
		mocks.attempt = 3;
	});

	it.each([
		["declined", false],
		["not offered", undefined],
	])(
		"keeps the token it was handed when research was %s",
		async (_label, allowWebResearch) => {
			await generate({ allowWebResearch });

			expect(agentToken()).toBe(HANDED_TOKEN);
			expect(issueAIToken).not.toHaveBeenCalled();
			expect(mocks.projectDocumentFindUnique).not.toHaveBeenCalled();
		},
	);
});
