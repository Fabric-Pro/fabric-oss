/**
 * `projects.proposalArtifact.getThemeTokens` and the client-document loader
 * behind it (Fizzy #2946): a Proposal in artifact mode wears one theme for
 * members and project guests alike, so a guest with project access reads
 * its tokens, with the logos signed, and never the style direction or the
 * Brand kit guidance.
 *
 * The gate middleware, the permission decision and the loader are the real
 * ones, run over the world in `proposal-artifact-harness.ts`. The
 * client-document predicate is driven by that world's flags, and the token
 * resolver is a mock: its database reads, and the proof that they select no
 * internal field, are in the database package's
 * `proposal-artifact-mode.test.ts`. Storage signing is a mock that records
 * every key it was asked to sign.
 */
import { beforeEach, describe, expect, it, vi } from "vitest";

const theme = vi.hoisted(() => ({
	isProposalClientDocument: vi.fn(),
	resolveGuestSafeProposalThemeTokens: vi.fn(),
	getSignedUrl: vi.fn(),
}));

vi.mock("@repo/database", async () => ({
	...(await (await import("./proposal-artifact-harness")).databaseModule()),
	isProposalClientDocument: theme.isProposalClientDocument,
	resolveGuestSafeProposalThemeTokens:
		theme.resolveGuestSafeProposalThemeTokens,
}));
vi.mock("@repo/storage", async () => ({
	...(await vi.importActual<typeof import("@repo/storage")>("@repo/storage")),
	getStorageProvider: () => ({ getSignedUrl: theme.getSignedUrl }),
}));
vi.mock("../../../../../orpc/procedures", async () =>
	(await import("./proposal-artifact-harness")).proceduresModule(),
);

import { config } from "@repo/config";
import {
	buildProposalThemeTokens,
	type ProposalThemeSources,
	type ProposalThemeTokens,
} from "@repo/utils/proposal-artifact/theme-tokens";
import { assertProjectPermission } from "../../../../../orpc/middleware/require-permission";
import { signThemeAsset } from "../../../lib/brand-logo-reads";
import { loadProposalClientDocument } from "../../../lib/proposal-artifact-access";
import { getProposalThemeTokensProcedure } from "../get-theme-tokens";
import {
	call,
	DOC_A,
	DOC_A2,
	DOC_B,
	DOC_PRD,
	declaredPermission,
	mocks,
	ORG_A,
	ORG_B,
	PROJECT_A,
	PROJECT_B,
	PROPOSAL_BODY,
	refusal,
	resetMocks,
	resetWorld,
	USERS,
	usePermissionCheck,
	world,
} from "./proposal-artifact-harness";

usePermissionCheck(assertProjectPermission);

const AVATARS = config.storage.bucketNames.avatars;
const PROJECT_CONTEXTS = config.storage.bucketNames.projectContexts;
const ORG_LOGO = `${ORG_A}.png`;
const RECIPIENT_LOGO = `project-brand/${PROJECT_A}/recipient-brand/current/logo-1.png`;
const DOC_BUSINESS_CASE = "doc-business-case";
/** An org A member with no row on project A, and not its creator. */
const MEMBER_WITHOUT_PROJECT = "user-member-without-project";

const SOURCES: ProposalThemeSources = {
	organization: { name: "Example Org", logoKey: ORG_LOGO },
	style: { primaryColor: "#123456", accentColors: ["#abcdef"] },
	brandKit: { accentColors: ["#fedcba"] },
	recipient: {
		name: "Example Client",
		logoKey: RECIPIENT_LOGO,
		colors: ["#0a0b0c"],
	},
};

function tokensFrom(
	overrides: Partial<ProposalThemeSources> = {},
): ProposalThemeTokens {
	return buildProposalThemeTokens({ ...SOURCES, ...overrides });
}

const signed = (bucket: string, key: string) =>
	`https://storage.example.com/${bucket}/${key}?signed`;

function getThemeTokens(
	userId: string = USERS.guestViewer,
	ids: { projectId: string; documentId: string } = {
		projectId: PROJECT_A,
		documentId: DOC_A,
	},
) {
	return call(getProposalThemeTokensProcedure, ids, userId) as Promise<{
		tokens: ProposalThemeTokens<{ url: string }>;
	}>;
}

function signedKeys(): string[] {
	return theme.getSignedUrl.mock.calls.map(([key]) => String(key));
}

function nothingResolved() {
	expect(theme.resolveGuestSafeProposalThemeTokens).not.toHaveBeenCalled();
	expect(theme.getSignedUrl).not.toHaveBeenCalled();
}

/** Every key anywhere in a value, at any depth. */
function deepKeys(value: unknown): string[] {
	if (Array.isArray(value)) {
		return value.flatMap(deepKeys);
	}
	if (value && typeof value === "object") {
		return Object.entries(value).flatMap(([key, child]) => [
			key,
			...deepKeys(child),
		]);
	}
	return [];
}

beforeEach(() => {
	resetWorld();
	resetMocks();
	theme.isProposalClientDocument.mockReset();
	theme.resolveGuestSafeProposalThemeTokens.mockReset();
	theme.getSignedUrl.mockReset();

	world.documents.set(DOC_BUSINESS_CASE, {
		id: DOC_BUSINESS_CASE,
		projectId: PROJECT_A,
		type: "BUSINESS_CASE",
		content: PROPOSAL_BODY,
	});
	world.orgMembers.set(`${ORG_A}:${MEMBER_WITHOUT_PROJECT}`, "member");

	// The real rule over the world's flags: a Proposal, in an organization
	// whose PROPOSAL_ARTIFACT gate is on.
	theme.isProposalClientDocument.mockImplementation(
		async (args: {
			organizationId: string | null | undefined;
			documentType: string;
		}) =>
			Boolean(args.organizationId) &&
			args.documentType === "PROPOSAL" &&
			(world.flags.get(args.organizationId as string) ?? false),
	);
	theme.resolveGuestSafeProposalThemeTokens.mockResolvedValue(tokensFrom());
	theme.getSignedUrl.mockImplementation(
		async (key: string, options: { bucket: string }) =>
			signed(options.bucket, key),
	);
});

describe("declared chain", () => {
	it("runs the rollout gate, then DOCUMENT_READ", () => {
		const chain = (
			getProposalThemeTokensProcedure as { __chain: unknown[] }
		).__chain;
		expect(chain).toHaveLength(2);
		expect(typeof chain[0]).toBe("function");
		expect(declaredPermission(getProposalThemeTokensProcedure)).toBe(
			"document:read",
		);
	});
});

describe("getThemeTokens", () => {
	it.each([
		["a project guest with a VIEWER role", USERS.guestViewer],
		["a project guest with an EDITOR role", USERS.guestEditor],
		["an organization member", USERS.editor],
		["the owner", USERS.owner],
	])("gives %s the tokens with both logos signed", async (_label, userId) => {
		const { tokens } = await getThemeTokens(userId);

		expect(tokens.proposer.name).toEqual({
			value: "Example Org",
			source: "BRAND_KIT",
		});
		expect(tokens.proposer.logo).toEqual({
			value: { url: signed(AVATARS, ORG_LOGO) },
			source: "BRAND_KIT",
		});
		expect(tokens.proposer.primary).toEqual({
			value: "#123456",
			source: "MANUAL",
		});
		expect(tokens.proposer.hero).toEqual({
			value: null,
			source: "DEFAULT",
		});
		expect(tokens.recipient).toEqual({
			name: { value: "Example Client", source: "MANUAL" },
			logo: {
				value: { url: signed(PROJECT_CONTEXTS, RECIPIENT_LOGO) },
				source: "MANUAL",
			},
			colors: { value: ["#0a0b0c"], source: "MANUAL" },
		});
	});

	it("reads the tokens in the owning organization, never the guest's own, and asks about no membership", async () => {
		await getThemeTokens(USERS.guestViewer);

		expect(theme.resolveGuestSafeProposalThemeTokens).toHaveBeenCalledWith({
			organizationId: ORG_A,
			projectId: PROJECT_A,
			documentId: DOC_A,
		});
		expect(theme.isProposalClientDocument).toHaveBeenCalledWith({
			organizationId: ORG_A,
			documentType: "PROPOSAL",
		});
		expect(mocks.isOrganizationMember).not.toHaveBeenCalled();
		// Nothing from the members' Style tab is read either.
		expect(mocks.getDocumentStyle).not.toHaveBeenCalled();
	});

	it("signs each logo inline as a PNG, in its own bucket", async () => {
		await getThemeTokens();

		expect(theme.getSignedUrl).toHaveBeenCalledWith(
			ORG_LOGO,
			expect.objectContaining({
				bucket: AVATARS,
				responseContentType: "image/png",
				responseContentDisposition: "inline",
			}),
		);
		expect(theme.getSignedUrl).toHaveBeenCalledWith(
			RECIPIENT_LOGO,
			expect.objectContaining({
				bucket: PROJECT_CONTEXTS,
				responseContentType: "image/png",
				responseContentDisposition: "inline",
			}),
		);
	});

	it("carries no style direction or Brand kit guidance, and nothing but the tokens", async () => {
		// Even a resolver that handed them over could not put them on the wire.
		theme.resolveGuestSafeProposalThemeTokens.mockResolvedValue({
			...tokensFrom(),
			styleDirection: "Internal: stress the discount.",
			guidance: "Internal: never name the competitor.",
		});

		const result = await getThemeTokens();

		expect(Object.keys(result)).toEqual(["tokens"]);
		expect(Object.keys(result.tokens).sort()).toEqual([
			"proposer",
			"recipient",
		]);
		expect(Object.keys(result.tokens.proposer).sort()).toEqual([
			"accents",
			"fonts",
			"hero",
			"ink",
			"logo",
			"name",
			"primary",
			"surface",
		]);
		const keys = deepKeys(result);
		expect(keys).not.toContain("styleDirection");
		expect(keys).not.toContain("guidance");
		expect(keys).not.toContain("brandGuidance");
		expect(JSON.stringify(result)).not.toContain("Internal:");
	});

	it("refuses a caller without access to the project", async () => {
		const result = await refusal(getThemeTokens(USERS.outsider));

		expect(result.code).toBe("NOT_FOUND");
		nothingResolved();
	});

	it("refuses an organization member who has no access to this project, as NOT_FOUND", async () => {
		const result = await refusal(getThemeTokens(MEMBER_WITHOUT_PROJECT));

		expect(result.code).toBe("NOT_FOUND");
		nothingResolved();
	});

	it.each([
		["a Business Case", DOC_BUSINESS_CASE],
		["a PRD", DOC_PRD],
	])("refuses %s as NOT_FOUND", async (_label, documentId) => {
		for (const userId of [USERS.editor, USERS.guestViewer]) {
			expect(
				await refusal(
					getThemeTokens(userId, {
						projectId: PROJECT_A,
						documentId,
					}),
				),
			).toMatchObject({
				code: "NOT_FOUND",
				message: "Document not found",
			});
		}
		nothingResolved();
	});

	it("answers NOT_FOUND to every caller with the gate off", async () => {
		world.flags.set(ORG_A, false);

		for (const userId of [
			USERS.owner,
			USERS.editor,
			USERS.guestEditor,
			USERS.guestViewer,
			USERS.outsider,
		]) {
			expect((await refusal(getThemeTokens(userId))).code).toBe(
				"NOT_FOUND",
			);
		}
		nothingResolved();
	});

	it.each([
		["another project in the same organization", DOC_A2],
		["another organization", DOC_B],
	])(
		"refuses a document of %s named under this project",
		async (_label, documentId) => {
			const result = await refusal(
				getThemeTokens(USERS.owner, {
					projectId: PROJECT_A,
					documentId,
				}),
			);

			expect(result).toMatchObject({
				code: "NOT_FOUND",
				message: "Document not found",
			});
			nothingResolved();
		},
	);

	it("refuses an outsider pairing their own project with this document", async () => {
		const result = await refusal(
			getThemeTokens(USERS.outsider, {
				projectId: PROJECT_B,
				documentId: DOC_A,
			}),
		);

		expect(result.code).toBe("NOT_FOUND");
		nothingResolved();
	});

	it("signs no recipient logo outside this project's promoted prefix", async () => {
		const foreign = [
			`project-brand/${PROJECT_B}/recipient-brand/current/logo-9.png`,
			`project-brand/${PROJECT_A}/recipient-brand/pending/logo-1.png`,
			`document-media/${PROJECT_A}/${DOC_A}/logo.png`,
		];
		for (const logoKey of foreign) {
			theme.resolveGuestSafeProposalThemeTokens.mockResolvedValue(
				tokensFrom({
					recipient: { name: "Example Client", logoKey, colors: [] },
				}),
			);

			const { tokens } = await getThemeTokens();

			expect(tokens.recipient.logo.value, logoKey).toBeNull();
			expect(tokens.recipient.name.value).toBe("Example Client");
		}
		for (const key of foreign) {
			expect(signedKeys()).not.toContain(key);
		}
	});

	it("signs no organization logo but the key its own upload writes", async () => {
		const untrusted = [
			`${ORG_B}.png`,
			"user-owner.png",
			`${ORG_A}/logo.png`,
			`/${ORG_A}.png`,
			"https://cdn.example.com/logo.png",
		];
		for (const logoKey of untrusted) {
			theme.resolveGuestSafeProposalThemeTokens.mockResolvedValue(
				tokensFrom({ organization: { name: "Example Org", logoKey } }),
			);

			const { tokens } = await getThemeTokens();

			expect(tokens.proposer.logo.value, logoKey).toBeNull();
		}
		const avatarReads = theme.getSignedUrl.mock.calls.filter(
			([, options]) => (options as { bucket: string }).bucket === AVATARS,
		);
		expect(avatarReads).toEqual([]);
	});

	it("still answers when a logo cannot be signed, without that logo", async () => {
		theme.getSignedUrl.mockRejectedValue(new Error("signing failed"));

		const { tokens } = await getThemeTokens();

		expect(tokens.proposer.logo).toEqual({
			value: null,
			source: "BRAND_KIT",
		});
		expect(tokens.recipient.logo).toEqual({
			value: null,
			source: "MANUAL",
		});
		expect(tokens.proposer.name.value).toBe("Example Org");
	});
});

describe("loadProposalClientDocument", () => {
	function load(
		userId: string,
		ids: { projectId: string; documentId: string } = {
			projectId: PROJECT_A,
			documentId: DOC_A,
		},
	) {
		return loadProposalClientDocument({ ...ids, userId });
	}

	it("loads a Proposal for a project guest and for a member alike, in the owning organization", async () => {
		for (const userId of [
			USERS.guestViewer,
			USERS.guestEditor,
			USERS.editor,
		]) {
			expect(await load(userId)).toEqual({
				document: { id: DOC_A, type: "PROPOSAL" },
				organizationId: ORG_A,
			});
		}
		expect(mocks.isOrganizationMember).not.toHaveBeenCalled();
	});

	it("answers NOT_FOUND, not FORBIDDEN, to a caller without project access", async () => {
		for (const userId of [MEMBER_WITHOUT_PROJECT, USERS.outsider]) {
			expect(await refusal(load(userId))).toMatchObject({
				code: "NOT_FOUND",
				message: "Document not found",
			});
		}
	});

	it("words every refusal the same, so the order of its checks tells nothing", async () => {
		const project = world.projects.get(PROJECT_A);
		const refusals = [
			await refusal(load(MEMBER_WITHOUT_PROJECT)),
			await refusal(
				load(MEMBER_WITHOUT_PROJECT, {
					projectId: PROJECT_A,
					documentId: DOC_B,
				}),
			),
			await refusal(
				load(USERS.editor, {
					projectId: PROJECT_A,
					documentId: DOC_BUSINESS_CASE,
				}),
			),
			await refusal(
				load(USERS.editor, {
					projectId: "proj-missing",
					documentId: DOC_A,
				}),
			),
		];
		world.flags.set(ORG_A, false);
		refusals.push(await refusal(load(USERS.editor)));
		world.flags.set(ORG_A, true);
		world.projects.set(PROJECT_A, {
			...(project as NonNullable<typeof project>),
			deletedAt: new Date("2026-10-01T00:00:00.000Z"),
		});
		refusals.push(await refusal(load(USERS.editor)));

		for (const result of refusals) {
			expect(result).toEqual({
				code: "NOT_FOUND",
				message: "Document not found",
				data: undefined,
			});
		}
	});

	it("refuses a project outside any organization without asking the predicate", async () => {
		const project = world.projects.get(PROJECT_A);
		world.projects.set(PROJECT_A, {
			...(project as NonNullable<typeof project>),
			organizationId: null,
		});

		expect((await refusal(load(USERS.owner))).code).toBe("NOT_FOUND");
		expect(theme.isProposalClientDocument).not.toHaveBeenCalled();
	});

	it("checks the predicate with the document's own type", async () => {
		await refusal(
			load(USERS.guestViewer, {
				projectId: PROJECT_A,
				documentId: DOC_BUSINESS_CASE,
			}),
		);

		expect(theme.isProposalClientDocument).toHaveBeenCalledWith({
			organizationId: ORG_A,
			documentType: "BUSINESS_CASE",
		});
	});
});

describe("signThemeAsset", () => {
	const ctx = { organizationId: ORG_A, projectId: PROJECT_A };

	it("signs a trusted organization logo and a promoted recipient logo", async () => {
		expect(
			await signThemeAsset(
				{ kind: "organization-logo", key: ORG_LOGO },
				ctx,
			),
		).toEqual({ url: signed(AVATARS, ORG_LOGO) });
		expect(
			await signThemeAsset(
				{ kind: "recipient-logo", key: RECIPIENT_LOGO },
				ctx,
			),
		).toEqual({ url: signed(PROJECT_CONTEXTS, RECIPIENT_LOGO) });
	});

	it("checks each key against its own kind", async () => {
		// A recipient key presented as the organization's logo, and the
		// reverse, are both refused before storage is touched.
		expect(
			await signThemeAsset(
				{ kind: "organization-logo", key: RECIPIENT_LOGO },
				ctx,
			),
		).toBeNull();
		expect(
			await signThemeAsset(
				{ kind: "recipient-logo", key: ORG_LOGO },
				ctx,
			),
		).toBeNull();
		// Another organization's or project's context changes the answer.
		expect(
			await signThemeAsset(
				{ kind: "organization-logo", key: ORG_LOGO },
				{ organizationId: ORG_B, projectId: PROJECT_A },
			),
		).toBeNull();
		expect(
			await signThemeAsset(
				{ kind: "recipient-logo", key: RECIPIENT_LOGO },
				{ organizationId: ORG_A, projectId: PROJECT_B },
			),
		).toBeNull();
		expect(theme.getSignedUrl).not.toHaveBeenCalled();
	});

	it("passes the TTL it is given, and lasts five minutes by default", async () => {
		await signThemeAsset({ kind: "organization-logo", key: ORG_LOGO }, ctx);
		await signThemeAsset(
			{ kind: "recipient-logo", key: RECIPIENT_LOGO },
			ctx,
			120,
		);

		expect(
			theme.getSignedUrl.mock.calls.map(([, options]) => options),
		).toEqual([
			expect.objectContaining({ expiresIn: 5 * 60 }),
			expect.objectContaining({ expiresIn: 120 }),
		]);
	});

	it("is null when storage cannot sign", async () => {
		theme.getSignedUrl.mockRejectedValue(new Error("signing failed"));

		expect(
			await signThemeAsset(
				{ kind: "organization-logo", key: ORG_LOGO },
				ctx,
			),
		).toBeNull();
	});
});
