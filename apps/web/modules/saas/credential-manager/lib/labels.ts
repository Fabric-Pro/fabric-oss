export const CREDENTIAL_PROVIDER_LABELS = {
	GITHUB: "GitHub",
	GITLAB: "GitLab",
	AZURE_DEVOPS: "Azure DevOps",
	ATLASSIAN: "Atlassian",
	SLACK: "Slack",
	MICROSOFT: "Microsoft",
	GOOGLE: "Google",
	NOTION: "Notion",
	LINEAR: "Linear",
	OPENAI: "OpenAI",
	ANTHROPIC: "Anthropic",
	AZURE_OPENAI: "Azure OpenAI",
	CUSTOM: "Other",
} as const;

export type CredentialProviderKey = keyof typeof CREDENTIAL_PROVIDER_LABELS;

export const CREDENTIAL_KIND_LABELS = {
	APP_INSTALLATION: "App installation",
	OAUTH: "Sign-in",
	GITHUB_APP_USER: "Sign-in",
	PAT: "Personal access token",
	API_KEY: "API key",
	BASIC: "User and token",
	SERVICE_ACCOUNT: "Service account",
	CUSTOM: "Custom",
} as const;

export const CREDENTIAL_STATUS_BADGE = {
	ACTIVE: { label: "Active", variant: "success" },
	EXPIRING: { label: "Expiring", variant: "warning" },
	NEEDS_REAUTH: { label: "Reconnect needed", variant: "warning" },
	REVOKED: { label: "Revoked", variant: "error" },
	ERROR: { label: "Error", variant: "error" },
} as const;
