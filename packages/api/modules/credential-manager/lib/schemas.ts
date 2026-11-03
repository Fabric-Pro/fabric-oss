import { z } from "zod";

export const credentialProviderSchema = z.enum([
	"GITHUB",
	"GITLAB",
	"AZURE_DEVOPS",
	"ATLASSIAN",
	"SLACK",
	"MICROSOFT",
	"GOOGLE",
	"NOTION",
	"LINEAR",
	"OPENAI",
	"ANTHROPIC",
	"AZURE_OPENAI",
	"CUSTOM",
]);

/**
 * Kinds a person can paste in phase 1. OAuth grants and app installations
 * are created only by their provider's connect flow, never typed in.
 */
export const manualCredentialKindSchema = z.enum(["PAT", "API_KEY", "BASIC"]);

/** Default origin per provider when the caller does not name an instance. */
export const DEFAULT_PROVIDER_ORIGIN: Partial<
	Record<z.infer<typeof credentialProviderSchema>, string>
> = {
	GITHUB: "https://github.com",
	GITLAB: "https://gitlab.com",
	AZURE_DEVOPS: "https://dev.azure.com",
	ATLASSIAN: "https://api.atlassian.com",
	SLACK: "https://slack.com",
	MICROSOFT: "https://graph.microsoft.com",
	GOOGLE: "https://www.googleapis.com",
	NOTION: "https://api.notion.com",
	LINEAR: "https://api.linear.app",
	OPENAI: "https://api.openai.com",
	ANTHROPIC: "https://api.anthropic.com",
};

export const credentialOriginSchema = z
	.string()
	.url()
	.refine((value) => new URL(value).protocol === "https:", {
		message: "Origin must use https",
	})
	.transform((value) => new URL(value).origin);

export const clientCredentialSchema = z.object({
	id: z.string(),
	owner: z.enum(["organization", "member"]),
	ownedByMe: z.boolean(),
	sharing: z.enum(["PRIVATE", "ORGANIZATION"]),
	provider: credentialProviderSchema,
	kind: z.enum([
		"APP_INSTALLATION",
		"OAUTH",
		"GITHUB_APP_USER",
		"PAT",
		"API_KEY",
		"BASIC",
		"SERVICE_ACCOUNT",
		"CUSTOM",
	]),
	principal: z.enum(["APP", "USER"]),
	label: z.string(),
	origin: z.string(),
	externalAccountLogin: z.string().nullable(),
	scopes: z.array(z.string()),
	status: z.enum(["ACTIVE", "EXPIRING", "NEEDS_REAUTH", "REVOKED", "ERROR"]),
	expiresAt: z.date().nullable(),
	lastUsedAt: z.date().nullable(),
	lastCheckedAt: z.date().nullable(),
	lastError: z.string().nullable(),
	createdAt: z.date(),
	canManage: z.boolean(),
});
