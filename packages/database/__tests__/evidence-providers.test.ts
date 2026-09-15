import { beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
	client: {
		codingRun: { count: vi.fn() },
		projectDocument: { findFirst: vi.fn() },
	},
}));

vi.mock("../prisma/client", () => ({
	db: { ...mocks.client, $transaction: async (fn: any) => fn(mocks.client) },
}));

import {
	_resetDefaultEvidenceProviderRegistration,
	countAcceptedSpikeRuns,
	hasCompleteIntegrationContract,
	registerDefaultEvidenceProviders,
} from "../src/delivery/evidence-providers";
import {
	_resetReadinessEvidenceProviders,
	loadReadinessEvidence,
} from "../src/delivery/transition-story";

const client = mocks.client as any;

beforeEach(() => {
	vi.clearAllMocks();
	_resetReadinessEvidenceProviders();
	_resetDefaultEvidenceProviderRegistration();
});

describe("evidence providers", () => {
	it("counts only COMPLETED SPIKE runs with findings for the story", async () => {
		client.codingRun.count.mockResolvedValue(2);
		const n = await countAcceptedSpikeRuns(client, {
			storyId: "s",
			projectId: "p",
		});
		expect(n).toBe(2);
		expect(client.codingRun.count).toHaveBeenCalledWith({
			where: {
				storyId: "s",
				projectId: "p",
				kind: "SPIKE",
				status: "COMPLETED",
				findings: { not: null },
			},
		});
	});

	it("requires a COMPLETE, active INTEGRATION_CONTRACT for the story", async () => {
		client.projectDocument.findFirst.mockResolvedValue(null);
		expect(
			await hasCompleteIntegrationContract(client, {
				storyId: "s",
				projectId: "p",
			}),
		).toBe(false);
		expect(client.projectDocument.findFirst).toHaveBeenCalledWith(
			expect.objectContaining({
				where: expect.objectContaining({
					type: "INTEGRATION_CONTRACT",
					status: "COMPLETE",
					isActive: true,
				}),
			}),
		);
		client.projectDocument.findFirst.mockResolvedValue({ id: "d" });
		expect(
			await hasCompleteIntegrationContract(client, {
				storyId: "s",
				projectId: "p",
			}),
		).toBe(true);
	});

	it("registers both providers once and merges their evidence", async () => {
		registerDefaultEvidenceProviders();
		registerDefaultEvidenceProviders();
		client.codingRun.count.mockResolvedValue(1);
		client.projectDocument.findFirst.mockResolvedValue({ id: "d" });
		const evidence = await loadReadinessEvidence(client, {
			storyId: "s",
			projectId: "p",
		});
		expect(evidence).toEqual({
			acceptedSpikeRuns: 1,
			integrationContractComplete: true,
		});
		expect(client.codingRun.count).toHaveBeenCalledTimes(1);
	});

	it("fails closed when a provider throws", async () => {
		registerDefaultEvidenceProviders();
		client.codingRun.count.mockRejectedValue(new Error("db down"));
		const evidence = await loadReadinessEvidence(client, {
			storyId: "s",
			projectId: "p",
		});
		expect(evidence.evidenceUnavailable).toBe(true);
	});
});
