/**
 * Shared cross-edge overlay (`overlayCrossEdges`) feeding the System-map chat.
 *
 * Locks two contracts:
 *  - the overlay DROPS a soft-deleted cross-edge and INCLUDES a manual
 *    (user-drawn) cross-repo edge — the same overlay the System map applies;
 *  - `systemChat` grounds `buildSystemChatPrompt` on the OVERLAID edges (with a
 *    user description winning over the AI rationale), not the raw
 *    `getCrossEdges` rows.
 */
import { beforeEach, describe, expect, it, vi } from "vitest";

const mockListProjectRepositories = vi.fn();
const mockFindAnalysis = vi.fn();
const mockGetCrossEdges = vi.fn();
const mockLoadEdgeOverrides = vi.fn();
const mockGetConversation = vi.fn();
const mockCreateConversation = vi.fn();
const mockAppendMessages = vi.fn();
const mockBuildSystemChatPrompt = vi.fn();
const mockGetAIModelWithMetadata = vi.fn();
const mockStreamText = vi.fn();

vi.mock("../queries", () => ({
	listProjectRepositories: (...a: unknown[]) =>
		mockListProjectRepositories(...a),
	findAnalysis: (...a: unknown[]) => mockFindAnalysis(...a),
	findLatestAnalysisForIntegration: vi.fn().mockResolvedValue(null),
	findLatestAnalysisForProject: vi.fn().mockResolvedValue(null),
	getCrossEdges: (...a: unknown[]) => mockGetCrossEdges(...a),
	loadEdgeOverrides: (...a: unknown[]) => mockLoadEdgeOverrides(...a),
	getConversation: (...a: unknown[]) => mockGetConversation(...a),
	createConversation: (...a: unknown[]) => mockCreateConversation(...a),
	appendMessages: (...a: unknown[]) => mockAppendMessages(...a),
}));

vi.mock("../chat", () => ({
	buildSystemPrompt: vi.fn(),
	buildSystemChatPrompt: (...a: unknown[]) => mockBuildSystemChatPrompt(...a),
}));

vi.mock("../credentials", () => ({ ensureFreshRepoCredentials: vi.fn() }));
vi.mock("../usage", () => ({ recordAtlasUsage: vi.fn() }));

vi.mock("@repo/ai", () => ({
	AIProviderNotConfiguredError: class extends Error {},
	generateObject: vi.fn(),
	getAIModelWithMetadata: (...a: unknown[]) =>
		mockGetAIModelWithMetadata(...a),
	logModelUsageAsync: vi.fn(),
	streamText: (...a: unknown[]) => mockStreamText(...a),
}));

vi.mock("@repo/database", () => ({ recordAudit: vi.fn() }));
vi.mock("@repo/logs", () => ({
	logger: { info: vi.fn(), warn: vi.fn(), error: vi.fn() },
}));
vi.mock("simple-git", () => ({ default: vi.fn() }));

import { AtlasService } from "../service";

const ctx = { userId: "user-1", organizationId: "org-1" };

function repoOption(integrationId: string, name: string) {
	return {
		repositoryIntegrationId: integrationId,
		provider: "GITHUB",
		authMethod: "OAUTH",
		repositoryName: name,
		repositoryUrl: `https://github.com/acme/${name}`,
		defaultBranch: "main",
		status: "ACTIVE",
		isDefault: false,
	};
}

function override(over: Record<string, unknown>) {
	return {
		id: "ov-1",
		branch: "main",
		mode: "TECHNICAL",
		sourceRepositoryIntegrationId: "int-1",
		sourceKey: "checkout",
		targetRepositoryIntegrationId: "int-2",
		targetKey: "charges",
		kind: "CALLS_API",
		userDescription: null,
		isManual: false,
		isCrossRepo: true,
		deletedAt: null,
		...over,
	};
}

/** The crossEdges the (mocked) `buildSystemChatPrompt` was grounded on. */
function lastCrossEdges() {
	return mockBuildSystemChatPrompt.mock.calls.at(-1)?.[1]?.crossEdges as {
		kind: string;
		sourceAnalysisId: string;
		sourceKey: string | null;
		targetAnalysisId: string;
		targetKey: string | null;
		description: string | null;
	}[];
}

beforeEach(() => {
	vi.clearAllMocks();
	mockListProjectRepositories.mockResolvedValue([
		repoOption("int-1", "web"),
		repoOption("int-2", "api"),
	]);
	// resolveAnalysis → findAnalysis(exact branch) returns a READY row per repo.
	mockFindAnalysis.mockImplementation(
		(_ctx: unknown, _projectId: string, integrationId: string) =>
			Promise.resolve(
				integrationId === "int-1"
					? {
							id: "an-web",
							status: "READY",
							branch: "main",
							repositoryName: "web",
							analyzedCommitSha: "sha-web",
						}
					: {
							id: "an-api",
							status: "READY",
							branch: "main",
							repositoryName: "api",
							analyzedCommitSha: "sha-api",
						},
			),
	);
	mockGetConversation.mockResolvedValue({
		id: "c1",
		messages: [],
		title: "New conversation",
	});
	mockCreateConversation.mockResolvedValue({
		id: "c1",
		messages: [],
		title: "New conversation",
	});
	mockAppendMessages.mockResolvedValue(1);
	mockBuildSystemChatPrompt.mockResolvedValue("SYSTEM PROMPT");
	mockGetAIModelWithMetadata.mockResolvedValue({
		model: { id: "m1" },
		metadata: { provider: "test" },
		trackUsage: vi.fn(),
	});
	mockStreamText.mockReturnValue({
		textStream: (async function* () {
			yield "ok";
		})(),
	});
});

async function runSystemChat() {
	const service = new AtlasService(ctx);
	return service.systemChat({
		projectId: "p1",
		repositoryIntegrationIds: ["int-1", "int-2"],
		mode: "TECHNICAL",
		conversationId: "c1",
		messages: [{ role: "user", content: "How does web reach the api?" }],
	});
}

describe("overlayCrossEdges via systemChat", () => {
	it("drops a soft-deleted cross-edge from the prompt grounding", async () => {
		mockGetCrossEdges.mockResolvedValue([
			{
				mode: "TECHNICAL",
				kind: "CALLS_API",
				detection: "AI",
				sourceAnalysisId: "an-web",
				sourceKey: "checkout",
				targetAnalysisId: "an-api",
				targetKey: "charges",
				weight: 0.9,
				description: "AI: web calls api",
			},
		]);
		// A soft-deleted override on that exact endpoint pair.
		mockLoadEdgeOverrides.mockResolvedValue([
			override({ deletedAt: new Date("2026-06-01T00:00:00Z") }),
		]);

		await runSystemChat();

		const crossEdges = lastCrossEdges();
		expect(crossEdges).toHaveLength(0);
	});

	it("includes a manual cross-repo edge and applies the user description", async () => {
		mockGetCrossEdges.mockResolvedValue([]);
		mockLoadEdgeOverrides.mockResolvedValue([
			override({
				id: "ov-manual",
				isManual: true,
				userDescription: "Hand-drawn: web depends on api",
				kind: "DEPENDS_ON",
			}),
		]);

		await runSystemChat();

		const crossEdges = lastCrossEdges();
		expect(crossEdges).toHaveLength(1);
		expect(crossEdges[0]).toMatchObject({
			kind: "DEPENDS_ON",
			sourceAnalysisId: "an-web",
			sourceKey: "checkout",
			targetAnalysisId: "an-api",
			targetKey: "charges",
			description: "Hand-drawn: web depends on api",
		});
	});

	it("overlays a user description onto a detected edge (user wins over AI)", async () => {
		mockGetCrossEdges.mockResolvedValue([
			{
				mode: "TECHNICAL",
				kind: "CALLS_API",
				detection: "AI",
				sourceAnalysisId: "an-web",
				sourceKey: "checkout",
				targetAnalysisId: "an-api",
				targetKey: "charges",
				weight: 0.9,
				description: "AI rationale",
			},
		]);
		mockLoadEdgeOverrides.mockResolvedValue([
			override({ userDescription: "Team note: REST call to /charges" }),
		]);

		await runSystemChat();

		const crossEdges = lastCrossEdges();
		expect(crossEdges).toHaveLength(1);
		expect(crossEdges[0].description).toBe(
			"Team note: REST call to /charges",
		);
	});
});
