import { call } from "@orpc/server";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { z } from "zod";
import {
	accessDb,
	describeProjectAccess,
	grantProjectAccess,
	guest,
	installProjectRows,
	organizationId,
	otherOrganizationId,
	type ProjectTestContext,
	projectAccessQuery,
	projectId,
	projectOwner,
	projectProcedureTestExports,
	projectWhere,
	userId,
} from "./support/project-access";

const mocks = vi.hoisted(() => ({
	findEnvironment: vi.fn(),
	listEnvironments: vi.fn(),
	createEnvironment: vi.fn(),
	getEnvironment: vi.fn(),
	updateEnvironment: vi.fn(),
	deleteEnvironment: vi.fn(),
	listCredentials: vi.fn(),
	setCredential: vi.fn(),
	audit: vi.fn(),
	releaseScreenshot: vi.fn(),
	checkUrl: vi.fn(),
	getRag: vi.fn(),
	getChunking: vi.fn(),
	isChunkingChange: vi.fn(),
	saveChunking: vi.fn(),
	upsertRag: vi.fn(),
	resetRefresh: vi.fn(),
	feature: vi.fn(),
	startIndexing: vi.fn(),
	startRechunk: vi.fn(),
	getTemporal: vi.fn(),
	startWorkflow: vi.fn(),
}));

vi.mock("@repo/database", async () => {
	return {
		db: {
			...accessDb,
			projectEnvironment: { findFirst: mocks.findEnvironment },
		},
		grantProjectAccess,
		getOrganizationMembership: vi.fn(),
		getTenantContext: () => ({}),
		hasProjectAccess: await projectAccessQuery(),
		listProjectEnvironments: mocks.listEnvironments,
		createProjectEnvironment: mocks.createEnvironment,
		getProjectEnvironment: mocks.getEnvironment,
		updateProjectEnvironment: mocks.updateEnvironment,
		deleteProjectEnvironment: mocks.deleteEnvironment,
		listEnvironmentAuthSummaries: mocks.listCredentials,
		setEnvironmentAuth: mocks.setCredential,
		getProjectRagSettings: mocks.getRag,
		getProjectChunkingSettings: mocks.getChunking,
		isChunkingChange: mocks.isChunkingChange,
		upsertProjectRagSettings: mocks.upsertRag,
		saveProjectChunkingChange: mocks.saveChunking,
		resetCodeIndexRefreshSchedule: mocks.resetRefresh,
		isFeatureEnabled: mocks.feature,
	};
});

vi.mock("../../../../orpc/procedures", () => projectProcedureTestExports());

vi.mock("../../../../lib/audit", () => ({
	recordAuditFromRequest: mocks.audit,
}));
vi.mock("../../../newsletter/lib/screenshot-environment", () => ({
	releaseScreenshotEnvironment: mocks.releaseScreenshot,
}));
vi.mock("@repo/utils/url-security", () => ({
	assertSafeOutboundUrlResolved: mocks.checkUrl,
}));
vi.mock("@repo/rag", () => ({ chunkProfilesConfigSchema: z.object({}) }));
vi.mock("@repo/temporal", () => ({ getTemporalClient: mocks.getTemporal }));
vi.mock("../../lib/code-indexing-trigger", () => ({
	startCodeIndexingForUnindexedRepos: mocks.startIndexing,
}));
vi.mock("../../lib/project-rechunk", () => ({
	startProjectRechunk: mocks.startRechunk,
}));

import {
	listEnvironmentCredentialsProcedure,
	setEnvironmentCredentialProcedure,
} from "../qa-settings/environment-credentials";
import {
	createProjectEnvironmentProcedure,
	deleteProjectEnvironmentProcedure,
	listProjectEnvironmentsProcedure,
	updateProjectEnvironmentProcedure,
} from "../qa-settings/environments";
import { getRagSettingsProcedure } from "../rag-settings/get-rag-settings";
import { reprocessContextsProcedure } from "../rag-settings/reprocess-contexts";
import { updateRagSettingsProcedure } from "../rag-settings/update-rag-settings";

const environmentId = "example-environment";
const environmentScope = { ...projectWhere, environmentId };
const environment = {
	id: environmentId,
	name: "Example deployment",
	type: "QA" as const,
	baseUrl: "https://example.com/",
	signInUrl: null,
};
const createInput = {
	...projectWhere,
	name: environment.name,
	type: environment.type,
	baseUrl: environment.baseUrl,
};
const credential = {
	...environmentScope,
	authKind: "HEADER" as const,
	authHeaderName: "X-Example-Auth",
	secret: "example-value",
};
const summary = { environmentId, authKind: "HEADER", hasSecret: true };
const settings = { topK: 15, rerankTopK: 5, codeSearchMode: "OFF" };

const requests = [
	{
		name: "list environments",
		run: (context: ProjectTestContext) =>
			call(listProjectEnvironmentsProcedure, projectWhere, { context }),
	},
	{
		name: "create environment",
		write: true,
		run: (context: ProjectTestContext) =>
			call(createProjectEnvironmentProcedure, createInput, { context }),
	},
	{
		name: "update environment",
		write: true,
		run: (context: ProjectTestContext) =>
			call(
				updateProjectEnvironmentProcedure,
				{ ...environmentScope, name: "Renamed" },
				{ context },
			),
	},
	{
		name: "delete environment",
		write: true,
		run: (context: ProjectTestContext) =>
			call(deleteProjectEnvironmentProcedure, environmentScope, {
				context,
			}),
	},
	{
		name: "list credentials",
		run: (context: ProjectTestContext) =>
			call(listEnvironmentCredentialsProcedure, projectWhere, {
				context,
			}),
	},
	{
		name: "set credential",
		write: true,
		run: (context: ProjectTestContext) =>
			call(setEnvironmentCredentialProcedure, credential, { context }),
	},
	{
		name: "get RAG settings",
		run: (context: ProjectTestContext) =>
			call(getRagSettingsProcedure, projectWhere, { context }),
	},
	{
		name: "update RAG settings",
		write: true,
		run: (context: ProjectTestContext) =>
			call(
				updateRagSettingsProcedure,
				{ ...projectWhere, topK: 20 },
				{ context },
			),
	},
	{
		name: "reprocess contexts",
		write: true,
		run: (context: ProjectTestContext) =>
			call(reprocessContextsProcedure, projectWhere, { context }),
	},
];

beforeEach(() => {
	vi.resetAllMocks();
	installProjectRows({ localMember: true });
	mocks.listEnvironments.mockResolvedValue([environment]);
	mocks.createEnvironment.mockResolvedValue(environment);
	mocks.getEnvironment.mockResolvedValue(environment);
	mocks.updateEnvironment.mockResolvedValue({
		...environment,
		name: "Renamed",
	});
	mocks.deleteEnvironment.mockResolvedValue(environment);
	mocks.findEnvironment.mockResolvedValue(environment);
	mocks.listCredentials.mockResolvedValue([summary]);
	mocks.setCredential.mockResolvedValue({ updated: true });
	mocks.getRag.mockResolvedValue(settings);
	mocks.upsertRag.mockResolvedValue({ ...settings, topK: 20 });
	mocks.feature.mockResolvedValue(true);
	mocks.getTemporal.mockResolvedValue({
		workflow: { start: mocks.startWorkflow },
	});
	mocks.startWorkflow.mockResolvedValue({
		workflowId: "example-workflow",
		firstExecutionRunId: "example-run",
	});
});

function assertNoEffects() {
	for (const effect of Object.values(mocks)) {
		expect(effect).not.toHaveBeenCalled();
	}
}

describeProjectAccess(requests, assertNoEffects);

describe("deployment environments and credentials", () => {
	it("lists deployment targets and credential summaries for an invited viewer", async () => {
		installProjectRows({ role: "VIEWER" });
		await expect(
			call(listProjectEnvironmentsProcedure, projectWhere, {
				context: guest(),
			}),
		).resolves.toEqual([environment]);
		await expect(
			call(listEnvironmentCredentialsProcedure, projectWhere, {
				context: guest(),
			}),
		).resolves.toEqual([summary]);
		expect(grantProjectAccess).toHaveBeenCalledWith(
			projectId,
			organizationId,
		);
		expect(mocks.listEnvironments).toHaveBeenCalledExactlyOnceWith(
			projectId,
		);
		expect(mocks.listCredentials).toHaveBeenCalledExactlyOnceWith(
			projectWhere,
		);
	});

	it("creates and audits an environment after verifying the destination", async () => {
		await expect(
			call(createProjectEnvironmentProcedure, createInput, {
				context: projectOwner(),
			}),
		).resolves.toEqual(environment);
		expect(mocks.checkUrl).toHaveBeenCalledExactlyOnceWith(
			environment.baseUrl,
		);
		expect(mocks.createEnvironment).toHaveBeenCalledExactlyOnceWith(
			createInput,
		);
		expect(mocks.audit).toHaveBeenCalledWith(
			expect.anything(),
			expect.objectContaining({
				action: "project.environment.created",
				projectId,
				outcome: "success",
			}),
		);
	});

	it("refuses a sign-in URL from another origin before saving", async () => {
		await expect(
			call(
				createProjectEnvironmentProcedure,
				{
					...createInput,
					signInUrl: "https://example.org/sign-in",
				},
				{ context: projectOwner() },
			),
		).rejects.toMatchObject({
			code: "BAD_REQUEST",
			message: expect.stringContaining("same origin"),
		});
		expect(mocks.createEnvironment).not.toHaveBeenCalled();
	});

	it("updates a project's environment and releases screenshot approval when its URL changes", async () => {
		const baseUrl = "https://example.org/";
		const updated = { ...environment, baseUrl };
		mocks.updateEnvironment.mockResolvedValue(updated);
		const input = { ...environmentScope, baseUrl };
		await expect(
			call(updateProjectEnvironmentProcedure, input, {
				context: projectOwner(),
			}),
		).resolves.toEqual(updated);
		expect(mocks.updateEnvironment).toHaveBeenCalledExactlyOnceWith(input);
		expect(mocks.releaseScreenshot).toHaveBeenCalledExactlyOnceWith(
			expect.objectContaining({
				...environmentScope,
				changed: ["baseUrl"],
			}),
		);
	});

	it("deletes only the environment in the authorized project and audits the removal", async () => {
		await expect(
			call(deleteProjectEnvironmentProcedure, environmentScope, {
				context: projectOwner(),
			}),
		).resolves.toEqual({ success: true });
		expect(mocks.deleteEnvironment).toHaveBeenCalledExactlyOnceWith(
			environmentScope,
		);
		expect(mocks.audit).toHaveBeenCalledWith(
			expect.anything(),
			expect.objectContaining({
				action: "project.environment.deleted",
				projectId,
				outcome: "success",
			}),
		);
	});

	it("stores a project-scoped credential, audits only metadata and returns the redacted summary", async () => {
		await expect(
			call(setEnvironmentCredentialProcedure, credential, {
				context: projectOwner(),
			}),
		).resolves.toEqual(summary);
		expect(mocks.findEnvironment).toHaveBeenCalledExactlyOnceWith({
			where: { id: environmentId, projectId },
			select: { type: true, name: true },
		});
		expect(mocks.setCredential).toHaveBeenCalledExactlyOnceWith({
			...credential,
			authUsername: null,
		});
		expect(mocks.audit).toHaveBeenCalledExactlyOnceWith(
			expect.anything(),
			expect.objectContaining({
				action: "project.environment_credential.updated",
				outcome: "success",
				projectId,
				metadata: {
					authKind: "HEADER",
					environmentName: environment.name,
					environmentType: "QA",
					isProduction: false,
					valueWritten: true,
					valueCleared: false,
					username: null,
				},
			}),
		);
		expect(mocks.releaseScreenshot).toHaveBeenCalledExactlyOnceWith(
			expect.objectContaining({
				...environmentScope,
				changed: ["credential"],
			}),
		);
	});

	it("refuses a credential for an environment absent from the project", async () => {
		mocks.findEnvironment.mockResolvedValue(null);
		await expect(
			call(setEnvironmentCredentialProcedure, credential, {
				context: projectOwner(),
			}),
		).rejects.toMatchObject({
			code: "NOT_FOUND",
			message: "Environment not found",
		});
		expect(mocks.setCredential).not.toHaveBeenCalled();
		expect(mocks.releaseScreenshot).not.toHaveBeenCalled();
	});

	it("refuses HEADER auth without a header name", async () => {
		await expect(
			call(
				setEnvironmentCredentialProcedure,
				{
					...credential,
					authHeaderName: undefined,
				},
				{ context: projectOwner() },
			),
		).rejects.toMatchObject({
			code: "BAD_REQUEST",
			message: expect.stringContaining("header name"),
		});
		expect(mocks.setCredential).not.toHaveBeenCalled();
	});
});

describe("retrieval settings and reprocessing", () => {
	it("reads settings and the host organization's feature flag for an invited viewer", async () => {
		installProjectRows({ role: "VIEWER" });
		await expect(
			call(getRagSettingsProcedure, projectWhere, { context: guest() }),
		).resolves.toEqual({
			settings,
			contentAwareChunkingEnabled: true,
		});
		expect(mocks.getRag).toHaveBeenCalledExactlyOnceWith(projectId);
		expect(mocks.feature).toHaveBeenCalledExactlyOnceWith(
			"CONTENT_AWARE_CHUNKING",
			organizationId,
		);
	});

	it("updates retrieval settings in the project host and leaves chunking alone", async () => {
		installProjectRows({ role: "PROJECT_ADMIN" });
		await expect(
			call(
				updateRagSettingsProcedure,
				{ ...projectWhere, topK: 20 },
				{ context: guest() },
			),
		).resolves.toEqual({
			settings: { ...settings, topK: 20 },
			rechunk: null,
		});
		expect(mocks.upsertRag).toHaveBeenCalledExactlyOnceWith(projectId, {
			topK: 20,
			userId,
			organizationId,
		});
		expect(mocks.startRechunk).not.toHaveBeenCalled();
	});

	it("rejects retrieval settings that request more results than candidates", async () => {
		await expect(
			call(
				updateRagSettingsProcedure,
				{ ...projectWhere, topK: 4 },
				{ context: projectOwner() },
			),
		).rejects.toMatchObject({
			code: "BAD_REQUEST",
			message: expect.stringContaining(
				"must not exceed candidate chunks",
			),
		});
		expect(mocks.upsertRag).not.toHaveBeenCalled();
	});

	it("rejects a caller-supplied foreign organization before reading or writing RAG settings", async () => {
		await expect(
			call(
				updateRagSettingsProcedure,
				{
					...projectWhere,
					organizationId: otherOrganizationId,
					topK: 20,
				},
				{ context: projectOwner() },
			),
		).rejects.toMatchObject({ code: "BAD_REQUEST" });
		expect(mocks.getRag).not.toHaveBeenCalled();
		expect(mocks.upsertRag).not.toHaveBeenCalled();
	});

	it("starts reprocessing using the host organization for an invited admin", async () => {
		installProjectRows({ role: "PROJECT_ADMIN" });
		await expect(
			call(reprocessContextsProcedure, projectWhere, {
				context: guest(),
			}),
		).resolves.toMatchObject({
			workflowId: "example-workflow",
			runId: "example-run",
		});
		expect(mocks.startWorkflow).toHaveBeenCalledExactlyOnceWith(
			"projectContextsReprocessWorkflow",
			expect.objectContaining({
				taskQueue: "project-documents",
				args: [{ projectId, userId, organizationId }],
			}),
		);
	});
});
