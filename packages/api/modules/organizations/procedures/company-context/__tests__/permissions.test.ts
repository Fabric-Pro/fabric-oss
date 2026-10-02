/**
 * Who may call the company context procedures (Fizzy #2719).
 *
 * The chain is the Brand kit's, run for real: `requireInputOrgPermission`
 * against the organization in the input, then membership (reads) or
 * admin/owner membership (writes) of that organization, then the
 * COMPANY_CONTEXT gate. `CONTEXT_*` is never involved — the member role holds
 * `CONTEXT_CREATE/UPDATE/DELETE`, and a member must still be refused every
 * write here.
 */
import { beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("@repo/database", async () =>
	(await import("./support/harness")).databaseModule(),
);
vi.mock("@repo/temporal", async () =>
	(await import("./support/harness")).temporalModule(),
);
vi.mock("@repo/rag", async () =>
	(await import("./support/harness")).ragModule(),
);
vi.mock("@repo/ai", async () => (await import("./support/harness")).aiModule());
vi.mock("@repo/storage", async () =>
	(await import("./support/harness")).storageModule(),
);
vi.mock("@repo/utils", async (importOriginal) =>
	(await import("./support/harness")).utilsModule(importOriginal),
);
vi.mock("@repo/logs", async () =>
	(await import("./support/harness")).logsModule(),
);
vi.mock("@repo/config", async () =>
	(await import("./support/harness")).configModule(),
);
vi.mock("../../../../../lib/audit", async () =>
	(await import("./support/harness")).auditModule(),
);
vi.mock("../../../../../lib/realtime", () => ({
	emitContextChange: vi.fn(),
	emitActivity: vi.fn(),
}));
vi.mock("../../../../../lib/notification-service", () => ({
	createNotification: vi.fn(),
}));
vi.mock("../../../../../lib/temporal-correlation", () => ({
	withCorrelationMemo: <T>(options: T) => options,
}));
vi.mock("../../../../../orpc/procedures", async () =>
	(await import("./support/harness")).proceduresModule(),
);

import { cancelCompanyContextUrlSourceCrawlProcedure } from "../cancel-url-source-crawl";
import { createCompanyContextDownloadUrlProcedure } from "../create-download-url";
import { createCompanyContextTextProcedure } from "../create-text";
import { createCompanyContextUploadUrlProcedure } from "../create-upload-url";
import { deleteCompanyContextSourceProcedure } from "../delete";
import { getCompanyContextSourceProcedure } from "../get";
import { listCompanyContextSourcesProcedure } from "../list";
import { listCompanyContextUrlPagesProcedure } from "../list-url-pages";
import { processCompanyContextFileProcedure } from "../process-file";
import { processCompanyContextLinkProcedure } from "../process-link";
import { reprocessCompanyContextProcedure } from "../reprocess";
import { resyncCompanyContextUrlSourceProcedure } from "../resync-url-source";
import { updateCompanyContextMetadataProcedure } from "../update-metadata";
import {
	call,
	inputSchemaOf,
	mocks,
	ORG,
	rejection,
	resetDefaults,
	sourceRow,
	storeSources,
} from "./support/harness";

interface Case {
	name: string;
	procedure: unknown;
	input: Record<string, unknown>;
}

const READS: Case[] = [
	{
		name: "list",
		procedure: listCompanyContextSourcesProcedure,
		input: { organizationId: ORG },
	},
	{
		name: "get",
		procedure: getCompanyContextSourceProcedure,
		input: { organizationId: ORG, sourceId: "src_text" },
	},
	{
		name: "listUrlPages",
		procedure: listCompanyContextUrlPagesProcedure,
		input: { organizationId: ORG, sourceId: "src_link" },
	},
	{
		name: "createDownloadUrl",
		procedure: createCompanyContextDownloadUrlProcedure,
		input: { organizationId: ORG, sourceId: "src_text" },
	},
];

const WRITES: Case[] = [
	{
		name: "createUploadUrl",
		procedure: createCompanyContextUploadUrlProcedure,
		input: {
			organizationId: ORG,
			filename: "capabilities.pdf",
			mimeType: "application/pdf",
			size: 1024,
		},
	},
	{
		name: "processFile",
		procedure: processCompanyContextFileProcedure,
		input: { organizationId: ORG, sourceId: "src_file" },
	},
	{
		name: "createText",
		procedure: createCompanyContextTextProcedure,
		input: {
			organizationId: ORG,
			title: "About us",
			content: "We deliver warehouse software.",
		},
	},
	{
		name: "processLink",
		procedure: processCompanyContextLinkProcedure,
		input: { organizationId: ORG, url: "https://example.com/about" },
	},
	{
		name: "updateMetadata",
		procedure: updateCompanyContextMetadataProcedure,
		input: {
			organizationId: ORG,
			sourceId: "src_text",
			sourceType: "Case study",
		},
	},
	{
		name: "resyncUrlSource",
		procedure: resyncCompanyContextUrlSourceProcedure,
		input: { organizationId: ORG, sourceId: "src_link" },
	},
	{
		name: "cancelUrlSourceCrawl",
		procedure: cancelCompanyContextUrlSourceCrawlProcedure,
		input: { organizationId: ORG, sourceId: "src_crawling" },
	},
	{
		name: "delete",
		procedure: deleteCompanyContextSourceProcedure,
		input: { organizationId: ORG, sourceId: "src_text" },
	},
	{
		name: "reprocess",
		procedure: reprocessCompanyContextProcedure,
		input: { organizationId: ORG, sourceId: "src_text" },
	},
];

const ALL = [...READS, ...WRITES];

/** Every mock a write reaches once it is authorized. */
function writeSideEffects() {
	return [
		mocks.workflowStart,
		mocks.createCompanyFileSource,
		mocks.createCompanyTextSource,
		mocks.createCompanyLinkSource,
		mocks.updateCompanyContextSourceStatus,
		mocks.claimCompanyFileSourceForProcessing,
		mocks.claimCompanyContextSourceForReprocess,
		mocks.releaseCompanyContextSourceClaim,
		mocks.updateCompanyContextSourceMetadata,
		mocks.getSignedUploadUrl,
		mocks.recordAudit,
	];
}

beforeEach(() => {
	resetDefaults();
	storeSources([
		sourceRow({ id: "src_text" }),
		sourceRow({
			id: "src_file",
			type: "FILE",
			extractionStatus: "PENDING",
			s3Path: `${ORG}/company-context/file.pdf`,
			s3Bucket: "contexts-bucket",
			originalFilename: "file.pdf",
		}),
		sourceRow({
			id: "src_link",
			type: "LINK",
			sourceUrl: "https://example.com/docs",
			urlScope: "PATH_PREFIX",
		}),
		sourceRow({
			id: "src_crawling",
			type: "LINK",
			sourceUrl: "https://example.com/blog",
			extractionStatus: "EXTRACTING",
			urlActiveWorkflowId: "url-crawl-src_crawling",
		}),
	]);
	mocks.updateCompanyContextSourceMetadata.mockImplementation(async () => {
		const source = sourceRow({ id: "src_text", sourceType: "Case study" });
		return {
			status: "updated",
			source,
			before: { sourceType: null, aiInstructions: null },
			after: { sourceType: "Case study", aiInstructions: null },
			changed: ["sourceType"],
		};
	});
});

describe("the permission each procedure declares", () => {
	it.each(ALL.map((c) => [c.name, c] as const))(
		"%s runs the input-organization permission middleware, never a CONTEXT_* one",
		async (name, c) => {
			const { PERMISSION_MIDDLEWARE_TAG } = await vi.importActual<
				typeof import("../../../../../orpc/middleware/require-permission")
			>("../../../../../orpc/middleware/require-permission");
			const middleware = (
				c.procedure as {
					__middleware?: Record<symbol, unknown>;
				}
			).__middleware;
			const declared = middleware?.[PERMISSION_MIDDLEWARE_TAG];
			const isRead = READS.some((read) => read.name === name);
			expect(declared).toBe(isRead ? "org:read" : "org:update");
		},
	);
});

describe("members read, and only admins and owners write", () => {
	it.each(READS.map((c) => [c.name, c] as const))(
		"a member and a viewer can call %s",
		async (_name, c) => {
			await expect(
				call(c.procedure, c.input, "u_member"),
			).resolves.toBeDefined();
			await expect(
				call(c.procedure, c.input, "u_viewer"),
			).resolves.toBeDefined();
		},
	);

	it.each(WRITES.map((c) => [c.name, c] as const))(
		"a member gets FORBIDDEN on %s and nothing is written",
		async (_name, c) => {
			expect(
				await rejection(call(c.procedure, c.input, "u_member")),
			).toBe("FORBIDDEN");
			for (const effect of writeSideEffects()) {
				expect(effect).not.toHaveBeenCalled();
			}
		},
	);

	it.each(WRITES.map((c) => [c.name, c] as const))(
		"an admin and an owner can call %s",
		async (_name, c) => {
			await expect(
				call(c.procedure, c.input, "u_admin"),
			).resolves.toBeDefined();
			await expect(
				call(c.procedure, c.input, "u_owner"),
			).resolves.toBeDefined();
		},
	);
});

describe("everyone outside the organization is refused", () => {
	it.each(ALL.map((c) => [c.name, c] as const))(
		"a platform administrator who is not a member gets FORBIDDEN on %s",
		async (_name, c) => {
			expect(
				await rejection(call(c.procedure, c.input, "u_platform")),
			).toBe("FORBIDDEN");
		},
	);

	it.each(ALL.map((c) => [c.name, c] as const))(
		"a guest of one of the organization's projects gets FORBIDDEN on %s",
		async (_name, c) => {
			expect(await rejection(call(c.procedure, c.input, "u_guest"))).toBe(
				"FORBIDDEN",
			);
			for (const effect of writeSideEffects()) {
				expect(effect).not.toHaveBeenCalled();
			}
		},
	);

	it.each(ALL.map((c) => [c.name, c] as const))(
		"an admin of organization B passing organization A's id gets FORBIDDEN on %s",
		async (_name, c) => {
			expect(
				await rejection(call(c.procedure, c.input, "u_b_admin")),
			).toBe("FORBIDDEN");
			expect(mocks.getOrganizationMembership).toHaveBeenCalledWith(
				ORG,
				"u_b_admin",
			);
		},
	);

	it.each(ALL.map((c) => [c.name, c] as const))(
		"%s refuses a missing or null organization at the input",
		(_name, c) => {
			const schema = inputSchemaOf(c.procedure);
			expect(
				schema.safeParse({ ...c.input, organizationId: null }).success,
			).toBe(false);
			const { organizationId: _omitted, ...withoutOrg } = c.input;
			expect(schema.safeParse(withoutOrg).success).toBe(false);
		},
	);
});

describe("with the gate off, company context does not exist", () => {
	it.each(ALL.map((c) => [c.name, c] as const))(
		"an admin gets NOT_FOUND on %s and nothing is read or written",
		async (_name, c) => {
			mocks.isFeatureEnabled.mockResolvedValue(false);

			expect(await rejection(call(c.procedure, c.input, "u_admin"))).toBe(
				"NOT_FOUND",
			);
			expect(mocks.isFeatureEnabled).toHaveBeenCalledWith(
				"COMPANY_CONTEXT",
				ORG,
			);
			expect(mocks.listCompanyContextSources).not.toHaveBeenCalled();
			expect(mocks.getCompanyContextSource).not.toHaveBeenCalled();
			expect(mocks.getCompanyContextSourceMeta).not.toHaveBeenCalled();
			for (const effect of writeSideEffects()) {
				expect(effect).not.toHaveBeenCalled();
			}
		},
	);

	it.each(READS.map((c) => [c.name, c] as const))(
		"a member gets NOT_FOUND on %s",
		async (_name, c) => {
			mocks.isFeatureEnabled.mockResolvedValue(false);
			expect(
				await rejection(call(c.procedure, c.input, "u_member")),
			).toBe("NOT_FOUND");
		},
	);
});
