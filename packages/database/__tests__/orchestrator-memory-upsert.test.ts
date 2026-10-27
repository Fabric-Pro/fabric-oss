import { beforeEach, describe, expect, it, vi } from "vitest";
import type { EpisodicMemory } from "../prisma/generated/client";
import { configureEpisodeClient } from "./_helpers/episodic-memory-client";

const mocks = vi.hoisted(() => ({
	create: vi.fn(),
	insert: vi.fn(),
	findMany: vi.fn(),
	upsert: vi.fn(),
	update: vi.fn(),
	transaction: vi.fn(),
	lock: vi.fn(),
	findFirstOrThrow: vi.fn(),
}));
vi.mock("../prisma/client", () => ({
	db: { episodicMemory: mocks, $transaction: mocks.transaction },
}));
vi.mock("../src/tenant-db", async (importOriginal) => {
	const actual = await importOriginal<typeof import("../src/tenant-db")>();
	const { db } = await import("../prisma/client");
	return { ...actual, getTenantDb: () => db };
});
vi.mock("../prisma/queries/projects/projects", () => ({
	hasProjectAccess: vi.fn(),
}));
vi.mock("../prisma/queries/workspaces/workspaces", () => ({
	hasWorkspaceAccess: vi.fn(),
}));

import {
	buildMemoryContextPromptVariables,
	type CreateEpisodeInput,
	createEpisodicMemory,
	getRecentEpisodes,
} from "../prisma/queries/orchestrator-memory";

const input: CreateEpisodeInput = {
	userId: "user-example-1",
	organizationId: "example-org",
	conversationId: "conversation-example",
	executionId: "execution-example-1",
	title: "Compare the five newest features and pick two",
	summary: "First summary",
	keyTopics: ["planning"],
	userIntents: ["plan"],
	outcome: "ongoing",
	messageCount: 2,
	turnCount: 1,
	toolsUsed: [],
	agentsUsed: [],
	conversationStartedAt: new Date("2026-10-01"),
};
let row: EpisodicMemory | null;
beforeEach(() => {
	vi.resetAllMocks();
	row = null;
	configureEpisodeClient(
		mocks,
		() => row,
		(value) => {
			row = value;
		},
	);
	mocks.findMany.mockImplementation(async () => (row ? [{ ...row }] : []));
});

describe("conversation episode upsert", () => {
	it.each(["title cut", "trim cut", "existing lone surrogates"])(
		"persists well-formed strings after a %s",
		async (boundary) => {
			const request = "Compare the five newest features ";
			const title =
				boundary === "title cut"
					? `${request + "x".repeat(199 - request.length)}😀 trailing`
					: input.title;
			const header = `First request: ${input.title}\n\nTurn 1\n`;
			const body =
				boundary === "trim cut"
					? `${"x".repeat(2000 - header.length - 1)}😀 trailing`
					: boundary === "existing lone surrogates"
						? "left \ud800 middle \udc00 right"
						: input.summary;
			if (boundary === "title cut") {
				expect(title.slice(0, 200)).toMatch(/[\uD800-\uDFFF]/u);
			}
			if (boundary === "trim cut") {
				expect((header + body).slice(0, 2000)).toMatch(
					/[\uD800-\uDFFF]/u,
				);
			}
			await createEpisodicMemory({ ...input, title, summary: body });
			function check(value: unknown): void {
				if (typeof value === "string") {
					expect(value).not.toMatch(/[\uD800-\uDFFF]/u);
				} else if (value && typeof value === "object") {
					Object.values(value).forEach(check);
				}
			}
			check(row);
			expect(row?.summary.length).toBeLessThanOrEqual(2000);
			expect(row?.title.length).toBeLessThanOrEqual(200);
			if (boundary === "existing lone surrogates") {
				expect(row?.summary).toContain("right");
			}
		},
	);

	it.each([
		"summary",
		"memory block",
		"Settings preview",
		"Settings full summary",
	])("keeps metadata out of %s", async (surface) => {
		const episode = await createEpisodicMemory(input);
		const [settings] = await getRecentEpisodes(
			input.userId,
			input.organizationId,
		);
		const variables = buildMemoryContextPromptVariables({
			preferences: {
				preferences: {},
				recentProjectIds: [],
				recentWorkspaceIds: [],
			},
			recentEpisodes: [episode],
			projectEpisodes: [],
			workspaceEpisodes: [],
			relevantEpisodes: [],
		});
		const text =
			surface === "memory block"
				? variables.recent_conversations
				: surface.startsWith("Settings")
					? settings.summary
					: episode.summary;
		expect(text).not.toContain(input.executionId);
		expect(text).not.toContain(
			String(input.conversationStartedAt.getTime()),
		);
		expect(text).toContain("First request:");
		expect(text).toContain("Turn 1\nFirst summary");
	});
	it("retains identity and start time in structural sections independent of the ledger", async () => {
		await createEpisodicMemory(input);
		const state = row?.turnSections as { sections: unknown[] } | undefined;
		expect(state?.sections).toEqual([
			expect.objectContaining({
				executionId: input.executionId,
				startedAt: input.conversationStartedAt.toISOString(),
				body: input.summary,
			}),
		]);
		expect(row?.recordedExecutionIds).toEqual([input.executionId]);
	});
	it("uses a tagged insert-if-absent before the owner-scoped row lock", async () => {
		await createEpisodicMemory(input);
		expect(mocks.upsert).not.toHaveBeenCalled();
		expect(mocks.insert).toHaveBeenCalledTimes(1);
		const [sql, ...values] = mocks.insert.mock.calls[0];
		expect(sql.join("?")).toContain(
			'ON CONFLICT ("conversationId") DO NOTHING',
		);
		expect(sql.join("?")).toContain('"userId", "organizationId"');
		expect(values).toContain(input.userId);
		expect(values).toContain(input.organizationId);
		expect(sql.join("?")).not.toContain(input.userId);
		expect(mocks.lock.mock.invocationCallOrder[0]).toBeGreaterThan(
			mocks.insert.mock.invocationCallOrder[0],
		);
	});
	it.each(["next turn", "retry"])(
		"repairs new → old → new writes on a %s",
		async (mode) => {
			await createEpisodicMemory(input);
			const oldText = "Task: Old worker completed a report";
			row = {
				...(row as EpisodicMemory),
				title: "yes",
				summary: oldText,
				turnCount: 900,
				messageCount: 901,
			};
			await createEpisodicMemory({
				...input,
				...(mode === "next turn"
					? {
							executionId: "execution-example-2",
							title: "Follow up with the next project report",
						}
					: {}),
			});
			expect(row?.turnCount).toBe(mode === "next turn" ? 2 : 1);
			expect(row?.messageCount).toBe(mode === "next turn" ? 4 : 2);
			expect(row?.title).toBe(input.title);
			expect(row?.summary).toContain(`First request: ${input.title}`);
			expect(row?.summary).toContain(`Earlier summary\n${oldText}`);
			expect(row?.summary).toContain(input.summary);
			expect(row?.summary.indexOf("Earlier summary")).toBeLessThan(
				row?.summary.indexOf("Turn 1") ?? 0,
			);
			const snapshot = structuredClone(row);
			await createEpisodicMemory(input);
			expect(row).toEqual(snapshot);
		},
	);
	it("keeps the lifetime count and first request after ledger eviction and an old writer", async () => {
		for (let n = 0; n < 55; n++) {
			await createEpisodicMemory({
				...input,
				executionId: `execution-${n}`,
				summary: "Recent result ".repeat(60),
			});
		}
		row = {
			...(row as EpisodicMemory),
			title: "yes",
			summary: "An old worker's final summary",
			turnCount: 900,
			messageCount: 901,
		};
		await createEpisodicMemory({
			...input,
			executionId: "execution-55",
			title: "yes",
		});
		expect(row?.turnCount).toBe(56);
		expect(row?.messageCount).toBe(112);
		expect(row?.summary).toContain(`First request: ${input.title}`);
		expect(row?.recordedExecutionIds).toHaveLength(50);
	});

	it.each(["late turn", "repair retry"])(
		"keeps deleted scope references cleared on a %s",
		async (mode) => {
			const latestInput = {
				...input,
				executionId: "newer-execution",
				projectId: "example-project",
				workspaceId: "example-workspace",
				conversationStartedAt: new Date("2026-10-03"),
			};
			await createEpisodicMemory(latestInput);
			// The foreign keys use ON DELETE SET NULL; repair retries must preserve it.
			row = {
				...(row as EpisodicMemory),
				projectId: null,
				workspaceId: null,
				...(mode === "repair retry"
					? { summary: "Old worker summary" }
					: {}),
			};
			await createEpisodicMemory(
				mode === "repair retry" ? latestInput : input,
			);
			expect(row).toMatchObject({
				projectId: null,
				workspaceId: null,
				turnCount: mode === "repair retry" ? 1 : 2,
			});
		},
	);

	it("keeps the substantive title through yes and do it", async () => {
		await createEpisodicMemory(input);
		await createEpisodicMemory({
			...input,
			executionId: "execution-example-2",
			title: "yes",
		});
		const result = await createEpisodicMemory({
			...input,
			executionId: "execution-example-3",
			title: "do it",
		});
		expect(result.title).toBe(input.title);
		expect(result.turnCount).toBe(3);
		expect(result.messageCount).toBe(6);
	});
	it("upgrades hey to the first substantive normalized title", async () => {
		await createEpisodicMemory({ ...input, title: "hey" });
		const result = await createEpisodicMemory({
			...input,
			executionId: "execution-example-2",
			title: "  List\n the open bugs in this project  ",
		});
		expect(result.title).toBe("List the open bugs in this project");
	});
	it("accumulates ordered sections and keeps the first request while trimming", async () => {
		for (let i = 1; i <= 5; i++) {
			await createEpisodicMemory({
				...input,
				executionId: `execution-example-${i}`,
				summary: `Summary ${i}: ${"x".repeat(600)}`,
				conversationStartedAt: new Date(`2026-10-0${i}`),
			});
		}
		expect(row?.summary.length).toBeLessThanOrEqual(2000);
		expect(row?.summary).toContain(`First request: ${input.title}`);
		expect(row?.summary).not.toContain("Summary 1:");
		expect(row?.summary).toContain("Summary 4:");
		expect(row?.summary).toContain("Summary 5:");
		expect(row?.summary.indexOf("Summary 4:")).toBeLessThan(
			row?.summary.indexOf("Summary 5:") ?? 0,
		);
		expect(row?.summary).toMatch(/Turn \d+/);
	});
	it("leaves the episode unchanged on concurrent retries and after section eviction", async () => {
		await Promise.all([
			createEpisodicMemory(input),
			createEpisodicMemory(input),
		]);
		expect(row?.turnCount).toBe(1);
		const [sql, ...values] = mocks.lock.mock.calls[0];
		expect(sql.join("?")).toContain("FOR UPDATE");
		expect(sql.join("?")).toContain(
			'"organizationId" IS NOT DISTINCT FROM ?',
		);
		expect(values).toEqual([
			input.conversationId,
			input.userId,
			input.organizationId,
		]);
		for (let i = 2; i < 6; i++) {
			await createEpisodicMemory({
				...input,
				executionId: `execution-example-${i}`,
				summary: "x".repeat(900),
			});
		}
		const snapshot = structuredClone(row);
		await createEpisodicMemory({
			...input,
			title: "A changed retry should preserve stored values",
			outcome: "failure",
		});
		expect(row).toEqual(snapshot);
	});
	it("unions and caps topics and intents and takes the latest outcome", async () => {
		await createEpisodicMemory(input);
		await createEpisodicMemory({
			...input,
			executionId: "execution-example-2",
			keyTopics: ["planning", "debug", "api", "data", "test", "extra"],
			userIntents: ["plan", "fix", "review", "extra"],
			outcome: "success",
		});
		expect(row?.keyTopics).toEqual([
			"planning",
			"debug",
			"api",
			"data",
			"test",
		]);
		expect(row?.userIntents).toEqual(["plan", "fix", "review"]);
		expect(row?.outcome).toBe("success");
	});
	it.each(["earlier start", "equal start"])(
		"inserts a late older completion once before a newer section and retains the newer outcome (%s)",
		async (ordering) => {
			await createEpisodicMemory({
				...input,
				executionId: "newer-execution",
				summary: "Newer summary",
				outcome: "success",
				conversationStartedAt: new Date("2026-10-03"),
				conversationEndedAt: new Date("2026-10-04"),
			});
			await createEpisodicMemory({
				...input,
				summary: "Older summary",
				conversationStartedAt: new Date(
					ordering === "equal start" ? "2026-10-03" : "2026-10-01",
				),
				conversationEndedAt: new Date("2026-10-05"),
			});
			expect(row?.summary).toContain("Newer summary");
			expect(row?.summary.indexOf("Older summary")).toBeLessThan(
				row?.summary.indexOf("Newer summary") ?? 0,
			);
			expect(row?.outcome).toBe("success");
			expect(row?.turnCount).toBe(2);
			const snapshot = structuredClone(row);
			await createEpisodicMemory(input);
			expect(row).toEqual(snapshot);
		},
	);
	it("evicts a large late older section before the newer section", async () => {
		await createEpisodicMemory({
			...input,
			executionId: "newer-execution",
			summary: "Newer summary",
			conversationStartedAt: new Date("2026-10-03"),
		});
		await createEpisodicMemory({ ...input, summary: "older ".repeat(600) });
		expect(row?.summary).toContain("Newer summary");
		expect(row?.summary.length).toBeLessThanOrEqual(2000);
	});
	it("caps retry identities to the most recent 50 recorded executions", async () => {
		for (let i = 1; i <= 55; i++) {
			await createEpisodicMemory({
				...input,
				executionId: `execution-example-${i}`,
			});
		}
		expect(row?.recordedExecutionIds).toHaveLength(50);
		expect(row?.recordedExecutionIds[0]).toBe("execution-example-6");
		expect(row?.turnCount).toBe(55);
		expect(row?.messageCount).toBe(110);
	});
	it("retains timestamps and vector reference and starts real counts for an empty legacy ledger", async () => {
		await createEpisodicMemory({
			...input,
			qdrantPointId: "point-example",
			qdrantCollection: "example-episodes",
		});
		const createdAt = row?.createdAt;
		row = {
			...(row as EpisodicMemory),
			recordedExecutionIds: [],
			turnSections: {},
			summary: "Legacy summary",
			turnCount: 42,
			messageCount: 43,
		};
		await createEpisodicMemory({
			...input,
			executionId: "execution-example-2",
			conversationStartedAt: new Date("2026-10-02"),
		});
		expect(row).toMatchObject({
			createdAt,
			conversationStartedAt: input.conversationStartedAt,
			qdrantPointId: "point-example",
			qdrantCollection: "example-episodes",
			turnCount: 1,
			messageCount: 2,
		});
		expect(row?.summary).toContain("Legacy summary");
	});
	it.each([
		{ userId: "user-example-2" },
		{ organizationId: "example-other-org" },
		{ organizationId: null },
	])("rejects another owner without changing the row (%j)", async (owner) => {
		await createEpisodicMemory(input);
		const snapshot = structuredClone(row);
		await expect(
			createEpisodicMemory({
				...input,
				...owner,
				title: "Forbidden replacement",
			}),
		).rejects.toThrow("owner mismatch");
		expect(row).toEqual(snapshot);
	});
	it("rejects moving a null organization into an organization", async () => {
		await createEpisodicMemory({ ...input, organizationId: null });
		const snapshot = structuredClone(row);
		await expect(createEpisodicMemory(input)).rejects.toThrow(
			"owner mismatch",
		);
		expect(row).toEqual(snapshot);
	});
});
