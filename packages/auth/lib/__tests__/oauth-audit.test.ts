import { beforeEach, describe, expect, it, vi } from "vitest";

const recordAudit = vi.hoisted(() => vi.fn());
vi.mock("@repo/database", () => ({ recordAudit }));

const issuedGrantOfConsent = vi.hoisted(() => vi.fn());
vi.mock("../oauth-project-binding", () => ({ issuedGrantOfConsent }));

import { auditOAuthConsent, emitOAuthConsentAudit } from "../oauth-audit";

const CONSENTING = {
	id: "user-1",
	email: "dev@example.com",
	name: "Example Developer",
};

function consent(
	body: unknown,
	overrides: { returned?: unknown; path?: string } = {},
) {
	return {
		path: overrides.path ?? "/oauth2/consent",
		body,
		context: {
			session: { user: CONSENTING },
			returned: overrides.returned,
		},
	};
}

const ACCEPTED = {
	accept: true,
	oauth_query: "client_id=client-1&scope=mcp%3Aread+instructions%3Aread",
};

beforeEach(() => {
	vi.clearAllMocks();
});

describe("auditing an approved agent", () => {
	it("records an organization grant in its organization, without a project", () => {
		emitOAuthConsentAudit(consent(ACCEPTED), {
			organizationId: "org-example-alpha",
			projectId: null,
		});

		expect(recordAudit).toHaveBeenCalledWith(
			expect.objectContaining({
				action: "account.oauth.consent_granted",
				organizationId: "org-example-alpha",
				resource: { type: "oauth_client", id: "client-1", name: null },
				metadata: { scopes: ["mcp:read", "instructions:read"] },
			}),
		);
	});

	it("records a project grant in the organization hosting the project, naming the project", () => {
		emitOAuthConsentAudit(consent(ACCEPTED), {
			organizationId: "org-example-alpha",
			projectId: "project-example-one",
		});

		expect(recordAudit).toHaveBeenCalledWith(
			expect.objectContaining({
				organizationId: "org-example-alpha",
				metadata: {
					scopes: ["mcp:read", "instructions:read"],
					projectId: "project-example-one",
				},
			}),
		);
	});

	it("still records the approval, in no organization, when the grant could not be read back", () => {
		emitOAuthConsentAudit(consent(ACCEPTED), null);

		expect(recordAudit).toHaveBeenCalledWith(
			expect.objectContaining({ organizationId: null }),
		);
	});

	it("records nothing for a denial, a failed request or another endpoint", () => {
		const grant = { organizationId: "org-example-alpha", projectId: null };

		emitOAuthConsentAudit(consent({ accept: false }), grant);
		emitOAuthConsentAudit(
			consent(ACCEPTED, { returned: new Error("refused") }),
			grant,
		);
		emitOAuthConsentAudit(
			consent(ACCEPTED, { path: "/oauth2/token" }),
			grant,
		);

		expect(recordAudit).not.toHaveBeenCalled();
	});
});

describe("auditing the grant a consent issued", () => {
	function approval(options: { signedIn?: boolean } = {}) {
		const approved = consent(ACCEPTED);
		return {
			...approved,
			context: {
				...approved.context,
				session:
					options.signedIn === false ? null : { user: CONSENTING },
				internalAdapter: { findVerificationValue: vi.fn() },
				adapter: { findOne: vi.fn() },
			},
		};
	}

	it("records the grant read back from the response, for the person who consented", async () => {
		issuedGrantOfConsent.mockResolvedValue({
			organizationId: "org-example-alpha",
			projectId: "project-example-one",
		});
		const ctx = approval();

		await auditOAuthConsent(ctx);

		expect(issuedGrantOfConsent).toHaveBeenCalledWith(ctx, "user-1");
		expect(recordAudit).toHaveBeenCalledWith(
			expect.objectContaining({
				organizationId: "org-example-alpha",
				metadata: expect.objectContaining({
					projectId: "project-example-one",
				}),
			}),
		);
	});

	it("still records the approval, in no organization, when the grant cannot be read back", async () => {
		issuedGrantOfConsent.mockRejectedValue(new Error("lookup failed"));

		await auditOAuthConsent(approval());

		expect(recordAudit).toHaveBeenCalledWith(
			expect.objectContaining({ organizationId: null }),
		);
	});

	it("reads no grant for a consent nobody is signed in for", async () => {
		await auditOAuthConsent(approval({ signedIn: false }));

		expect(issuedGrantOfConsent).not.toHaveBeenCalled();
		expect(recordAudit).not.toHaveBeenCalled();
	});
});
