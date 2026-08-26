/**
 * Integration Data Source Handler
 *
 * Handles data fetching from Workflow Integrations (OAuth/API key based).
 * Supports Slack, GitHub, Linear, and other configured integrations.
 */

import type { WorkflowIntegrationProvider } from "@repo/database";
import {
	fetchCredentialsById,
	fetchCredentialsByProvider,
} from "@repo/database";
import { logger } from "@repo/logs";
import type {
	DataSourceDefinition,
	DataSourceHandler,
	FetchContext,
	FetchResult,
	InstanceConnections,
} from "../types";

export class IntegrationDataSourceHandler implements DataSourceHandler {
	type = "integration" as const;
	supportedProviders = [
		"slack",
		"github",
		"linear",
		"jira",
		"resend",
		"perplexity",
		"firecrawl",
	];

	async validateConnection(
		dataSource: DataSourceDefinition,
		connections: InstanceConnections,
		userId: string,
		organizationId?: string,
	): Promise<{ valid: boolean; error?: string }> {
		// Check for explicit integration binding
		const integrationId = connections.integrationBindings?.[dataSource.id];

		if (integrationId) {
			const credentials = await fetchCredentialsById(
				integrationId,
				userId,
				organizationId,
			);
			if (!credentials) {
				return {
					valid: false,
					error: `Integration ${integrationId} not found or inactive`,
				};
			}
			return { valid: true };
		}

		// Fall back to provider lookup
		const providerName =
			dataSource.provider.toUpperCase() as WorkflowIntegrationProvider;
		const credentials = await fetchCredentialsByProvider(
			providerName,
			userId,
			organizationId,
		);

		if (!credentials || Object.keys(credentials).length === 0) {
			return {
				valid: false,
				error: `No ${dataSource.provider} integration configured. Please set up in Settings > Integrations.`,
			};
		}

		return { valid: true };
	}

	async fetchData(
		dataSource: DataSourceDefinition,
		connections: InstanceConnections,
		context: FetchContext,
	): Promise<FetchResult> {
		const provider =
			dataSource.provider.toUpperCase() as WorkflowIntegrationProvider;

		// Get credentials
		const integrationId = connections.integrationBindings?.[dataSource.id];
		const credentials = integrationId
			? await fetchCredentialsById(
					integrationId,
					context.userId,
					context.organizationId,
				)
			: await fetchCredentialsByProvider(
					provider,
					context.userId,
					context.organizationId,
				);

		if (!credentials) {
			return {
				success: false,
				data: [],
				recordCount: 0,
				hasMore: false,
				metadata: {
					provider: dataSource.provider,
					operation: dataSource.operation,
					fetchedAt: new Date().toISOString(),
				},
				error: `No ${provider} credentials found. Please configure in Settings > Integrations.`,
			};
		}

		logger.info("[IntegrationHandler] Fetching data", {
			dataSourceId: dataSource.id,
			provider: dataSource.provider,
			operation: dataSource.operation,
		});

		// Route to provider-specific fetcher
		switch (provider) {
			case "SLACK":
				return this.fetchSlackData(
					credentials,
					dataSource,
					connections,
					context,
				);
			case "GITHUB":
				return this.fetchGitHubData(
					credentials,
					dataSource,
					connections,
					context,
				);
			case "LINEAR":
				return this.fetchLinearData(
					credentials,
					dataSource,
					connections,
					context,
				);
			default:
				return {
					success: false,
					data: [],
					recordCount: 0,
					hasMore: false,
					metadata: {
						provider: dataSource.provider,
						operation: dataSource.operation,
						fetchedAt: new Date().toISOString(),
					},
					error: `Unsupported integration provider: ${provider}. Use MCP server instead.`,
				};
		}
	}

	async fetchIncremental(
		dataSource: DataSourceDefinition,
		lastTimestamp: string,
		connections: InstanceConnections,
		context: FetchContext,
	): Promise<FetchResult> {
		const incrementalContext: FetchContext = {
			...context,
			dateRange: {
				start: lastTimestamp,
				end: new Date().toISOString(),
			},
		};

		return this.fetchData(dataSource, connections, incrementalContext);
	}

	// ===========================================================================
	// Slack
	// ===========================================================================

	private async fetchSlackData(
		credentials: Record<string, string>,
		dataSource: DataSourceDefinition,
		connections: InstanceConnections,
		context: FetchContext,
	): Promise<FetchResult> {
		const token = credentials.SLACK_API_KEY;
		if (!token) {
			return this.errorResult(
				dataSource,
				"Slack API token not configured",
			);
		}

		const resourceBinding =
			connections.resourceBindings?.[dataSource.id] ||
			connections.resourceBindings?.[dataSource.provider];

		const channel =
			resourceBinding?.resourceId ||
			(context.parameters.channel as string) ||
			(context.parameters.channelId as string);

		if (!channel) {
			return this.errorResult(
				dataSource,
				"Slack channel is required. Please select a channel in the instance configuration.",
			);
		}

		// Support pagination for large datasets
		const allMessages: unknown[] = [];
		let cursor: string | undefined;
		let hasMore = true;
		const limit = dataSource.config.limit || 1000;

		try {
			while (hasMore && allMessages.length < limit) {
				const params = new URLSearchParams({
					channel,
					limit: String(Math.min(200, limit - allMessages.length)),
				});

				if (cursor) {
					params.append("cursor", cursor);
				}

				// Add date range filters
				if (context.dateRange?.start) {
					params.append(
						"oldest",
						this.dateToSlackTs(context.dateRange.start),
					);
				}
				if (context.dateRange?.end) {
					params.append(
						"latest",
						this.dateToSlackTs(context.dateRange.end),
					);
				}

				const response = await fetch(
					`https://slack.com/api/conversations.history?${params}`,
					{
						headers: { Authorization: `Bearer ${token}` },
					},
				);

				const data = await response.json();

				if (!data.ok) {
					const errorMessage = this.formatSlackError(
						data.error,
						channel,
					);
					return this.errorResult(dataSource, errorMessage);
				}

				allMessages.push(...(data.messages || []));
				cursor = data.response_metadata?.next_cursor;
				hasMore = !!cursor;
			}

			// Extract latest timestamp for incremental
			const latestTs = allMessages[0]
				? (allMessages[0] as { ts: string }).ts
				: undefined;

			logger.info("[IntegrationHandler] Slack fetch complete", {
				channel,
				messageCount: allMessages.length,
				hasMore: !!cursor,
			});

			return {
				success: true,
				data: allMessages,
				recordCount: allMessages.length,
				hasMore: !!cursor,
				cursor,
				metadata: {
					provider: "slack",
					operation: dataSource.operation,
					fetchedAt: new Date().toISOString(),
					latestTimestamp: latestTs
						? new Date(
								Number.parseFloat(latestTs) * 1000,
							).toISOString()
						: undefined,
				},
			};
		} catch (error) {
			return this.errorResult(
				dataSource,
				error instanceof Error
					? error.message
					: "Failed to fetch Slack messages",
			);
		}
	}

	private formatSlackError(error: string, channel: string): string {
		switch (error) {
			case "channel_not_found":
				return `Channel "${channel}" not found. Make sure the bot is invited to the channel.`;
			case "not_in_channel":
				return `Bot is not in channel "${channel}". Please invite the bot to the channel first.`;
			case "missing_scope":
				return "Bot lacks permission to read channel history. Required scope: channels:history (public) or groups:history (private).";
			case "invalid_auth":
				return "Slack token is invalid or expired. Please re-configure the Slack integration.";
			default:
				return `Slack API error: ${error}`;
		}
	}

	private dateToSlackTs(date: string): string {
		return String(new Date(date).getTime() / 1000);
	}

	// ===========================================================================
	// GitHub
	// ===========================================================================

	private async fetchGitHubData(
		credentials: Record<string, string>,
		dataSource: DataSourceDefinition,
		_connections: InstanceConnections,
		context: FetchContext,
	): Promise<FetchResult> {
		const token = credentials.GITHUB_TOKEN;
		if (!token) {
			return this.errorResult(dataSource, "GitHub token not configured");
		}

		const headers = {
			Authorization: `Bearer ${token}`,
			Accept: "application/vnd.github.v3+json",
			"X-GitHub-Api-Version": "2022-11-28",
		};

		const owner =
			(context.parameters.owner as string) ||
			(dataSource.config.args?.owner as string);
		const repo =
			(context.parameters.repo as string) ||
			(dataSource.config.args?.repo as string);

		try {
			let data: unknown[] = [];
			let endpoint: string;

			switch (dataSource.operation) {
				case "list_issues":
				case "github_list_issues": {
					if (!owner || !repo) {
						return this.errorResult(
							dataSource,
							"owner and repo are required",
						);
					}
					endpoint = `https://api.github.com/repos/${owner}/${repo}/issues`;
					const issuesParams = new URLSearchParams({
						state: (context.parameters.state as string) || "all",
						per_page: String(dataSource.config.limit || 100),
					});
					if (context.dateRange?.start) {
						issuesParams.append("since", context.dateRange.start);
					}
					const issuesRes = await fetch(
						`${endpoint}?${issuesParams}`,
						{ headers },
					);
					data = await issuesRes.json();
					break;
				}

				case "list_pull_requests":
				case "github_list_prs": {
					if (!owner || !repo) {
						return this.errorResult(
							dataSource,
							"owner and repo are required",
						);
					}
					endpoint = `https://api.github.com/repos/${owner}/${repo}/pulls`;
					const prsParams = new URLSearchParams({
						state: (context.parameters.state as string) || "all",
						per_page: String(dataSource.config.limit || 100),
					});
					const prsRes = await fetch(`${endpoint}?${prsParams}`, {
						headers,
					});
					data = await prsRes.json();
					break;
				}

				case "list_commits":
				case "github_get_commits": {
					if (!owner || !repo) {
						return this.errorResult(
							dataSource,
							"owner and repo are required",
						);
					}
					endpoint = `https://api.github.com/repos/${owner}/${repo}/commits`;
					const commitsParams = new URLSearchParams({
						per_page: String(dataSource.config.limit || 100),
					});
					if (context.dateRange?.start) {
						commitsParams.append("since", context.dateRange.start);
					}
					if (context.dateRange?.end) {
						commitsParams.append("until", context.dateRange.end);
					}
					const commitsRes = await fetch(
						`${endpoint}?${commitsParams}`,
						{ headers },
					);
					data = await commitsRes.json();
					break;
				}

				default:
					return this.errorResult(
						dataSource,
						`Unsupported GitHub operation: ${dataSource.operation}`,
					);
			}

			if (!Array.isArray(data)) {
				if ((data as { message?: string }).message) {
					return this.errorResult(
						dataSource,
						`GitHub API error: ${(data as { message: string }).message}`,
					);
				}
				data = [data];
			}

			// Extract latest timestamp
			const latestTimestamp = this.extractGitHubTimestamp(data);

			logger.info("[IntegrationHandler] GitHub fetch complete", {
				operation: dataSource.operation,
				recordCount: data.length,
			});

			return {
				success: true,
				data,
				recordCount: data.length,
				hasMore: false, // Would need Link header parsing for pagination
				metadata: {
					provider: "github",
					operation: dataSource.operation,
					fetchedAt: new Date().toISOString(),
					latestTimestamp,
				},
			};
		} catch (error) {
			return this.errorResult(
				dataSource,
				error instanceof Error
					? error.message
					: "Failed to fetch GitHub data",
			);
		}
	}

	private extractGitHubTimestamp(data: unknown[]): string | undefined {
		if (data.length === 0) {
			return undefined;
		}
		const first = data[0] as {
			updated_at?: string;
			created_at?: string;
			commit?: { author?: { date?: string } };
		};
		return (
			first.updated_at ||
			first.created_at ||
			first.commit?.author?.date ||
			undefined
		);
	}

	// ===========================================================================
	// Linear
	// ===========================================================================

	private async fetchLinearData(
		credentials: Record<string, string>,
		dataSource: DataSourceDefinition,
		_connections: InstanceConnections,
		context: FetchContext,
	): Promise<FetchResult> {
		const apiKey = credentials.LINEAR_API_KEY;
		if (!apiKey) {
			return this.errorResult(
				dataSource,
				"Linear API key not configured",
			);
		}

		try {
			let query: string;
			let variables: Record<string, unknown> = {};

			switch (dataSource.operation) {
				case "linear_search_issues":
				case "search_issues":
					query = `
						query SearchIssues($filter: IssueFilter, $first: Int) {
							issues(filter: $filter, first: $first) {
								nodes {
									id
									identifier
									title
									description
									state { name }
									assignee { name email }
									priority
									labels { nodes { name } }
									createdAt
									updatedAt
								}
							}
						}
					`;
					variables = {
						filter: context.parameters.filter || {},
						first: dataSource.config.limit || 50,
					};
					break;

				case "linear_list_projects":
				case "list_projects":
					query = `
						query ListProjects($first: Int) {
							projects(first: $first) {
								nodes {
									id
									name
									state
									progress
									targetDate
									startDate
									description
								}
							}
						}
					`;
					variables = { first: dataSource.config.limit || 50 };
					break;

				default:
					return this.errorResult(
						dataSource,
						`Unsupported Linear operation: ${dataSource.operation}`,
					);
			}

			const response = await fetch("https://api.linear.app/graphql", {
				method: "POST",
				headers: {
					Authorization: apiKey,
					"Content-Type": "application/json",
				},
				body: JSON.stringify({ query, variables }),
			});

			const result = await response.json();

			if (result.errors) {
				return this.errorResult(
					dataSource,
					`Linear API error: ${result.errors.map((e: { message: string }) => e.message).join(", ")}`,
				);
			}

			// Extract data from GraphQL response
			const dataKey = Object.keys(result.data || {})[0];
			const nodes = result.data?.[dataKey]?.nodes || [];

			// Extract latest timestamp
			const latestTimestamp = nodes[0]?.updatedAt || nodes[0]?.createdAt;

			logger.info("[IntegrationHandler] Linear fetch complete", {
				operation: dataSource.operation,
				recordCount: nodes.length,
			});

			return {
				success: true,
				data: nodes,
				recordCount: nodes.length,
				hasMore: false,
				metadata: {
					provider: "linear",
					operation: dataSource.operation,
					fetchedAt: new Date().toISOString(),
					latestTimestamp,
				},
			};
		} catch (error) {
			return this.errorResult(
				dataSource,
				error instanceof Error
					? error.message
					: "Failed to fetch Linear data",
			);
		}
	}

	// ===========================================================================
	// Helpers
	// ===========================================================================

	private errorResult(
		dataSource: DataSourceDefinition,
		error: string,
	): FetchResult {
		logger.error("[IntegrationHandler] Fetch error", {
			dataSourceId: dataSource.id,
			provider: dataSource.provider,
			error,
		});
		return {
			success: false,
			data: [],
			recordCount: 0,
			hasMore: false,
			metadata: {
				provider: dataSource.provider,
				operation: dataSource.operation,
				fetchedAt: new Date().toISOString(),
			},
			error,
		};
	}
}
