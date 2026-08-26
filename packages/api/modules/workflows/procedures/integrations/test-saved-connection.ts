import { ORPCError } from "@orpc/client";
import { listWorkflowIntegrations } from "@repo/database";
import { decryptApiKey } from "@repo/utils";
import { z } from "zod";
import {
	Permissions,
	requirePermission,
	resolveOrganizationId,
	tenantProtectedProcedure,
} from "../../../../orpc/procedures";
import { verifyOrganizationMembership } from "../../../organizations/lib/membership";

/**
 * Test saved integration connection procedure
 * Tests connection using already-saved credentials
 */

const IntegrationTypeEnum = z.enum([
	"AI_GATEWAY",
	"ASANA",
	"ATTIO",
	"BITBUCKET",
	"BLOB",
	"CANVA",
	"CLERK",
	"CLICKUP",
	"CONFLUENCE",
	"CUSTOM_WEBHOOK",
	"DATABASE",
	"DATABRICKS_VECTOR_SEARCH",
	"FAL",
	"FIRECRAWL",
	"FRESHSERVICE",
	"FRONT",
	"GITHUB",
	"GITLAB",
	"GMAIL",
	"GOOGLE_DRIVE",
	"HUBSPOT",
	"INTERCOM",
	"JIRA",
	"LINEAR",
	"MCP",
	"MICROSOFT_GRAPH",
	"NHTSA_VPIC",
	"NOTION",
	"PERPLEXITY",
	"RESEND",
	"SALESFORCE",
	"SLACK",
	"STRIPE",
	"SUPERAGENT",
	"TELEGRAM",
	"WEBFLOW",
	"ZENDESK",
]);

type IntegrationType = z.infer<typeof IntegrationTypeEnum>;

interface TestConnectionResult {
	success: boolean;
	message?: string;
	error?: string;
}

async function testGmailConnection(
	credentials: Record<string, string>,
): Promise<TestConnectionResult> {
	const token = credentials.apiKey || credentials.GMAIL_API_KEY;
	if (!token) {
		return { success: false, error: "OAuth access token is required" };
	}

	try {
		const response = await fetch(
			"https://gmail.googleapis.com/gmail/v1/users/me/profile",
			{
				headers: {
					Authorization: `Bearer ${token}`,
					Accept: "application/json",
				},
			},
		);

		if (!response.ok) {
			return {
				success: false,
				error: `Gmail returned status ${response.status}`,
			};
		}

		const data = (await response.json()) as { emailAddress?: string };
		return {
			success: true,
			message: `Connected to Gmail${data.emailAddress ? ` as ${data.emailAddress}` : ""}`,
		};
	} catch (error) {
		return {
			success: false,
			error: error instanceof Error ? error.message : "Connection failed",
		};
	}
}

/**
 * Test Linear connection using GraphQL API
 */
async function testLinearConnection(
	credentials: Record<string, string>,
): Promise<TestConnectionResult> {
	const apiKey = credentials.apiKey || credentials.LINEAR_API_KEY;
	if (!apiKey) {
		return { success: false, error: "API key is required" };
	}

	try {
		const response = await fetch("https://api.linear.app/graphql", {
			method: "POST",
			headers: {
				"Content-Type": "application/json",
				Authorization: apiKey,
			},
			body: JSON.stringify({
				query: "query { viewer { id name email } }",
			}),
		});

		const data = (await response.json()) as {
			data?: { viewer?: { id: string; name: string; email: string } };
			errors?: { message: string }[];
		};

		if (data.errors && data.errors.length > 0) {
			return {
				success: false,
				error: data.errors[0].message || "Authentication failed",
			};
		}

		if (data.data?.viewer) {
			return {
				success: true,
				message: `Connected as ${data.data.viewer.name} (${data.data.viewer.email})`,
			};
		}

		return { success: false, error: "Failed to verify connection" };
	} catch (error) {
		return {
			success: false,
			error: error instanceof Error ? error.message : "Connection failed",
		};
	}
}

async function testClickUpConnection(
	credentials: Record<string, string>,
): Promise<TestConnectionResult> {
	const apiToken =
		credentials.CLICKUP_API_TOKEN || credentials.apiToken || "";
	if (!apiToken) {
		return { success: false, error: "ClickUp API token is required" };
	}

	try {
		const response = await fetch("https://api.clickup.com/api/v2/user", {
			headers: {
				Authorization: apiToken,
				Accept: "application/json",
			},
		});

		if (!response.ok) {
			return {
				success: false,
				error: `ClickUp returned status ${response.status}`,
			};
		}

		const data = (await response.json()) as {
			user?: { username?: string; email?: string };
		};
		return {
			success: true,
			message: `Connected as ${data.user?.username || data.user?.email || "your ClickUp account"}`,
		};
	} catch (error) {
		return {
			success: false,
			error: error instanceof Error ? error.message : "Connection failed",
		};
	}
}

async function testJiraConnection(
	credentials: Record<string, string>,
): Promise<TestConnectionResult> {
	const domain = credentials.JIRA_DOMAIN || credentials.domain || "";
	const email = credentials.JIRA_EMAIL || credentials.email || "";
	const apiToken = credentials.JIRA_API_TOKEN || credentials.apiToken || "";

	if (!domain || !email || !apiToken) {
		return {
			success: false,
			error: "Jira domain, email, and API token are required",
		};
	}

	const normalizedDomain = domain
		.replace(/^https?:\/\//, "")
		.replace(/\/$/, "");
	const auth = Buffer.from(`${email}:${apiToken}`).toString("base64");

	try {
		const response = await fetch(
			`https://${normalizedDomain}/rest/api/3/myself`,
			{
				headers: {
					Authorization: `Basic ${auth}`,
					Accept: "application/json",
				},
			},
		);

		if (!response.ok) {
			return {
				success: false,
				error: `Jira returned status ${response.status}`,
			};
		}

		const data = (await response.json()) as {
			displayName?: string;
			emailAddress?: string;
		};
		return {
			success: true,
			message: `Connected as ${data.displayName || data.emailAddress || email}`,
		};
	} catch (error) {
		return {
			success: false,
			error: error instanceof Error ? error.message : "Connection failed",
		};
	}
}

async function testZendeskConnection(
	credentials: Record<string, string>,
): Promise<TestConnectionResult> {
	const subdomain =
		credentials.ZENDESK_SUBDOMAIN || credentials.subdomain || "";
	const email = credentials.ZENDESK_EMAIL || credentials.email || "";
	const token = credentials.ZENDESK_TOKEN || credentials.token || "";

	if (!subdomain || !email || !token) {
		return {
			success: false,
			error: "Zendesk subdomain, email, and token are required",
		};
	}

	const auth = Buffer.from(`${email}/token:${token}`).toString("base64");

	try {
		const response = await fetch(
			`https://${subdomain}.zendesk.com/api/v2/users/me.json`,
			{
				headers: {
					Authorization: `Basic ${auth}`,
					Accept: "application/json",
				},
			},
		);

		if (!response.ok) {
			return {
				success: false,
				error: `Zendesk returned status ${response.status}`,
			};
		}

		const data = (await response.json()) as {
			user?: { name?: string; email?: string };
		};
		return {
			success: true,
			message: `Connected as ${data.user?.name || data.user?.email || email}`,
		};
	} catch (error) {
		return {
			success: false,
			error: error instanceof Error ? error.message : "Connection failed",
		};
	}
}

async function testGitLabConnection(
	credentials: Record<string, string>,
): Promise<TestConnectionResult> {
	const apiToken =
		credentials.GITLAB_ACCESS_TOKEN ||
		credentials.access_token ||
		credentials.apiToken ||
		"";
	const rawUrl =
		credentials.GITLAB_URL ||
		credentials.domain ||
		credentials.url ||
		"https://gitlab.com";

	if (!apiToken) {
		return { success: false, error: "GitLab access token is required" };
	}

	const baseUrl = rawUrl.startsWith("http")
		? rawUrl.replace(/\/$/, "")
		: `https://${rawUrl.replace(/\/$/, "")}`;

	try {
		const response = await fetch(`${baseUrl}/api/v4/user`, {
			headers: {
				Authorization: `Bearer ${apiToken}`,
				Accept: "application/json",
			},
		});

		if (!response.ok) {
			return {
				success: false,
				error: `GitLab returned status ${response.status}`,
			};
		}

		const data = (await response.json()) as {
			name?: string;
			username?: string;
			email?: string;
		};
		return {
			success: true,
			message: `Connected as ${data.name || data.username || data.email || "your GitLab account"}`,
		};
	} catch (error) {
		return {
			success: false,
			error: error instanceof Error ? error.message : "Connection failed",
		};
	}
}

async function testBitbucketConnection(
	credentials: Record<string, string>,
): Promise<TestConnectionResult> {
	const email = credentials.BITBUCKET_EMAIL || credentials.email || "";
	const apiToken =
		credentials.BITBUCKET_API_TOKEN ||
		credentials.apiToken ||
		credentials.access_token ||
		"";

	if (!email || !apiToken) {
		return {
			success: false,
			error: "Bitbucket account email and API token are required",
		};
	}

	const auth = Buffer.from(`${email}:${apiToken}`).toString("base64");

	try {
		const response = await fetch("https://api.bitbucket.org/2.0/user", {
			headers: {
				Authorization: `Basic ${auth}`,
				Accept: "application/json",
			},
		});

		if (!response.ok) {
			return {
				success: false,
				error: `Bitbucket returned status ${response.status}`,
			};
		}

		const data = (await response.json()) as {
			display_name?: string;
			username?: string;
			account_id?: string;
		};
		return {
			success: true,
			message: `Connected as ${data.display_name || data.username || data.account_id || "your Bitbucket account"}`,
		};
	} catch (error) {
		return {
			success: false,
			error: error instanceof Error ? error.message : "Connection failed",
		};
	}
}

async function testHubSpotConnection(
	credentials: Record<string, string>,
): Promise<TestConnectionResult> {
	const accessToken =
		credentials.HUBSPOT_ACCESS_TOKEN ||
		credentials.apiToken ||
		credentials.access_token ||
		credentials.apiKey ||
		"";
	if (!accessToken) {
		return { success: false, error: "HubSpot access token is required" };
	}

	try {
		const response = await fetch(
			"https://api.hubapi.com/crm/v3/objects/contacts?limit=1",
			{
				headers: {
					Authorization: `Bearer ${accessToken}`,
					Accept: "application/json",
				},
			},
		);

		if (!response.ok) {
			return {
				success: false,
				error: `HubSpot returned status ${response.status}`,
			};
		}

		return { success: true, message: "Connected to HubSpot" };
	} catch (error) {
		return {
			success: false,
			error: error instanceof Error ? error.message : "Connection failed",
		};
	}
}

async function testIntercomConnection(
	credentials: Record<string, string>,
): Promise<TestConnectionResult> {
	const accessToken =
		credentials.INTERCOM_ACCESS_TOKEN ||
		credentials.apiToken ||
		credentials.access_token ||
		credentials.apiKey ||
		"";
	if (!accessToken) {
		return { success: false, error: "Intercom access token is required" };
	}

	try {
		const response = await fetch("https://api.intercom.io/me", {
			headers: {
				Authorization: `Bearer ${accessToken}`,
				Accept: "application/json",
			},
		});

		if (!response.ok) {
			return {
				success: false,
				error: `Intercom returned status ${response.status}`,
			};
		}

		return { success: true, message: "Connected to Intercom" };
	} catch (error) {
		return {
			success: false,
			error: error instanceof Error ? error.message : "Connection failed",
		};
	}
}

async function testSalesforceConnection(
	credentials: Record<string, string>,
): Promise<TestConnectionResult> {
	const domain = credentials.SALESFORCE_DOMAIN || credentials.domain || "";
	const accessToken =
		credentials.SALESFORCE_ACCESS_TOKEN ||
		credentials.apiToken ||
		credentials.apiKey ||
		"";

	if (!domain || !accessToken) {
		return {
			success: false,
			error: "Salesforce domain and access token are required",
		};
	}

	const baseUrl = domain.startsWith("http")
		? domain.replace(/\/$/, "")
		: `https://${domain.replace(/\/$/, "")}`;

	try {
		const response = await fetch(`${baseUrl}/services/data/v61.0/limits`, {
			headers: {
				Authorization: `Bearer ${accessToken}`,
				Accept: "application/json",
			},
		});

		if (!response.ok) {
			return {
				success: false,
				error: `Salesforce returned status ${response.status}`,
			};
		}

		return { success: true, message: "Connected to Salesforce" };
	} catch (error) {
		return {
			success: false,
			error: error instanceof Error ? error.message : "Connection failed",
		};
	}
}

/**
 * Test Slack connection using auth.test API
 */
async function testSlackConnection(
	credentials: Record<string, string>,
): Promise<TestConnectionResult> {
	const token =
		credentials.access_token ||
		credentials.apiKey ||
		credentials.SLACK_API_KEY;
	if (!token) {
		return {
			success: false,
			error: "Slack not connected. Please connect via OAuth.",
		};
	}

	try {
		const response = await fetch("https://slack.com/api/auth.test", {
			method: "POST",
			headers: {
				"Content-Type": "application/x-www-form-urlencoded",
				Authorization: `Bearer ${token}`,
			},
		});

		const data = (await response.json()) as {
			ok: boolean;
			user?: string;
			user_id?: string;
			team?: string;
			team_id?: string;
			error?: string;
		};

		if (!data.ok) {
			return {
				success: false,
				error: data.error || "Failed to authenticate",
			};
		}

		const userName = data.user || data.user_id || "bot";
		const teamName = data.team || data.team_id || "workspace";

		return {
			success: true,
			message: `Connected as ${userName} in ${teamName}`,
		};
	} catch (error) {
		return {
			success: false,
			error: error instanceof Error ? error.message : "Connection failed",
		};
	}
}

/**
 * Test Resend connection by listing domains
 */
async function testResendConnection(
	credentials: Record<string, string>,
): Promise<TestConnectionResult> {
	const apiKey = credentials.apiKey || credentials.RESEND_API_KEY;
	if (!apiKey) {
		return { success: false, error: "API key is required" };
	}

	try {
		const response = await fetch("https://api.resend.com/domains", {
			method: "GET",
			headers: {
				Authorization: `Bearer ${apiKey}`,
			},
		});

		if (!response.ok) {
			const text = await response.text();
			return {
				success: false,
				error:
					text || `HTTP ${response.status}: ${response.statusText}`,
			};
		}

		return {
			success: true,
			message: "Successfully connected to Resend",
		};
	} catch (error) {
		return {
			success: false,
			error: error instanceof Error ? error.message : "Connection failed",
		};
	}
}

/**
 * Test MCP connection (placeholder)
 */
async function testMcpConnection(): Promise<TestConnectionResult> {
	return {
		success: true,
		message: "MCP integration ready - configure MCP servers in settings",
	};
}

/**
 * Test AI Gateway connection
 */
async function testAiGatewayConnection(
	credentials: Record<string, string>,
): Promise<TestConnectionResult> {
	const apiKey = credentials.apiKey || credentials.AI_GATEWAY_API_KEY;
	if (!apiKey) {
		return { success: false, error: "API key is required" };
	}

	return {
		success: true,
		message:
			"AI Gateway credentials saved - will be validated on first use",
	};
}

/**
 * Test Firecrawl connection
 */
async function testFirecrawlConnection(
	credentials: Record<string, string>,
): Promise<TestConnectionResult> {
	const apiKey = credentials.apiKey || credentials.FIRECRAWL_API_KEY;
	if (!apiKey) {
		return { success: false, error: "API key is required" };
	}

	try {
		const response = await fetch("https://api.firecrawl.dev/v1/scrape", {
			method: "POST",
			headers: {
				"Content-Type": "application/json",
				Authorization: `Bearer ${apiKey}`,
			},
			body: JSON.stringify({
				url: "https://example.com",
				formats: ["markdown"],
			}),
		});

		if (!response.ok && response.status === 401) {
			return { success: false, error: "Invalid API key" };
		}

		return {
			success: true,
			message: "Successfully connected to Firecrawl",
		};
	} catch (error) {
		return {
			success: false,
			error: error instanceof Error ? error.message : "Connection failed",
		};
	}
}

/**
 * Test Database connection
 */
async function testDatabaseConnection(
	credentials: Record<string, string>,
): Promise<TestConnectionResult> {
	const url = credentials.url || credentials.DATABASE_URL;
	if (!url) {
		return { success: false, error: "Database URL is required" };
	}

	try {
		new URL(url);
		return {
			success: true,
			message:
				"Database URL format valid - connection will be tested on first use",
		};
	} catch {
		return { success: false, error: "Invalid database URL format" };
	}
}

async function testDatabricksVectorSearchConnection(
	credentials: Record<string, string>,
): Promise<TestConnectionResult> {
	const { verifyDatabricksVectorSearchConnection } = await import(
		"@repo/integrations/databricks-vector-search"
	);
	// Form fields arrive under configKey names; the saved-credential path
	// arrives under mapped env-var names. Accept both.
	return verifyDatabricksVectorSearchConnection({
		DATABRICKS_HOST: credentials.DATABRICKS_HOST || credentials.host || "",
		DATABRICKS_CLIENT_ID:
			credentials.DATABRICKS_CLIENT_ID || credentials.clientId || "",
		DATABRICKS_CLIENT_SECRET:
			credentials.DATABRICKS_CLIENT_SECRET ||
			credentials.clientSecret ||
			"",
	});
}

/**
 * Test Custom Webhook connection
 */
async function testWebhookConnection(
	credentials: Record<string, string>,
): Promise<TestConnectionResult> {
	const url = credentials.url || credentials.WEBHOOK_URL;
	if (!url) {
		return { success: false, error: "Webhook URL is required" };
	}

	try {
		new URL(url);
		return {
			success: true,
			message: "Webhook URL format valid",
		};
	} catch {
		return { success: false, error: "Invalid webhook URL format" };
	}
}

/**
 * Test GitHub connection
 * Supports both OAuth (access_token) and PAT (apiKey) flows
 */
async function testGithubConnection(
	credentials: Record<string, string>,
): Promise<TestConnectionResult> {
	// Check for OAuth flow first, then fall back to PAT
	const token =
		credentials.access_token ||
		credentials.apiKey ||
		credentials.GITHUB_TOKEN;
	if (!token) {
		return {
			success: false,
			error: "GitHub not connected. Please connect via OAuth or provide a token.",
		};
	}

	try {
		const response = await fetch("https://api.github.com/user", {
			headers: {
				Authorization: `Bearer ${token}`,
				Accept: "application/vnd.github+json",
				"User-Agent": "Fabric-App",
			},
		});

		if (response.ok) {
			const user = (await response.json()) as { login: string };
			return {
				success: true,
				message: `Connected as ${user.login}`,
			};
		}

		if (response.status === 401) {
			return {
				success: false,
				error: "Access token expired or invalid. Please reconnect GitHub.",
			};
		}

		return {
			success: false,
			error: `GitHub API returned status ${response.status}`,
		};
	} catch (error) {
		return {
			success: false,
			error:
				error instanceof Error
					? error.message
					: "Failed to connect to GitHub",
		};
	}
}

/**
 * Test Perplexity connection
 */
async function testPerplexityConnection(
	credentials: Record<string, string>,
): Promise<TestConnectionResult> {
	const apiKey = credentials.apiKey || credentials.PERPLEXITY_API_KEY;
	if (!apiKey) {
		return { success: false, error: "Perplexity API key is required" };
	}

	return {
		success: true,
		message:
			"Perplexity credentials saved - will be validated on first use",
	};
}

/**
 * Test fal.ai connection
 */
async function testFalConnection(
	credentials: Record<string, string>,
): Promise<TestConnectionResult> {
	const apiKey = credentials.apiKey || credentials.FAL_API_KEY;
	if (!apiKey) {
		return { success: false, error: "fal.ai API key is required" };
	}

	return {
		success: true,
		message: "fal.ai credentials saved - will be validated on first use",
	};
}

/**
 * Test Confluence connection
 */
async function testConfluenceConnection(
	credentials: Record<string, string>,
): Promise<TestConnectionResult> {
	const domain = credentials.domain || credentials.CONFLUENCE_DOMAIN;
	const email = credentials.email || credentials.CONFLUENCE_EMAIL;
	const apiToken = credentials.apiToken || credentials.CONFLUENCE_API_TOKEN;

	if (!domain || !email || !apiToken) {
		return {
			success: false,
			error: "All Confluence credentials are required",
		};
	}

	try {
		const cleanDomain = domain
			.replace(/^https?:\/\//, "")
			.replace(/\/$/, "");
		const auth = Buffer.from(`${email}:${apiToken}`).toString("base64");

		const response = await fetch(
			`https://${cleanDomain}/wiki/rest/api/user/current`,
			{
				headers: {
					Authorization: `Basic ${auth}`,
					Accept: "application/json",
				},
			},
		);

		if (response.ok) {
			const user = (await response.json()) as {
				displayName?: string;
				username?: string;
			};
			return {
				success: true,
				message: `Connected as ${user.displayName || user.username}`,
			};
		}

		return {
			success: false,
			error: "Invalid credentials or insufficient permissions",
		};
	} catch (error) {
		return {
			success: false,
			error:
				error instanceof Error
					? error.message
					: "Failed to connect to Confluence API",
		};
	}
}

/**
 * Test Google Drive connection
 * Supports both OAuth (access_token) and legacy (refresh_token + client credentials) flows
 */
async function testGoogleDriveConnection(
	credentials: Record<string, string>,
): Promise<TestConnectionResult> {
	// Check for OAuth flow first (access_token stored directly)
	let accessToken = credentials.access_token;

	if (!accessToken) {
		// Legacy flow: use refresh token to get access token
		const refreshToken =
			credentials.refreshToken ||
			credentials.GOOGLE_DRIVE_REFRESH_TOKEN ||
			credentials.refresh_token;
		const clientId =
			credentials.clientId ||
			credentials.GOOGLE_DRIVE_CLIENT_ID ||
			process.env.GOOGLE_CLIENT_ID;
		const clientSecret =
			credentials.clientSecret ||
			credentials.GOOGLE_DRIVE_CLIENT_SECRET ||
			process.env.GOOGLE_CLIENT_SECRET;

		if (refreshToken && clientId && clientSecret) {
			try {
				const tokenResponse = await fetch(
					"https://oauth2.googleapis.com/token",
					{
						method: "POST",
						headers: {
							"Content-Type": "application/x-www-form-urlencoded",
						},
						body: new URLSearchParams({
							client_id: clientId,
							client_secret: clientSecret,
							refresh_token: refreshToken,
							grant_type: "refresh_token",
						}),
					},
				);

				if (!tokenResponse.ok) {
					return {
						success: false,
						error: "Failed to refresh Google Drive access token",
					};
				}

				const tokenData = (await tokenResponse.json()) as {
					access_token: string;
				};
				accessToken = tokenData.access_token;
			} catch (error) {
				return {
					success: false,
					error:
						error instanceof Error
							? error.message
							: "Failed to refresh token",
				};
			}
		}
	}

	if (!accessToken) {
		return {
			success: false,
			error: "Google Drive not connected. Please connect via OAuth.",
		};
	}

	try {
		const response = await fetch(
			"https://www.googleapis.com/drive/v3/about?fields=user",
			{
				headers: {
					Authorization: `Bearer ${accessToken}`,
				},
			},
		);

		if (response.ok) {
			const data = (await response.json()) as {
				user?: { displayName?: string; emailAddress?: string };
			};
			return {
				success: true,
				message: `Connected as ${data.user?.displayName || data.user?.emailAddress || "Google User"}`,
			};
		}

		if (response.status === 401) {
			return {
				success: false,
				error: "Access token expired. Please reconnect Google Drive.",
			};
		}

		return {
			success: false,
			error: "Invalid Google Drive credentials or insufficient permissions",
		};
	} catch (error) {
		return {
			success: false,
			error:
				error instanceof Error
					? error.message
					: "Failed to connect to Google Drive API",
		};
	}
}

/**
 * Test Microsoft Graph connection
 * Uses OAuth - validates by calling the /me endpoint
 */
async function testMicrosoftConnection(
	credentials: Record<string, string>,
): Promise<TestConnectionResult> {
	const accessToken =
		credentials.access_token || credentials.MICROSOFT_ACCESS_TOKEN;
	const refreshToken =
		credentials.refresh_token || credentials.MICROSOFT_REFRESH_TOKEN;

	if (!accessToken && !refreshToken) {
		return {
			success: false,
			error: "Microsoft 365 not connected. Please connect via OAuth.",
		};
	}

	if (accessToken) {
		try {
			const response = await fetch(
				"https://graph.microsoft.com/v1.0/me",
				{
					headers: {
						Authorization: `Bearer ${accessToken}`,
					},
				},
			);

			if (response.ok) {
				const user = (await response.json()) as {
					displayName?: string;
					mail?: string;
					userPrincipalName?: string;
				};
				return {
					success: true,
					message: `Connected as ${user.displayName || user.mail || user.userPrincipalName || "Microsoft User"}`,
				};
			}

			if (response.status === 401) {
				if (refreshToken) {
					return {
						success: true,
						message:
							"Microsoft 365 connected - token will be refreshed on next use",
					};
				}
				return {
					success: false,
					error: "Access token expired. Please reconnect Microsoft 365.",
				};
			}

			return {
				success: false,
				error: `Microsoft Graph API returned status ${response.status}`,
			};
		} catch (error) {
			return {
				success: false,
				error:
					error instanceof Error
						? error.message
						: "Failed to connect to Microsoft Graph API",
			};
		}
	}

	return {
		success: true,
		message: "Microsoft 365 connected - credentials stored securely",
	};
}

/**
 * Test Notion connection
 */
async function testNotionConnection(
	credentials: Record<string, string>,
): Promise<TestConnectionResult> {
	const apiKey = credentials.apiKey || credentials.NOTION_API_KEY;

	if (!apiKey) {
		return {
			success: false,
			error: "Notion Integration Token is required",
		};
	}

	try {
		const response = await fetch("https://api.notion.com/v1/users/me", {
			headers: {
				Authorization: `Bearer ${apiKey}`,
				"Notion-Version": "2022-06-28",
			},
		});

		if (response.ok) {
			const user = (await response.json()) as {
				name?: string;
				bot?: { owner?: { user?: { name?: string } } };
			};
			return {
				success: true,
				message: `Connected as ${user.name || user.bot?.owner?.user?.name || "Notion Bot"}`,
			};
		}

		return {
			success: false,
			error: "Invalid token or insufficient permissions",
		};
	} catch (error) {
		return {
			success: false,
			error:
				error instanceof Error
					? error.message
					: "Failed to connect to Notion API",
		};
	}
}

/**
 * Test NHTSA VPIC connection
 * Public API — no credentials needed, just verify reachability
 */
async function testNhtsaVpicConnection(
	_credentials: Record<string, string>,
): Promise<TestConnectionResult> {
	try {
		const response = await fetch(
			"https://vpic.nhtsa.dot.gov/api/vehicles/GetAllMakes?format=json",
		);
		if (response.ok) {
			return {
				success: true,
				message: "NHTSA VPIC API is reachable",
			};
		}
		return {
			success: false,
			error: `NHTSA API returned status ${response.status}`,
		};
	} catch (error) {
		return {
			success: false,
			error:
				error instanceof Error
					? error.message
					: "Failed to connect to NHTSA API",
		};
	}
}

async function testAsanaSavedConnection(
	credentials: Record<string, string>,
): Promise<TestConnectionResult> {
	const accessToken = credentials.ASANA_ACCESS_TOKEN || credentials.apiKey;
	if (!accessToken) {
		return { success: false, error: "Asana access token is required" };
	}
	try {
		const response = await fetch("https://app.asana.com/api/1.0/users/me", {
			headers: { Authorization: `Bearer ${accessToken}` },
		});
		if (response.ok) {
			const data = (await response.json()) as {
				data: { name: string };
			};
			return {
				success: true,
				message: `Asana connected as ${data.data.name}`,
			};
		}
		return {
			success: false,
			error: `Asana returned status ${response.status}`,
		};
	} catch (error) {
		return {
			success: false,
			error:
				error instanceof Error
					? error.message
					: "Failed to connect to Asana",
		};
	}
}

async function testAttioSavedConnection(
	credentials: Record<string, string>,
): Promise<TestConnectionResult> {
	const apiKey = credentials.ATTIO_API_KEY || credentials.apiKey;
	if (!apiKey) {
		return { success: false, error: "Attio API key is required" };
	}
	try {
		const response = await fetch("https://api.attio.com/v2/self", {
			headers: { Authorization: `Bearer ${apiKey}` },
		});
		if (response.ok) {
			return { success: true, message: "Attio connection successful" };
		}
		return {
			success: false,
			error: `Attio returned status ${response.status}`,
		};
	} catch (error) {
		return {
			success: false,
			error:
				error instanceof Error
					? error.message
					: "Failed to connect to Attio",
		};
	}
}

async function testCanvaSavedConnection(
	credentials: Record<string, string>,
): Promise<TestConnectionResult> {
	const accessToken = credentials.CANVA_ACCESS_TOKEN || credentials.apiKey;
	if (!accessToken) {
		return { success: false, error: "Canva access token is required" };
	}
	return {
		success: true,
		message:
			"Canva token saved. Connection will be validated on first use.",
	};
}

async function testFreshserviceSavedConnection(
	credentials: Record<string, string>,
): Promise<TestConnectionResult> {
	const apiKey = credentials.FRESHSERVICE_API_KEY || credentials.apiKey;
	const domain = credentials.FRESHSERVICE_DOMAIN || credentials.domain;
	if (!apiKey || !domain) {
		return {
			success: false,
			error: "Freshservice API key and domain are required",
		};
	}
	try {
		const cleanDomain = domain
			.replace(/^https?:\/\//, "")
			.replace(/\/$/, "");
		const encoded = Buffer.from(`${apiKey}:X`).toString("base64");
		const response = await fetch(
			`https://${cleanDomain}/api/v2/agents/me`,
			{
				headers: {
					Authorization: `Basic ${encoded}`,
					"Content-Type": "application/json",
				},
			},
		);
		if (response.ok) {
			return {
				success: true,
				message: "Freshservice connection successful",
			};
		}
		return {
			success: false,
			error: `Freshservice returned status ${response.status}`,
		};
	} catch (error) {
		return {
			success: false,
			error:
				error instanceof Error
					? error.message
					: "Failed to connect to Freshservice",
		};
	}
}

async function testFrontSavedConnection(
	credentials: Record<string, string>,
): Promise<TestConnectionResult> {
	const apiKey = credentials.FRONT_API_KEY || credentials.apiKey;
	if (!apiKey) {
		return { success: false, error: "Front API token is required" };
	}
	try {
		const response = await fetch("https://api2.frontapp.com/me", {
			headers: { Authorization: `Bearer ${apiKey}` },
		});
		if (response.ok) {
			const data = (await response.json()) as {
				username?: string;
				email?: string;
			};
			const identifier = data.username || data.email || "your account";
			return {
				success: true,
				message: `Front connected as ${identifier}`,
			};
		}
		return {
			success: false,
			error: `Front returned status ${response.status}`,
		};
	} catch (error) {
		return {
			success: false,
			error:
				error instanceof Error
					? error.message
					: "Failed to connect to Front",
		};
	}
}

/**
 * Connection tests for the providers ported from
 * vercel-labs/workflow-builder-template. Each uses the cheapest authenticated
 * read that provider offers, so a test touches no customer data.
 */
async function testStripeConnection(
	credentials: Record<string, string>,
): Promise<TestConnectionResult> {
	return await probe(
		"Stripe",
		"https://api.stripe.com/v1/balance",
		{ Authorization: `Bearer ${credentials.STRIPE_SECRET_KEY ?? ""}` },
		Boolean(credentials.STRIPE_SECRET_KEY),
		"Secret key is required",
	);
}

async function testWebflowConnection(
	credentials: Record<string, string>,
): Promise<TestConnectionResult> {
	return await probe(
		"Webflow",
		"https://api.webflow.com/v2/sites",
		{ Authorization: `Bearer ${credentials.WEBFLOW_API_KEY ?? ""}` },
		Boolean(credentials.WEBFLOW_API_KEY),
		"API token is required",
	);
}

async function testClerkConnection(
	credentials: Record<string, string>,
): Promise<TestConnectionResult> {
	return await probe(
		"Clerk",
		"https://api.clerk.com/v1/users?limit=1",
		{ Authorization: `Bearer ${credentials.CLERK_SECRET_KEY ?? ""}` },
		Boolean(credentials.CLERK_SECRET_KEY),
		"Secret key is required",
	);
}

async function testBlobConnection(
	credentials: Record<string, string>,
): Promise<TestConnectionResult> {
	return await probe(
		"Vercel Blob",
		"https://blob.vercel-storage.com?limit=1",
		{
			Authorization: `Bearer ${credentials.BLOB_READ_WRITE_TOKEN ?? ""}`,
			"x-api-version": "7",
		},
		Boolean(credentials.BLOB_READ_WRITE_TOKEN),
		"Read/write token is required",
	);
}

async function testSuperagentConnection(
	credentials: Record<string, string>,
): Promise<TestConnectionResult> {
	if (!credentials.SUPERAGENT_API_KEY) {
		return { success: false, error: "API key is required" };
	}
	// Superagent has no auth-check endpoint; a trivial guard call proves the
	// key is accepted without classifying anything meaningful.
	try {
		const response = await fetch("https://app.superagent.sh/api/guard", {
			method: "POST",
			headers: {
				"Content-Type": "application/json",
				Authorization: `Bearer ${credentials.SUPERAGENT_API_KEY}`,
			},
			body: JSON.stringify({ text: "ping" }),
		});
		if (response.status === 401 || response.status === 403) {
			return { success: false, error: "Superagent rejected the API key" };
		}
		return response.ok
			? { success: true, message: "Connected to Superagent" }
			: {
					success: false,
					error: `Superagent returned HTTP ${response.status}`,
				};
	} catch (error) {
		return {
			success: false,
			error:
				error instanceof Error
					? error.message
					: "Failed to connect to Superagent",
		};
	}
}

/** Shared GET probe for the ported providers. */
async function probe(
	label: string,
	url: string,
	headers: Record<string, string>,
	hasCredential: boolean,
	missingMessage: string,
): Promise<TestConnectionResult> {
	if (!hasCredential) {
		return { success: false, error: missingMessage };
	}
	try {
		const response = await fetch(url, { headers });
		if (!response.ok) {
			return {
				success: false,
				error: `${label} rejected the credential (HTTP ${response.status})`,
			};
		}
		return { success: true, message: `Connected to ${label}` };
	} catch (error) {
		return {
			success: false,
			error:
				error instanceof Error
					? error.message
					: `Failed to connect to ${label}`,
		};
	}
}

const connectionTesters: Record<
	IntegrationType,
	(credentials: Record<string, string>) => Promise<TestConnectionResult>
> = {
	AI_GATEWAY: testAiGatewayConnection,
	BLOB: testBlobConnection,
	CLERK: testClerkConnection,
	STRIPE: testStripeConnection,
	SUPERAGENT: testSuperagentConnection,
	WEBFLOW: testWebflowConnection,
	ASANA: testAsanaSavedConnection,
	ATTIO: testAttioSavedConnection,
	BITBUCKET: testBitbucketConnection,
	CANVA: testCanvaSavedConnection,
	CLICKUP: testClickUpConnection,
	CONFLUENCE: testConfluenceConnection,
	CUSTOM_WEBHOOK: testWebhookConnection,
	DATABASE: testDatabaseConnection,
	DATABRICKS_VECTOR_SEARCH: testDatabricksVectorSearchConnection,
	FAL: testFalConnection,
	FIRECRAWL: testFirecrawlConnection,
	FRESHSERVICE: testFreshserviceSavedConnection,
	FRONT: testFrontSavedConnection,
	GMAIL: testGmailConnection,
	GITHUB: testGithubConnection,
	GITLAB: testGitLabConnection,
	GOOGLE_DRIVE: testGoogleDriveConnection,
	HUBSPOT: testHubSpotConnection,
	INTERCOM: testIntercomConnection,
	JIRA: testJiraConnection,
	LINEAR: testLinearConnection,
	MCP: testMcpConnection,
	MICROSOFT_GRAPH: testMicrosoftConnection,
	NHTSA_VPIC: testNhtsaVpicConnection,
	NOTION: testNotionConnection,
	PERPLEXITY: testPerplexityConnection,
	RESEND: testResendConnection,
	SALESFORCE: testSalesforceConnection,
	SLACK: testSlackConnection,
	TELEGRAM: testTelegramConnection,
	ZENDESK: testZendeskConnection,
};

async function testTelegramConnection(
	credentials: Record<string, string>,
): Promise<TestConnectionResult> {
	const token =
		credentials.bot_token || credentials.token || credentials.apiKey;
	if (!token) {
		return { success: false, error: "Telegram bot_token is required" };
	}
	try {
		const res = await fetch(`https://api.telegram.org/bot${token}/getMe`);
		const json = (await res.json()) as {
			ok: boolean;
			result?: { username?: string };
			description?: string;
		};
		if (!json.ok) {
			return {
				success: false,
				error: json.description ?? `HTTP ${res.status}`,
			};
		}
		return {
			success: true,
			message: `Connected as @${json.result?.username ?? "(unknown)"}`,
		};
	} catch (err) {
		return { success: false, error: (err as Error).message };
	}
}

export const testSavedConnectionProcedure = tenantProtectedProcedure
	.use(requirePermission(Permissions.WORKSPACE_READ))
	.route({
		method: "POST",
		path: "/workflows/integrations/test-saved",
		tags: ["Workflows", "Integrations"],
		summary: "Test saved integration connection",
		description: "Test connection using already-saved credentials",
	})
	.input(
		z.object({
			type: IntegrationTypeEnum,
			organizationId: z.string().nullable().optional(),
		}),
	)
	.handler(async ({ input, context }) => {
		const user = context.user;
		const organizationId = resolveOrganizationId(
			input.organizationId,
			context.session,
		);

		// Verify organization membership if in org context
		if (organizationId) {
			const membership = await verifyOrganizationMembership(
				organizationId,
				user.id,
			);

			if (!membership) {
				throw new ORPCError("FORBIDDEN", {
					message: "You are not a member of this organization",
				});
			}
		}

		// Find the saved integration
		const integrations = await listWorkflowIntegrations({
			userId: user.id,
			organizationId,
			provider: input.type,
		});

		if (integrations.length === 0) {
			return {
				success: false,
				error: "No saved credentials found for this integration",
			};
		}

		const integration = integrations[0];

		// Decrypt credentials
		let credentials: Record<string, string>;
		try {
			credentials = JSON.parse(decryptApiKey(integration.credentials));
			console.log(
				`[testSavedConnection] ${input.type} credentials keys:`,
				Object.keys(credentials),
			);
		} catch (e) {
			console.error(
				"[testSavedConnection] Failed to decrypt credentials:",
				e,
			);
			return {
				success: false,
				error: "Failed to decrypt stored credentials",
			};
		}

		// Test the connection
		const tester = connectionTesters[input.type];
		if (!tester) {
			throw new ORPCError("BAD_REQUEST", {
				message: `Unknown integration type: ${input.type}`,
			});
		}

		const result = await tester(credentials);
		return result;
	});
