import { beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({ upsert: vi.fn(), findUnique: vi.fn() }));
vi.mock("../../client", () => ({
	db: { aiOutputProvenance: mocks },
}));

import {
	getAiOutputProvenance,
	recordAiOutputProvenance,
} from "../ai-output-provenance";

const subject = {
	organizationId: "example-org",
	userId: "example-user",
	subjectType: "copilot-message",
	subjectId: "msg_1793000000000_0123456789abcdef0123456789abcdef",
};
beforeEach(() => vi.clearAllMocks());
describe("output provenance queries", () => {
	it("upserts on organization, user and subject, replacing the snapshot for a later call", async () => {
		await recordAiOutputProvenance({
			...subject,
			projectId: "example-project",
			agentId: "project_document_generator",
			modelCanonicalName: "example-model",
		});
		expect(mocks.upsert).toHaveBeenCalledWith({
			where: { organizationId_userId_subjectType_subjectId: subject },
			create: {
				...subject,
				projectId: "example-project",
				agentId: "project_document_generator",
				modelCanonicalName: "example-model",
				promptVersionId: null,
			},
			update: {
				projectId: "example-project",
				agentId: "project_document_generator",
				modelCanonicalName: "example-model",
				promptVersionId: null,
			},
		});
	});
	it.each([
		subject,
		{ ...subject, userId: "example-other-user" },
		{ ...subject, organizationId: "example-other-org" },
	])("reads only the exact identity %j", async (key) => {
		await getAiOutputProvenance(key);
		expect(mocks.findUnique).toHaveBeenCalledWith({
			where: { organizationId_userId_subjectType_subjectId: key },
			select: {
				agentId: true,
				projectId: true,
				modelCanonicalName: true,
				promptVersionId: true,
			},
		});
	});
});
