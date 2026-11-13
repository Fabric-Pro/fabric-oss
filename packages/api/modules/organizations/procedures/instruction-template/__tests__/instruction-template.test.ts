/**
 * Organization-level template for coding instructions.
 *
 * Naming a template is what lets every other project of the organization copy
 * its published files without access to the template project, so both the
 * read and the write are admin/owner-only, and the write accepts only a live
 * project of the same organization whose instructions are uploaded to Fabric.
 *
 * The harness parses input through each procedure's own zod schema and the
 * result through its output schema, as `attachment-retention.test.ts` does.
 */

import { beforeEach, describe, expect, it, vi } from "vitest";

const { mocks } = vi.hoisted(() => ({
	mocks: {
		getTemplate: vi.fn(),
		updateTemplate: vi.fn(),
		findCandidate: vi.fn(),
		listCandidates: vi.fn(),
		requireOrgMembership: vi.fn(),
		recordAudit: vi.fn(),
	},
}));

vi.mock("@repo/database", () => ({
	getOrganizationInstructionTemplate: (...a: unknown[]) =>
		mocks.getTemplate(...a),
	updateOrganizationInstructionTemplate: (...a: unknown[]) =>
		mocks.updateTemplate(...a),
	findInstructionTemplateCandidate: (...a: unknown[]) =>
		mocks.findCandidate(...a),
	listInstructionTemplateCandidates: (...a: unknown[]) =>
		mocks.listCandidates(...a),
}));

vi.mock("../../../lib/membership", () => ({
	requireOrgMembership: (...a: unknown[]) => mocks.requireOrgMembership(...a),
}));

vi.mock("../../../../../lib/audit", () => ({
	recordAuditFromRequest: (...a: unknown[]) => mocks.recordAudit(...a),
}));

vi.mock("../../../../../orpc/procedures", () => {
	type Chainable = Record<string, unknown> & {
		_schema?: { parse?: (v: unknown) => unknown };
		_output?: { parse?: (v: unknown) => unknown };
	};
	const makeBuilder = (): Chainable => {
		const builder: Chainable = {};
		Object.assign(builder, {
			use: () => builder,
			route: () => builder,
			input: (schema: Chainable["_schema"]) => {
				builder._schema = schema;
				return builder;
			},
			output: (schema: Chainable["_output"]) => {
				builder._output = schema;
				return builder;
			},
			handler: (fn: (...args: unknown[]) => unknown) => ({
				_handler: fn,
				_schema: builder._schema,
				_output: builder._output,
			}),
		});
		return builder;
	};

	return {
		tenantProtectedProcedure: {
			use: (...a: unknown[]) =>
				(makeBuilder().use as (...x: unknown[]) => unknown)(...a),
		},
		requirePermission: vi.fn(() => ({})),
		Permissions: new Proxy({}, { get: (_t, prop: string) => String(prop) }),
	};
});

import {
	getOrganizationInstructionTemplateProcedure,
	updateOrganizationInstructionTemplateProcedure,
} from "../index";

const ORG_ID = "org-1";
const PROJECT_ID = "proj-template";
const context = {
	user: { id: "user-1", email: "user@example.com" },
	session: { id: "sess-1" },
};

type BuiltProcedure = {
	_handler: (args: { input: unknown; context: unknown }) => Promise<unknown>;
	_schema?: { parse: (v: unknown) => unknown };
	_output?: { parse: (v: unknown) => unknown };
};

async function invoke(procedure: unknown, input: Record<string, unknown>) {
	const built = procedure as BuiltProcedure;
	const parsed = built._schema ? built._schema.parse(input) : input;
	const result = await built._handler({ input: parsed, context });
	built._output?.parse(result);
	return result;
}

const callGet = (input: Record<string, unknown>) =>
	invoke(getOrganizationInstructionTemplateProcedure, input);
const callUpdate = (input: Record<string, unknown>) =>
	invoke(updateOrganizationInstructionTemplateProcedure, input);

beforeEach(() => {
	vi.clearAllMocks();
	mocks.requireOrgMembership.mockResolvedValue({
		organization: { id: ORG_ID },
		role: "admin",
	});
	mocks.getTemplate.mockResolvedValue(null);
	mocks.findCandidate.mockResolvedValue({
		id: PROJECT_ID,
		name: "Example template",
		eligible: true,
	});
	mocks.listCandidates.mockResolvedValue([]);
	mocks.updateTemplate.mockImplementation(
		async (input: { projectId: string | null }) => ({
			projectId: input.projectId,
		}),
	);
});

describe("organizations.instructionTemplate.update", () => {
	it("rejects a caller who is not an admin or owner", async () => {
		mocks.requireOrgMembership.mockResolvedValue(null);

		await expect(
			callUpdate({ organizationId: ORG_ID, projectId: PROJECT_ID }),
		).rejects.toMatchObject({ code: "FORBIDDEN" });
		expect(mocks.requireOrgMembership).toHaveBeenCalledWith(
			"user-1",
			ORG_ID,
			["admin", "owner"],
		);
		expect(mocks.updateTemplate).not.toHaveBeenCalled();
	});

	it("names a live upload-mode project of the organization", async () => {
		const result = await callUpdate({
			organizationId: ORG_ID,
			projectId: PROJECT_ID,
		});

		expect(mocks.findCandidate).toHaveBeenCalledWith(PROJECT_ID, ORG_ID);
		expect(mocks.updateTemplate).toHaveBeenCalledWith({
			organizationId: ORG_ID,
			projectId: PROJECT_ID,
		});
		expect(result).toEqual({ success: true, projectId: PROJECT_ID });
	});

	it("refuses a project that is not a live project of this organization", async () => {
		mocks.findCandidate.mockResolvedValue(null);

		await expect(
			callUpdate({ organizationId: ORG_ID, projectId: "proj-elsewhere" }),
		).rejects.toMatchObject({ code: "NOT_FOUND" });
		expect(mocks.updateTemplate).not.toHaveBeenCalled();
	});

	it("refuses a project that may not be the template", async () => {
		mocks.findCandidate.mockResolvedValue({
			id: PROJECT_ID,
			name: "Example template",
			eligible: false,
		});

		await expect(
			callUpdate({ organizationId: ORG_ID, projectId: PROJECT_ID }),
		).rejects.toMatchObject({ code: "PRECONDITION_FAILED" });
		expect(mocks.updateTemplate).not.toHaveBeenCalled();
	});

	it("accepts null to clear the template without checking any project", async () => {
		const result = await callUpdate({
			organizationId: ORG_ID,
			projectId: null,
		});

		expect(mocks.findCandidate).not.toHaveBeenCalled();
		expect(mocks.updateTemplate).toHaveBeenCalledWith({
			organizationId: ORG_ID,
			projectId: null,
		});
		expect(result).toEqual({ success: true, projectId: null });
	});

	it("rejects an empty project id", async () => {
		await expect(
			callUpdate({ organizationId: ORG_ID, projectId: "" }),
		).rejects.toThrow();
		expect(mocks.updateTemplate).not.toHaveBeenCalled();
	});

	it("emits an audit event carrying the stored value", async () => {
		await callUpdate({ organizationId: ORG_ID, projectId: PROJECT_ID });

		expect(mocks.recordAudit).toHaveBeenCalledWith(
			context,
			expect.objectContaining({
				action: "org.settings.updated",
				category: "org",
				organizationId: ORG_ID,
				resource: { type: "organization", id: ORG_ID, name: null },
				metadata: {
					setting: "instructionTemplateProjectId",
					value: PROJECT_ID,
				},
			}),
		);
	});
});

describe("organizations.instructionTemplate.get", () => {
	it("returns nulls when no template is set", async () => {
		const result = await callGet({ organizationId: ORG_ID });

		expect(mocks.getTemplate).toHaveBeenCalledWith(ORG_ID);
		expect(result).toEqual({
			projectId: null,
			projectName: null,
			candidates: [],
		});
	});

	it("returns the template project and the projects that may be named", async () => {
		mocks.getTemplate.mockResolvedValue({
			projectId: PROJECT_ID,
			projectName: "Example template",
			publishedSnapshotId: "snap-1",
		});
		const candidates = [
			{ id: PROJECT_ID, name: "Example template", published: true },
			{ id: "proj-new", name: "Example service", published: false },
		];
		mocks.listCandidates.mockResolvedValue(candidates);

		const result = await callGet({ organizationId: ORG_ID });

		expect(mocks.listCandidates).toHaveBeenCalledWith(ORG_ID);
		expect(result).toEqual({
			projectId: PROJECT_ID,
			projectName: "Example template",
			candidates,
		});
	});

	it("rejects a caller who is not an admin or owner", async () => {
		mocks.requireOrgMembership.mockResolvedValue(null);

		await expect(callGet({ organizationId: ORG_ID })).rejects.toMatchObject(
			{ code: "FORBIDDEN" },
		);
		expect(mocks.getTemplate).not.toHaveBeenCalled();
		expect(mocks.listCandidates).not.toHaveBeenCalled();
	});
});
