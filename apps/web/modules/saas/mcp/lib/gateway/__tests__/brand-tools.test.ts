import { beforeEach, describe, expect, it, vi } from "vitest";

const m = vi.hoisted(() => ({
	read: vi.fn(),
	styleRead: vi.fn(),
	styleSave: vi.fn(),
	company: vi.fn(),
	client: vi.fn(),
	audit: vi.fn(),
}));
vi.mock("@repo/api/modules/branding/lib/brand-commands", async () => {
	const { z } = await import("zod");
	const projectId = z.string().optional();
	return {
		artifactBrandReadSchema: z.object({ projectId }).strict(),
		companyBrandSaveSchema: z
			.object({
				expectedVersion: z.number().int().min(0),
				guidance: z.string(),
			})
			.strict(),
		clientBrandSaveSchema: z
			.object({
				projectId: z.string(),
				expectedVersion: z.number().int().min(0),
				name: z.string().nullable(),
				website: z.string().nullable(),
				colors: z.array(z.string()),
			})
			.strict(),
		getArtifactBrandCommand: m.read,
		saveCompanyBrandCommand: m.company,
		saveClientBrandCommand: m.client,
	};
});
vi.mock("@repo/api/modules/branding/lib/proposal-style-commands", () => ({
	getProposalStyleCommand: m.styleRead,
	saveProposalStyleCommand: m.styleSave,
}));
vi.mock("@repo/database", () => ({ recordAudit: m.audit }));

import { projectBoundTools, serviceSessionHasTool } from "../project-binding";

vi.mock("@repo/api/modules/v1/instruction-direct-repository", () => ({
	getDirectRepositoryState: vi.fn(),
}));

import { executePlatformTool } from "../platform-tools";
import { credentialAllowsTool } from "../tool-eligibility";
import { createBrandTools } from "../tools/brand-tools";
import type { GatewaySession } from "../types";

const family = createBrandTools();
const session = (changes: Partial<GatewaySession> = {}) =>
	({
		userId: "example-user",
		organizationId: "example-org",
		credential: "organization-key",
		scopes: ["projects:read"],
		...changes,
	}) as GatewaySession;
const call = (name: string, args: Record<string, unknown>, ctx = session()) =>
	family.handlers.get(name)?.(args, ctx);
beforeEach(() => {
	vi.clearAllMocks();
	m.read.mockResolvedValue({ clientVersion: 2 });
	m.client.mockResolvedValue({ outcome: "applied", version: 3 });
});
describe("brand MCP tools", () => {
	it("binds brand reads to the connected project", async () => {
		const result = await call(
			"fabric_get_artifact_brand",
			{},
			session({ projectId: "example-project" }),
		);
		expect(result.isError).not.toBe(true);
		expect(m.read).toHaveBeenCalledWith(
			{ userId: "example-user", organizationId: "example-org" },
			{ projectId: "example-project" },
		);
	});
	it("refuses a project escape before calling the command", async () => {
		const result = await call(
			"fabric_get_artifact_brand",
			{ projectId: "example-other-project" },
			session({ pinnedProjectId: "example-project" }),
		);
		expect(result.isError).toBe(true);
		expect(m.read).not.toHaveBeenCalled();
	});
	it("refuses company reads on a projects-only key without a project", async () => {
		expect((await call("fabric_get_artifact_brand", {})).isError).toBe(
			true,
		);
		expect(m.read).not.toHaveBeenCalled();
	});
	it("requires write scope independently of current actor checks", async () => {
		const args = {
			projectId: "example-project",
			expectedVersion: 2,
			name: "Example",
			website: null,
			colors: [],
		};
		expect((await call("fabric_update_client_brand", args)).isError).toBe(
			true,
		);
		expect(m.client).not.toHaveBeenCalled();
		await call(
			"fabric_update_client_brand",
			args,
			session({ scopes: ["projects:write"] }),
		);
		expect(m.client).toHaveBeenCalledOnce();
	});
	it("wildcard credentials still reach the canonical current-actor guard", async () => {
		m.company.mockRejectedValue(
			Object.assign(new Error("Administrator access required"), {
				code: "FORBIDDEN",
			}),
		);
		const result = await call(
			"fabric_update_company_brand",
			{ expectedVersion: 2, guidance: "Reviewed" },
			session({ scopes: ["*"] }),
		);
		expect(m.company).toHaveBeenCalledOnce();
		expect(result.isError).toBe(true);
	});
	it("does not permit company saves through the MCP umbrella or runtime", async () => {
		for (const ctx of [
			session({ scopes: ["mcp:write"] }),
			session({ credential: "service", scopes: ["orgs:write"] }),
		]) {
			expect(
				(
					await call(
						"fabric_update_company_brand",
						{ expectedVersion: 2, guidance: "Reviewed" },
						ctx,
					)
				).isError,
			).toBe(true);
		}
		expect(m.company).not.toHaveBeenCalled();
		expect(serviceSessionHasTool({}, "fabric_update_company_brand")).toBe(
			false,
		);
	});
	it("requires review for brand writes and never exposes them to page scripts", () => {
		for (const name of [
			"fabric_update_client_brand",
			"fabric_update_company_brand",
		]) {
			expect(
				family.definitions.find((d) => d.name === name)?._meta,
			).toMatchObject({ "fabric/confirm": true });
		}
		expect(
			projectBoundTools(family.definitions).map((t) => t.name),
		).toEqual([
			"fabric_get_artifact_brand",
			"fabric_update_client_brand",
			"fabric_get_proposal_style",
			"fabric_update_proposal_style",
		]);
	});
	it("rejects actor and tenant injection", async () => {
		const result = await call(
			"fabric_get_artifact_brand",
			{
				projectId: "example-project",
				organizationId: "example-other-org",
			},
			session({ scopes: ["*"] }),
		);
		expect(result.isError).toBe(true);
		expect(m.read).not.toHaveBeenCalled();
	});
	it("allows company-only read credentials and uses project scope only for project reads", async () => {
		expect(
			(
				await call(
					"fabric_get_artifact_brand",
					{},
					session({ scopes: ["orgs:read"] }),
				)
			).isError,
		).not.toBe(true);
		expect(m.read).toHaveBeenCalledWith(
			{ userId: "example-user", organizationId: "example-org" },
			{},
		);
		m.read.mockClear();
		expect(
			(
				await call(
					"fabric_get_artifact_brand",
					{ projectId: "example-project" },
					session({ scopes: ["orgs:read"] }),
				)
			).isError,
		).toBe(true);
		expect(m.read).not.toHaveBeenCalled();
	});

	it("discovers and executes company reads with orgs:read alone across the platform boundary", async () => {
		const organization = session({ scopes: ["orgs:read"] });
		expect(
			credentialAllowsTool(organization, {
				name: "fabric_get_artifact_brand",
			}),
		).toBe(true);
		expect(
			credentialAllowsTool(session({ scopes: ["projects:read"] }), {
				name: "fabric_get_artifact_brand",
			}),
		).toBe(true);
		const result = await executePlatformTool(
			"fabric_get_artifact_brand",
			{},
			organization,
		);
		expect(result.isError).not.toBe(true);
		expect(m.read).toHaveBeenCalledOnce();
	});
});

describe("Proposal Style MCP parity", () => {
	it("allows read discovery for a project service but requires confirmation and write scope to save", async () => {
		const read = family.definitions.find(
			(d) => d.name === "fabric_get_proposal_style",
		);
		const write = family.definitions.find(
			(d) => d.name === "fabric_update_proposal_style",
		);
		expect(read?.annotations?.readOnlyHint).toBe(true);
		expect(write?._meta).toMatchObject({ "fabric/confirm": true });
		expect(
			serviceSessionHasTool(
				{ pinnedProjectId: "example-project" },
				"fabric_get_proposal_style",
			),
		).toBe(true);
		const args = {
			projectId: "example-project",
			documentId: "example-document",
			expectedUpdatedAt: null,
			brandSource: "CLIENT",
			coverStyle: "LIGHT",
		};
		expect((await call("fabric_update_proposal_style", args)).isError).toBe(
			true,
		);
		expect(m.styleSave).not.toHaveBeenCalled();
		await call(
			"fabric_update_proposal_style",
			args,
			session({ scopes: ["projects:write"] }),
		);
		expect(m.styleSave).toHaveBeenCalledWith(
			{ userId: "example-user", organizationId: "example-org" },
			args,
			expect.any(Function),
		);
	});
	it("rejects escaped projects and unknown fonts before canonical writes", async () => {
		await call(
			"fabric_get_proposal_style",
			{
				projectId: "example-other-project",
				documentId: "example-document",
			},
			session({ pinnedProjectId: "example-project" }),
		);
		expect(m.styleRead).not.toHaveBeenCalled();
		await call(
			"fabric_update_client_brand",
			{
				projectId: "example-project",
				expectedVersion: 0,
				name: "Example",
				website: null,
				colors: [],
				displayFontFamily: "Unbundled font",
			},
			session({ scopes: ["projects:write"] }),
		);
		expect(m.client).not.toHaveBeenCalled();
	});
});

describe("branding discovery matches handler consent", () => {
	it.each([
		["fabric_get_frame_branding", "frames:read"],
		["fabric_apply_frame_branding", "frames:write"],
		["fabric_get_report_branding", "reports:read"],
		["fabric_get_report_instance_branding", "reports:read"],
		["fabric_apply_report_branding", "reports:write"],
	])(
		"does not advertise %s to a generic MCP or runtime credential",
		(name, scope) => {
			const tool = { name };
			expect(
				credentialAllowsTool(
					{
						credential: "organization-key",
						scopes: ["mcp:read", "mcp:write"],
					},
					tool,
				),
			).toBe(false);
			expect(
				credentialAllowsTool(
					{ credential: "service", scopes: ["mcp:read"] },
					tool,
				),
			).toBe(false);
			expect(
				credentialAllowsTool(
					{ credential: "oauth", scopes: ["mcp:read"] },
					tool,
				),
			).toBe(false);
			expect(
				credentialAllowsTool(
					{ credential: "organization-key", scopes: [scope] },
					tool,
				),
			).toBe(true);
			expect(
				credentialAllowsTool(
					{ credential: "organization-key", scopes: ["*"] },
					tool,
				),
			).toBe(true);
			expect(
				credentialAllowsTool(
					{ credential: "session", scopes: [] },
					tool,
				),
			).toBe(true);
		},
	);
	it("preserves the existing generic MCP consent for ordinary project tools", () => {
		expect(
			credentialAllowsTool(
				{ credential: "organization-key", scopes: ["mcp:read"] },
				{ name: "fabric_list_projects" },
			),
		).toBe(true);
	});
});
