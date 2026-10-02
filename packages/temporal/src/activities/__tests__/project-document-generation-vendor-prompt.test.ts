/**
 * The fallback Proposal prompt and company context (Fizzy #2719).
 *
 * With no bound or custom prompt, `generateDocumentWithAgent` writes its own
 * Proposal instructions into the user message, beside the agent's system
 * prompt. When vendor-marked company entries are among the contexts, both
 * permit the one vendor-qualifications section, and this message's forbidden
 * lists drop the entries that section replaces — two prompts that disagreed
 * would leave the model to pick. Without vendor entries the message is as it
 * was. Vendor entries alone also leave the wizard features in, as the
 * project has no context of its own.
 */

import {
	getProposalVendorSectionInstructions,
	getProposalVendorSectionReminder,
} from "@repo/agent-prompts";
import { VENDOR_CONTEXT_MARKER } from "@repo/agent-types";
import { beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
	runsStream: vi.fn(),
	hasProjectAccess: vi.fn(),
	projectFindUnique: vi.fn(),
	fetchAndRenderPrompt: vi.fn(),
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
	streamText: vi.fn(),
}));

vi.mock("@repo/ai/skills", () => ({
	isTextContentType: vi.fn(),
	loadSkillBundle: vi.fn(),
	readSkillFile: vi.fn(),
}));

// No bound prompt: the activity builds its own fallback message.
vi.mock("../prompt-activities", () => ({
	fetchAndRenderPrompt: (...args: unknown[]) =>
		mocks.fetchAndRenderPrompt(...args),
	renderPromptWithContext: vi.fn(),
}));

vi.mock("@temporalio/activity", async () => {
	const temporalCommon = await import("@temporalio/common");
	return {
		Context: { current: { heartbeat: vi.fn() } },
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

import { generateDocumentWithAgent } from "../project-document-generation";

const VENDOR_ENTRY = `${VENDOR_CONTEXT_MARKER}\n[Source: Case study]\nWe rolled out scanning at a regional distributor.`;
const PROJECT_ENTRY = "The client picks 4,000 orders a day on paper.";

/** The user message and project context the agent was handed. */
function agentInput(): {
	message: string;
	features: string[];
} {
	const input = mocks.runsStream.mock.calls[0]?.[2]?.input;
	if (!input) {
		throw new Error("the agent was never called");
	}
	return {
		message: input.messages[0].content,
		features: input.projectContext.features,
	};
}

function generate(
	documentType: string,
	contexts: string[],
	hasRagContexts?: boolean,
) {
	return generateDocumentWithAgent({
		projectId: "project-1",
		documentId: "doc-1",
		documentType,
		prompt: "",
		contexts,
		userId: "user-1",
		organizationId: "org-1",
		aiToken: "token-1",
		hasRagContexts,
	});
}

beforeEach(() => {
	vi.clearAllMocks();
	mocks.hasProjectAccess.mockResolvedValue(true);
	mocks.fetchAndRenderPrompt.mockResolvedValue(null);
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
				data: { document: "### **Project Proposal**\n\nBody." },
			};
		})(),
	);
});

describe("fallback Proposal prompt with company context", () => {
	it("permits the vendor section and drops the entries it replaces when vendor entries are present", async () => {
		await generate("PROPOSAL", [PROJECT_ENTRY, VENDOR_ENTRY], true);

		const { message } = agentInput();
		expect(message).toContain(getProposalVendorSectionInstructions());
		expect(message).toContain(getProposalVendorSectionReminder());
		const fullList = message.match(/❌ FULL FORBIDDEN LIST: (.*)/)?.[1];
		const reminderList = message.match(
			/❌ PROPOSAL FORBIDDEN SECTIONS \(NEVER USE\): (.*)/,
		)?.[1];
		for (const list of [fullList, reminderList]) {
			expect(list).toBeDefined();
			expect(list).not.toContain("Company Overview");
			expect(list).not.toContain("About Us");
			expect(list).not.toContain("Vendor Overview");
			expect(list).toContain("Team Overview");
		}
	});

	it("leaves the prompt as it was without vendor entries", async () => {
		await generate("PROPOSAL", [PROJECT_ENTRY], true);

		const { message } = agentInput();
		expect(message).not.toContain(getProposalVendorSectionInstructions());
		expect(message).not.toContain(getProposalVendorSectionReminder());
		expect(message.match(/❌ FULL FORBIDDEN LIST: (.*)/)?.[1]).toContain(
			"Company Overview",
		);
		expect(
			message.match(
				/❌ PROPOSAL FORBIDDEN SECTIONS \(NEVER USE\): (.*)/,
			)?.[1],
		).toContain("Company Overview");
	});

	it("does not permit the Proposal's vendor section in a Business Case", async () => {
		await generate("BUSINESS_CASE", [VENDOR_ENTRY], false);

		const { message } = agentInput();
		expect(message).not.toContain(getProposalVendorSectionInstructions());
		expect(message).not.toContain(getProposalVendorSectionReminder());
		expect(
			message.match(
				/❌ PROPOSAL FORBIDDEN SECTIONS \(NEVER USE\): (.*)/,
			)?.[1],
		).toContain("Company Overview");
	});

	it("keeps the wizard features when only vendor entries arrived without an explicit flag", async () => {
		await generate("PROPOSAL", [VENDOR_ENTRY]);

		const { message, features } = agentInput();
		expect(features).toEqual(["Barcode scanning"]);
		expect(message).toContain("Features to cover: Barcode scanning");
	});
});
