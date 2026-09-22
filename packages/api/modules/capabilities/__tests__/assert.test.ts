/**
 * What a door lets through, and what it logs (Fizzy #1930 review round).
 *
 * The rules and the resolver run for real; only the flag and the evidence
 * gather are stood in for.
 */

import { beforeEach, describe, expect, it, vi } from "vitest";

const { mocks } = vi.hoisted(() => ({
	mocks: {
		gatherCapabilityEvidence: vi.fn(),
		loggerInfo: vi.fn(),
	},
}));

vi.mock("../flag", () => ({ isCapabilityGatingEnabled: async () => true }));
vi.mock("../evidence", () => ({
	gatherCapabilityEvidence: mocks.gatherCapabilityEvidence,
}));
vi.mock("@repo/logs", () => ({
	logger: { info: mocks.loggerInfo, warn: vi.fn(), error: vi.fn() },
}));

import { assertCapabilityAvailable, findRefusedCapabilities } from "../assert";
import { evidenceWith } from "./evidence-fixture";

const DOOR = {
	projectId: "project_example",
	userId: "user_example",
	organizationId: "organization_example",
};

/** No document, no context, no repository. */
function barren() {
	return evidenceWith({
		codebase: { connected: false, integrationStatus: null, usable: false },
		context: { total: 0, technical: 0, product: 0 },
		documents: { usableTypes: new Set<string>() },
		descriptionLength: 0,
	});
}

beforeEach(() => {
	vi.clearAllMocks();
	mocks.gatherCapabilityEvidence.mockResolvedValue(barren());
});

describe("assertCapabilityAvailable", () => {
	it("refuses a missing source and logs the refusal with its facts", async () => {
		await expect(
			assertCapabilityAvailable({
				...DOOR,
				capabilityKey: "documents.generate-api-spec",
			}),
		).rejects.toMatchObject({ code: "PRECONDITION_FAILED" });

		expect(mocks.loggerInfo).toHaveBeenCalledWith(
			"[CapabilityGate] Refused at the door",
			{
				capabilityKey: "documents.generate-api-spec",
				reasonKey: "documents.no-api-source",
				state: "SOFT_BLOCK",
				projectId: "project_example",
			},
		);
	});

	it("lets source text supplied with the request answer a soft block", async () => {
		await expect(
			assertCapabilityAvailable({
				...DOOR,
				capabilityKey: "documents.generate-api-spec",
				permitSoftBlock: true,
			}),
		).resolves.toMatchObject({ state: "SOFT_BLOCK" });
	});

	it("lets supplied text lift the repository-only block on the default project shape", async () => {
		// Repository connected, code search off (the schema default), nothing
		// else to ground an API specification: the pasted API docs are the
		// source, so the door must let the request through.
		mocks.gatherCapabilityEvidence.mockResolvedValue(
			evidenceWith({
				codebase: {
					usable: false,
					indexingEnabled: false,
					lastIndexCompletedAt: null,
				},
				context: { total: 0, technical: 0, product: 0 },
				documents: { usableTypes: new Set(["PRD"]) },
			}),
		);
		await expect(
			assertCapabilityAvailable({
				...DOOR,
				capabilityKey: "documents.generate-api-spec",
				permitSoftBlock: true,
			}),
		).resolves.toMatchObject({
			state: "SOFT_BLOCK",
			reasonKey: "codebase.code-search-off",
		});
	});

	it("does not let supplied text answer a hard block", async () => {
		mocks.gatherCapabilityEvidence.mockResolvedValue(
			evidenceWith({
				codebase: { integrationStatus: "TOKEN_EXPIRED", usable: true },
			}),
		);
		await expect(
			assertCapabilityAvailable({
				...DOOR,
				capabilityKey: "atlas.codebase-qa",
				permitSoftBlock: true,
			}),
		).rejects.toMatchObject({ code: "PRECONDITION_FAILED" });
	});

	it("lets a generator whose source is still generating through to the queue", async () => {
		const e = barren();
		e.documents = { ...e.documents, inFlightTypes: new Set(["PRD"]) };
		mocks.gatherCapabilityEvidence.mockResolvedValue(e);

		await expect(
			assertCapabilityAvailable({
				...DOOR,
				capabilityKey: "documents.generate-architecture",
			}),
		).resolves.toMatchObject({ reasonKey: "documents.source-processing" });
	});
});

describe("findRefusedCapabilities — the batch door", () => {
	it("counts earlier types in the same batch as on their way", async () => {
		// The wizard generates a PRD and an architecture document together;
		// the workflow runs the PRD first, so the architecture must not be
		// refused for lacking it.
		const refused = await findRefusedCapabilities({
			...DOOR,
			capabilityKeys: ["documents.generate-architecture"],
			alsoInFlightTypes: ["PRD", "ARCHITECTURE"],
		});
		expect(refused).toEqual([]);
	});

	it("returns the types that cannot run, with a message, without throwing", async () => {
		const refused = await findRefusedCapabilities({
			...DOOR,
			capabilityKeys: [
				"documents.generate-architecture",
				"documents.generate-api-spec",
			],
			alsoInFlightTypes: ["PRD", "ARCHITECTURE", "API_SPEC"],
		});
		// Architecture waits on the batch's PRD. The API specification does
		// not wait on the batch's architecture document — same tier, run side
		// by side — and a PRD does not ground it, so it is refused.
		expect(refused.map((entry) => entry.gate.capabilityKey)).toEqual([
			"documents.generate-api-spec",
		]);

		const alone = await findRefusedCapabilities({
			...DOOR,
			capabilityKeys: ["documents.generate-api-spec"],
			alsoInFlightTypes: ["API_SPEC"],
		});
		expect(alone.map((entry) => entry.gate.reasonKey)).toEqual([
			"documents.no-api-source",
		]);
		expect(alone[0].message).toContain("an API-relevant source");
	});

	it("gathers the evidence once for the whole batch", async () => {
		await findRefusedCapabilities({
			...DOOR,
			capabilityKeys: [
				"documents.generate-architecture",
				"documents.generate-tech-spec",
				"documents.generate-qa-strategy",
			],
			alsoInFlightTypes: [],
		});
		expect(mocks.gatherCapabilityEvidence).toHaveBeenCalledTimes(1);
	});
});
