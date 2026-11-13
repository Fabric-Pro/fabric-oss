import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";

// Only these structures independently filter ordinary organization members.
const FILTERING_STRUCTURES = [
	"STRICT_ISOLATION_TABLES",
	"PER_USER_ORG_TABLES",
	"SCOPE_BASED_TABLES",
	"USER_OWNED_TABLES",
	"ORG_ONLY_TABLES",
	"PARENT_SCOPED_TABLES",
] as const;

// Parse auxiliary structures too, but do not count them as member filters.
const REGISTRATION_STRUCTURES = [
	"STRICT_ISOLATION_TABLES",
	"PER_USER_ORG_TABLES",
	"ORG_SHARED_READ_TABLES",
	"SCOPE_BASED_TABLES",
	"SCOPE_ORG_VALUE",
	"USER_OWNED_TABLES",
	"ORG_ONLY_TABLES",
	"PROJECT_SCOPED_TABLES",
	"PARENT_SCOPED_TABLES",
	"SPECIAL_TABLES",
] as const;

// Frozen backlog: Fizzy #3550. A new model must not be added without a stated
// reason in the PR. Remove entries as registration is completed.
const UNREGISTERED_BASELINE = [
	"Account",
	"AgentApproval",
	"AgentDeployment",
	"AgentDeploymentExecution",
	"AgentMemoryEdit",
	"AgentMemoryFile",
	"AgentTemplate",
	"AgentTemplateConversation",
	"AgentTemplateExecution",
	"AgentTemplateInstance",
	"AiProviderFallback",
	"AiUsageLimit",
	"ApprovalTemplate",
	"ArchitectureDecision",
	"ArchitectureDecisionComment",
	"ArchitectureDecisionVersion",
	"AtlasAnalysis",
	"AtlasAnalysisRun",
	"AtlasConversation",
	"AtlasCrossEdge",
	"AtlasCrossLink",
	"AtlasCrossLinkRun",
	"AtlasEdge",
	"AtlasEdgeOverride",
	"AtlasEdgeOverrideHistory",
	"AtlasNode",
	"AtlasNodeOverride",
	"AtlasNodeOverrideHistory",
	"AtlasParseCheckpoint",
	"AtlasSystemLayout",
	"AzureAgentDeployment",
	"AzureAiModelDeployment",
	"BacklogUpdateSession",
	"ChannelThreadMapping",
	"ChatArtifact",
	"ChatGptPlanCredential",
	"DailyBrief",
	"DailyBriefView",
	"DataConnectionCredential",
	"DecisionLogEntry",
	"DocumentAssistantConversation",
	"DynamicAgentFavorite",
	"FrameTemplate",
	"GoldenReference",
	"IntegrationApproval",
	"Invitation",
	"KanbanQueue",
	"MCPClientSession",
	"MCPOAuthState",
	"MaturationApprovalPreference",
	"Member",
	"ModelRouterConfig",
	"NewsletterChatDelivery",
	"NewsletterDelivery",
	"NewsletterSend",
	"NewsletterSettings",
	"NewsletterSubscriber",
	"Notification",
	"NotificationDeliveryPreference",
	"NotificationPreference",
	"OauthAccessToken",
	"OauthAuthorizationResource",
	"OauthClient",
	"OauthConsent",
	"OauthRefreshToken",
	"OrganizationDeploymentQuota",
	"OrganizationFeatureFlagOverride",
	"OrganizationRagSettings",
	"Passkey",
	"PendingBacklogProposal",
	"PendingPmStateChange",
	"PmSyncLog",
	"PmTicketMissingStreak",
	"ProjectBriefCursor",
	"ProjectCodeFile",
	"ProjectCodeIndex",
	"ProjectContextSummary",
	"ProjectConversation",
	"ProjectDatabricksKnowledgeBinding",
	"ProjectDocumentAsset",
	"ProjectInvitation", // Deliberately no standard filter: tenant-db.ts, mergeWithTenantFilter case (b).
	"ProjectLinkedSlackChannel",
	"ProjectLinkedTeamsChannel",
	"ProjectLinkedTeamsChat",
	"ProjectMeetingActionItem",
	"ProjectMember", // Deliberately no standard filter: tenant-db.ts, mergeWithTenantFilter case (b).
	"ProjectRepositoryIntegration",
	"ProjectScan",
	"ProjectScanCheckpoint",
	"ProjectScanConfig",
	"ProjectSlackHuddleNote",
	"ProjectStoryStatus",
	"ProjectUserFunctionTag",
	"PromptBinding",
	"PromptNomination",
	"PromptVote",
	"PublishingTopicRead",
	"QaAnalysisVersion",
	"RecurringErrorSignature",
	"RequestSpan",
	"ScanActivity",
	"ScanFinding",
	"ScanFindingGrouping",
	"ScanFindingReview",
	"Session",
	"Skill",
	"StoryDuplicateEmbedding",
	"StoryDuplicateFocusEmbedding",
	"StoryDuplicateLink",
	"StoryPriorityChange",
	"StoryRoutingEmbedding",
	"StoryTaskComment",
	"Subscription",
	"TaskQueueShard",
	"TaskWorkflowPlan",
	"TemplateInstanceArtifactEmailDelivery",
	"TestCaseScriptRevision",
	"TwoFactor",
	"UserApiKey",
	"UserChatAgentSelection",
	"UserCloudProviderConfig",
	"UserDeploymentQuota",
	"UserModelPreference",
	"UserOrchestratorPreferences",
	"UserRagProvider",
	"UserSearchProvider",
	"UserStory", // Deliberately no standard filter: tenant-db.ts, mergeWithTenantFilter case (b).
	"UserStoryComment",
	"WeavePlanTemplate",
	"WorkspaceAdministrator",
	"WorkspaceContributor",
	"WorkspaceStakeholder",
];

// Frozen backlog: Fizzy #3550. A new model must not be added without a stated
// reason in the PR. Remove entries as project scoping is completed.
const PROJECT_SCOPE_BASELINE = [
	"AgentDeploymentTrigger",
	"AiChat",
	"AiUsageLog",
	"AuditLog",
	"CodeSymbol",
	"DailyBriefReleaseNoteExclusion",
	"DocumentAutoRefreshSettings",
	"EpisodicMemory",
	"ProblemLogEntry",
	"ProjectDocumentAnalysis",
	"ProjectDocumentExportBrand",
	"ProjectDocumentFindingResponse",
	"ProjectDocumentStyle",
	"ProjectInstructionPendingStorageCleanup",
	"ProjectRecipientBrandSuggestion",
	"ProjectWorkspaceDocumentLink",
	"ReportTemplateOverride",
	"StageTransitionRequest",
	"WeaveExecution",
	"WeavePlan",
	"Workflow",
];

// getProjectCarveOut has a dedicated AgentWorkspaceFile branch that grants
// guest access without PROJECT_SCOPED_TABLES. assertWorkspaceCarveOut guards it.
const DEDICATED_PROJECT_CARVE_OUT_MODEL = "AgentWorkspaceFile";

function assertWorkspaceCarveOut(source: string): void {
	const carveOut = withoutComments(source).match(
		/function getProjectCarveOut\b([\s\S]*?)^}/m,
	)?.[1];
	const branch = carveOut?.match(
		new RegExp(
			`if \\(modelName === "${DEDICATED_PROJECT_CARVE_OUT_MODEL}"\\) \\{([\\s\\S]*?)^\\t\\}`,
			"m",
		),
	)?.[1];
	if (
		!branch ||
		!/branches\.push\(\{ projectId: \{ in: ctx\.allowedProjectIds \} \}\)/.test(
			branch,
		) ||
		!/return branches\.length === 1 \? branches\[0\] : \{ OR: branches \}/.test(
			branch,
		)
	) {
		throw new Error(
			`${DEDICATED_PROJECT_CARVE_OUT_MODEL}: dedicated getProjectCarveOut branch missing or changed; review the project-scope exemption.`,
		);
	}
}

function withoutComments(text: string): string {
	return text.replace(/\/\*[\s\S]*?\*\/|\/\/[^\n]*/g, "");
}

function parseModels(schema: string): Map<string, Set<string>> {
	const models = new Map<string, Set<string>>();
	for (const [, name, body] of withoutComments(schema).matchAll(
		/^\s*model\s+(\w+)\s*\{([\s\S]*?)^\s*\}/gm,
	)) {
		const fields = new Set(
			[
				...body.matchAll(
					/^\s*(organizationId|userId|projectId)\s+(?:String|Int|BigInt|Boolean|Float|Decimal|DateTime|Json|Bytes)\??(?=\s|$)/gm,
				),
			].map((match) => match[1]),
		);
		models.set(name, fields);
	}
	if (models.size === 0) {
		throw new Error(
			"Schema parser found zero models; repair the schema/parser.",
		);
	}
	if (![...models.values()].some((fields) => fields.size > 0)) {
		throw new Error(
			"Schema parser found zero tenant-column models; repair the schema/parser.",
		);
	}
	return models;
}

function parseRegistrations(source: string): Map<string, Set<string>> {
	const registrations = new Map<string, Set<string>>();
	for (const name of REGISTRATION_STRUCTURES) {
		const body = withoutComments(source).match(
			new RegExp(
				`const ${name}\\b[^=]*=\\s*(?:new Set\\(\\[|\\{)([\\s\\S]*?)^\\s*(?:\\]\\)|\\});`,
				"m",
			),
		)?.[1];
		const members = new Set(
			body
				? [...body.matchAll(/^\s*(?:"(\w+)"\s*,|(\w+)\s*:)/gm)].map(
						(match) => match[1] || match[2],
					)
				: [],
		);
		if (members.size === 0) {
			throw new Error(
				`${name} is missing or empty; repair the registration/parser.`,
			);
		}
		registrations.set(name, members);
	}
	return registrations;
}

function checkRegistration(
	schema: string,
	source: string,
	unregistered: readonly string[],
	projectScope: readonly string[],
): string[] {
	assertWorkspaceCarveOut(source);
	const models = parseModels(schema);
	const registrations = parseRegistrations(source);
	const registered = new Set(
		FILTERING_STRUCTURES.flatMap((name) => [
			...(registrations.get(name) ?? []),
		]),
	);
	const scoped =
		registrations.get("PROJECT_SCOPED_TABLES") ?? new Set<string>();
	const missing = [...models]
		.filter(([name, fields]) => fields.size > 0 && !registered.has(name))
		.map(([name]) => name)
		.sort();
	const missingScope = [...models]
		.filter(
			([name, fields]) =>
				fields.has("projectId") &&
				registered.has(name) &&
				!scoped.has(name) &&
				!registrations.get("PARENT_SCOPED_TABLES")?.has(name) &&
				name !== DEDICATED_PROJECT_CARVE_OUT_MODEL,
		)
		.map(([name]) => name)
		.sort();
	const errors: string[] = [];
	for (const [actual, baseline, label, action] of [
		[
			missing,
			unregistered,
			"UNREGISTERED_BASELINE",
			"register it in tenant-db.ts",
		],
		[
			missingScope,
			projectScope,
			"PROJECT_SCOPE_BASELINE",
			"register it in PROJECT_SCOPED_TABLES in tenant-db.ts",
		],
	] as const) {
		for (const name of actual) {
			if (!baseline.includes(name)) {
				errors.push(
					`${name}: ${action}, or add it to ${label} with a reason in the PR.`,
				);
			}
		}
		for (const name of baseline) {
			if (!actual.includes(name)) {
				errors.push(
					`${name}: stale ${label} entry; remove it from the baseline.`,
				);
			}
		}
		if (
			new Set(baseline).size !== baseline.length ||
			[...baseline].sort().join() !== baseline.join()
		) {
			errors.push(`${label}: keep entries unique and sorted.`);
		}
	}
	return errors;
}

const schema = readFileSync(
	new URL("../prisma/schema.prisma", import.meta.url),
	"utf8",
);
const tenantDb = readFileSync(
	new URL("../src/tenant-db.ts", import.meta.url),
	"utf8",
);

describe("tenant registration ratchet", () => {
	it("keeps registration gaps within the shrinking baselines", () => {
		expect(
			checkRegistration(
				schema,
				tenantDb,
				UNREGISTERED_BASELINE,
				PROJECT_SCOPE_BASELINE,
			),
		).toEqual([]);
	});
});

const fixtureSchema = `model Example {
 organizationId String?
}
`;
const fixtureCarveOut = `function getProjectCarveOut(modelName: string) {
 if (modelName === "AgentWorkspaceFile") {
  const branches = [];
  if (ctx.allowedProjectIds && ctx.allowedProjectIds.length > 0) {
   branches.push({ projectId: { in: ctx.allowedProjectIds } });
  }
  return branches.length === 1 ? branches[0] : { OR: branches };
\t}
}
`;
const fixtureSource =
	REGISTRATION_STRUCTURES.map(
		(name) =>
			`const ${name} = new Set([\n "${name === "PARENT_SCOPED_TABLES" ? "Other" : "Example"}",\n]);`,
	).join("\n") + fixtureCarveOut;

describe("ratchet rejection proofs", () => {
	it("rejects a new unregistered tenant model", () => {
		expect(
			checkRegistration(
				`${fixtureSchema}model NewTenant {\n userId String\n}\n`,
				fixtureSource,
				[],
				[],
			),
		).toEqual([expect.stringContaining("NewTenant: register it")]);
	});
	it("rejects a registered project model without project scoping", () => {
		expect(
			checkRegistration(
				fixtureSchema.replace("organizationId", "projectId"),
				fixtureSource.replace(
					'const PROJECT_SCOPED_TABLES = new Set([\n "Example",',
					'const PROJECT_SCOPED_TABLES = new Set([\n "Other",',
				),
				[],
				[],
			),
		).toEqual([
			expect.stringContaining(
				"Example: register it in PROJECT_SCOPED_TABLES",
			),
		]);
	});
	it.each(["Example", "Deleted"])(
		"rejects stale unregistered baseline %s",
		(name) => {
			expect(
				checkRegistration(fixtureSchema, fixtureSource, [name], []),
			).toEqual([
				expect.stringContaining(`${name}: stale UNREGISTERED_BASELINE`),
			]);
		},
	);
	it.each(["Example", "Deleted"])(
		"rejects stale project baseline %s",
		(name) => {
			expect(
				checkRegistration(fixtureSchema, fixtureSource, [], [name]),
			).toEqual([
				expect.stringContaining(
					`${name}: stale PROJECT_SCOPE_BASELINE`,
				),
			]);
		},
	);
	it("rejects zero models", () => {
		expect(() => parseModels("")).toThrow("zero models");
	});
	it("rejects zero tenant columns", () => {
		expect(() => parseModels("model Example {\n id String\n}\n")).toThrow(
			"zero tenant-column models",
		);
	});
	it.each(REGISTRATION_STRUCTURES)("rejects missing or empty %s", (name) => {
		expect(() =>
			parseRegistrations(
				fixtureSource.replace(`const ${name}`, `const MISSING_${name}`),
			),
		).toThrow(`${name} is missing or empty`);
		expect(() =>
			parseRegistrations(
				fixtureSource.replace(
					`const ${name} = new Set([\n "${name === "PARENT_SCOPED_TABLES" ? "Other" : "Example"}",`,
					`const ${name} = new Set([`,
				),
			),
		).toThrow(`${name} is missing or empty`);
	});
	it("rejects duplicate and unsorted baseline entries", () => {
		for (const baseline of [
			["Zed", "Alpha"],
			["Alpha", "Alpha"],
		]) {
			const extra =
				"model Alpha {\n userId String\n}\nmodel Zed {\n userId String\n}\n";
			expect(
				checkRegistration(
					fixtureSchema + extra,
					fixtureSource,
					baseline,
					[],
				),
			).toContain(
				"UNREGISTERED_BASELINE: keep entries unique and sorted.",
			);
		}
	});
	it("accepts current baseline exceptions", () => {
		const extra = "model NewTenant {\n projectId String?\n}\n";
		expect(
			checkRegistration(
				fixtureSchema + extra,
				fixtureSource,
				["NewTenant"],
				[],
			),
		).toEqual([]);
		const source = fixtureSource.replace(
			'const PROJECT_SCOPED_TABLES = new Set([\n "Example",',
			'const PROJECT_SCOPED_TABLES = new Set([\n "Other",',
		);
		expect(
			checkRegistration(
				fixtureSchema.replace("organizationId", "projectId"),
				source,
				[],
				["Example"],
			),
		).toEqual([]);
	});

	it.each(["PROJECT_SCOPED_TABLES", "SPECIAL_TABLES"])(
		"does not count %s alone as registration",
		(onlyStructure) => {
			const source =
				REGISTRATION_STRUCTURES.map(
					(name) =>
						`const ${name} = new Set([\n "${name === onlyStructure ? "Example" : "Other"}",\n]);`,
				).join("\n") + fixtureCarveOut;
			expect(checkRegistration(fixtureSchema, source, [], [])).toEqual([
				expect.stringContaining("Example: register it in tenant-db.ts"),
			]);
		},
	);
	it("accepts a parent-scoped project model without a redundant project entry", () => {
		const source = fixtureSource
			.replace(
				'const PARENT_SCOPED_TABLES = new Set([\n "Other",',
				'const PARENT_SCOPED_TABLES = new Set([\n "Example",',
			)
			.replace(
				'const PROJECT_SCOPED_TABLES = new Set([\n "Example",',
				'const PROJECT_SCOPED_TABLES = new Set([\n "Other",',
			);
		expect(
			checkRegistration(
				fixtureSchema.replace("organizationId", "projectId"),
				source,
				[],
				[],
			),
		).toEqual([]);
	});
	it("accepts the dedicated workspace guest carve-out without a redundant project entry", () => {
		const source = fixtureSource
			.replaceAll('"Example"', '"AgentWorkspaceFile"')
			.replace(
				'const PROJECT_SCOPED_TABLES = new Set([\n "AgentWorkspaceFile",',
				'const PROJECT_SCOPED_TABLES = new Set([\n "Other",',
			);
		expect(
			checkRegistration(
				fixtureSchema
					.replace("Example", "AgentWorkspaceFile")
					.replace("organizationId", "projectId"),
				source,
				[],
				[],
			),
		).toEqual([]);
	});
	it("rejects an exemption whose workspace branch was removed", () => {
		expect(() =>
			checkRegistration(
				fixtureSchema,
				fixtureSource.replace(fixtureCarveOut, ""),
				[],
				[],
			),
		).toThrow("dedicated getProjectCarveOut branch missing or changed");
	});
	it("does not count model names inside block comments in a set", () => {
		const source = fixtureSource.replace(
			"const USER_OWNED_TABLES = new Set([",
			'const USER_OWNED_TABLES = new Set([\n /*\n "CommentOnly",\n */',
		);
		expect(
			parseRegistrations(source)
				.get("USER_OWNED_TABLES")
				?.has("CommentOnly"),
		).toBe(false);
	});

	it("ignores comments, relations, indexes and non-scalar types", () => {
		const parsed = parseModels(`${fixtureSchema}model MentionOnly {
 // organizationId String
 /* userId String */
 organization Organization @relation(fields: [organizationId], references: [id])
 projectId Project
 @@index([organizationId])
}
`);
		expect(parsed.get("MentionOnly")).toEqual(new Set());
	});
});
