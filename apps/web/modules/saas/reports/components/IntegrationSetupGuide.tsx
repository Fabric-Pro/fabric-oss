"use client";

import { useContextPath } from "@saas/organizations/hooks";
import { Badge } from "@ui/components/badge";
import { Card, CardContent, CardHeader } from "@ui/components/card";
import {
	ChevronDownIcon,
	ChevronRightIcon,
	ExternalLinkIcon,
	HelpCircleIcon,
} from "lucide-react";
import Link from "next/link";
import { useState } from "react";

export type IntegrationType = "slack" | "github" | "linear" | "atlassian";

interface IntegrationGuide {
	name: string;
	description: string;
	scopes: string[];
	steps: Array<{
		title: string;
		content: React.ReactNode;
	}>;
	errors?: Array<{
		code: string;
		description: string;
	}>;
}

/**
 * Context-aware link component for integrations settings.
 * Uses useContextPath internally to generate correct URL based on context.
 */
function IntegrationsSettingsLink({
	children,
	className,
}: {
	children: React.ReactNode;
	className?: string;
}) {
	const settingsPath = useContextPath("settings/integrations");
	return (
		<Link href={settingsPath} className={className}>
			{children} <ExternalLinkIcon className="h-3 w-3 inline" />
		</Link>
	);
}

const INTEGRATION_GUIDES: Record<IntegrationType, IntegrationGuide> = {
	slack: {
		name: "Slack",
		description:
			"Connect to Slack to read channel messages and send updates",
		scopes: [
			"channels:read",
			"channels:history",
			"groups:history",
			"chat:write",
		],
		steps: [
			{
				title: "1. Create a Slack App",
				content: (
					<p className="text-muted-foreground">
						Go to{" "}
						<a
							href="https://api.slack.com/apps"
							target="_blank"
							rel="noopener noreferrer"
							className="text-blue-600 hover:underline inline-flex items-center gap-1"
						>
							api.slack.com/apps{" "}
							<ExternalLinkIcon className="h-3 w-3" />
						</a>{" "}
						and create a new app or select an existing one.
					</p>
				),
			},
			{
				title: "2. Add Bot Token Scopes",
				content: (
					<>
						<p className="text-muted-foreground mb-2">
							Go to <strong>OAuth & Permissions</strong> →{" "}
							<strong>Bot Token Scopes</strong> and add:
						</p>
						<ul className="list-disc list-inside text-muted-foreground space-y-1 ml-2">
							<li>
								<code className="bg-muted px-1 rounded">
									channels:read
								</code>{" "}
								- View basic channel info
							</li>
							<li>
								<code className="bg-muted px-1 rounded">
									channels:history
								</code>{" "}
								- Read public channel messages
							</li>
							<li>
								<code className="bg-muted px-1 rounded">
									groups:history
								</code>{" "}
								- Read private channel messages
							</li>
							<li>
								<code className="bg-muted px-1 rounded">
									chat:write
								</code>{" "}
								- Send messages (if needed)
							</li>
						</ul>
					</>
				),
			},
			{
				title: "3. Install App to Workspace",
				content: (
					<p className="text-muted-foreground">
						Click <strong>Install to Workspace</strong> (or{" "}
						<strong>Reinstall</strong> if updating scopes). Copy the{" "}
						<strong>Bot User OAuth Token</strong> (starts with{" "}
						<code className="bg-muted px-1 rounded">xoxb-</code>).
					</p>
				),
			},
			{
				title: "4. Add Token to Fabric",
				content: (
					<p className="text-muted-foreground">
						Go to{" "}
						<IntegrationsSettingsLink className="text-blue-600 hover:underline inline-flex items-center gap-1">
							Settings → Integrations
						</IntegrationsSettingsLink>{" "}
						and add your Slack integration with the bot token.
					</p>
				),
			},
			{
				title: "5. Invite Bot to Channels",
				content: (
					<p className="text-muted-foreground">
						In Slack, invite the bot to channels you want to read:{" "}
						<code className="bg-muted px-1 rounded">
							/invite @YourBotName
						</code>
					</p>
				),
			},
		],
		errors: [
			{
				code: "missing_scope",
				description: "Add the required scope and reinstall the app",
			},
			{
				code: "channel_not_found",
				description: "Check channel ID or invite bot to the channel",
			},
			{
				code: "not_in_channel",
				description: "Bot needs to be invited to the channel",
			},
		],
	},
	github: {
		name: "GitHub",
		description:
			"Connect to GitHub to access repositories, issues, and pull requests",
		scopes: ["repo", "read:org", "read:user"],
		steps: [
			{
				title: "1. Create a Personal Access Token",
				content: (
					<p className="text-muted-foreground">
						Go to{" "}
						<a
							href="https://github.com/settings/tokens"
							target="_blank"
							rel="noopener noreferrer"
							className="text-blue-600 hover:underline inline-flex items-center gap-1"
						>
							GitHub Settings → Developer settings → Personal
							access tokens{" "}
							<ExternalLinkIcon className="h-3 w-3" />
						</a>{" "}
						and generate a new token (classic or fine-grained).
					</p>
				),
			},
			{
				title: "2. Select Required Scopes",
				content: (
					<>
						<p className="text-muted-foreground mb-2">
							For <strong>Classic tokens</strong>, select these
							scopes:
						</p>
						<ul className="list-disc list-inside text-muted-foreground space-y-1 ml-2">
							<li>
								<code className="bg-muted px-1 rounded">
									repo
								</code>{" "}
								- Full control of private repositories
							</li>
							<li>
								<code className="bg-muted px-1 rounded">
									read:org
								</code>{" "}
								- Read org membership (if accessing org repos)
							</li>
							<li>
								<code className="bg-muted px-1 rounded">
									read:user
								</code>{" "}
								- Read user profile data
							</li>
						</ul>
						<p className="text-muted-foreground mt-2 text-xs">
							For <strong>Fine-grained tokens</strong>, select
							repository access and required permissions for
							contents, issues, and pull requests.
						</p>
					</>
				),
			},
			{
				title: "3. Copy and Save Token",
				content: (
					<p className="text-muted-foreground">
						Copy the generated token immediately - GitHub only shows
						it once. Store it securely until you add it to Fabric.
					</p>
				),
			},
			{
				title: "4. Add Token to Fabric",
				content: (
					<p className="text-muted-foreground">
						Go to{" "}
						<IntegrationsSettingsLink className="text-blue-600 hover:underline inline-flex items-center gap-1">
							Settings → Integrations
						</IntegrationsSettingsLink>{" "}
						and add your GitHub integration with the personal access
						token.
					</p>
				),
			},
		],
		errors: [
			{
				code: "Bad credentials",
				description: "Token is invalid or expired - generate a new one",
			},
			{
				code: "Not Found",
				description: "Repository doesn't exist or token lacks access",
			},
			{
				code: "API rate limit exceeded",
				description:
					"Wait for rate limit reset or use authenticated requests",
			},
		],
	},
	linear: {
		name: "Linear",
		description:
			"Connect to Linear to access issues, projects, and team workflows",
		scopes: ["read", "write"],
		steps: [
			{
				title: "1. Create an API Key",
				content: (
					<p className="text-muted-foreground">
						Go to{" "}
						<a
							href="https://linear.app/settings/api"
							target="_blank"
							rel="noopener noreferrer"
							className="text-blue-600 hover:underline inline-flex items-center gap-1"
						>
							Linear Settings → API{" "}
							<ExternalLinkIcon className="h-3 w-3" />
						</a>{" "}
						and create a new personal API key.
					</p>
				),
			},
			{
				title: "2. Label Your Key",
				content: (
					<p className="text-muted-foreground">
						Give your API key a descriptive label like{" "}
						<code className="bg-muted px-1 rounded">
							Fabric Integration
						</code>
						so you can identify it later.
					</p>
				),
			},
			{
				title: "3. Copy API Key",
				content: (
					<p className="text-muted-foreground">
						Copy the generated API key immediately - Linear only
						shows it once. The key starts with{" "}
						<code className="bg-muted px-1 rounded">lin_api_</code>.
					</p>
				),
			},
			{
				title: "4. Add Key to Fabric",
				content: (
					<p className="text-muted-foreground">
						Go to{" "}
						<IntegrationsSettingsLink className="text-blue-600 hover:underline inline-flex items-center gap-1">
							Settings → Integrations
						</IntegrationsSettingsLink>{" "}
						and add your Linear integration with the API key.
					</p>
				),
			},
		],
		errors: [
			{
				code: "Authentication failed",
				description: "API key is invalid - generate a new one",
			},
			{
				code: "Not found",
				description:
					"Issue or project doesn't exist or you lack access",
			},
		],
	},
	atlassian: {
		name: "Atlassian (JIRA / Confluence)",
		description:
			"Connect to JIRA and Confluence to access issues, projects, and documentation",
		scopes: [
			"read:jira-work",
			"read:jira-user",
			"read:confluence-content.all",
		],
		steps: [
			{
				title: "1. Create an API Token",
				content: (
					<p className="text-muted-foreground">
						Go to{" "}
						<a
							href="https://id.atlassian.com/manage-profile/security/api-tokens"
							target="_blank"
							rel="noopener noreferrer"
							className="text-blue-600 hover:underline inline-flex items-center gap-1"
						>
							Atlassian Account → Security → API tokens{" "}
							<ExternalLinkIcon className="h-3 w-3" />
						</a>{" "}
						and create a new API token.
					</p>
				),
			},
			{
				title: "2. Label Your Token",
				content: (
					<p className="text-muted-foreground">
						Give your token a descriptive label like{" "}
						<code className="bg-muted px-1 rounded">
							Fabric Integration
						</code>
						. Copy the token immediately as Atlassian won't show it
						again.
					</p>
				),
			},
			{
				title: "3. Note Your Site URL",
				content: (
					<>
						<p className="text-muted-foreground mb-2">
							You'll need your Atlassian site URL in the format:
						</p>
						<code className="bg-muted px-2 py-1 rounded block text-center">
							https://your-domain.atlassian.net
						</code>
					</>
				),
			},
			{
				title: "4. Add Credentials to Fabric",
				content: (
					<>
						<p className="text-muted-foreground mb-2">
							Go to{" "}
							<IntegrationsSettingsLink className="text-blue-600 hover:underline inline-flex items-center gap-1">
								Settings → Integrations
							</IntegrationsSettingsLink>{" "}
							and add your Atlassian integration with:
						</p>
						<ul className="list-disc list-inside text-muted-foreground space-y-1 ml-2">
							<li>
								Your email address (Atlassian account email)
							</li>
							<li>The API token you created</li>
							<li>Your site URL</li>
						</ul>
					</>
				),
			},
		],
		errors: [
			{
				code: "401 Unauthorized",
				description: "Check your email and API token are correct",
			},
			{
				code: "403 Forbidden",
				description:
					"Your account may lack permissions for this resource",
			},
			{
				code: "404 Not Found",
				description: "Check the project key or issue ID exists",
			},
		],
	},
};

interface IntegrationSetupGuideProps {
	integrationType: IntegrationType;
	defaultExpanded?: boolean;
	className?: string;
}

export function IntegrationSetupGuide({
	integrationType,
	defaultExpanded = false,
	className = "",
}: IntegrationSetupGuideProps) {
	const [isExpanded, setIsExpanded] = useState(defaultExpanded);
	const guide = INTEGRATION_GUIDES[integrationType];

	if (!guide) {
		return null;
	}

	return (
		<Card
			className={`border-blue-200 dark:border-blue-800 bg-blue-50/50 dark:bg-blue-950/20 ${className}`}
		>
			<CardHeader
				className="cursor-pointer py-3"
				onClick={() => setIsExpanded(!isExpanded)}
			>
				<button
					type="button"
					className="flex items-center gap-2 text-left w-full"
				>
					{isExpanded ? (
						<ChevronDownIcon className="h-4 w-4 text-blue-600" />
					) : (
						<ChevronRightIcon className="h-4 w-4 text-blue-600" />
					)}
					<HelpCircleIcon className="h-4 w-4 text-blue-600" />
					<span className="font-medium text-blue-900 dark:text-blue-100">
						{guide.name} Integration Setup Guide
					</span>
				</button>
			</CardHeader>
			{isExpanded && (
				<CardContent className="text-sm space-y-4">
					<p className="text-muted-foreground">{guide.description}</p>

					{/* Required Scopes */}
					<div>
						<h4 className="font-medium mb-2">
							Required Scopes/Permissions
						</h4>
						<div className="flex flex-wrap gap-1">
							{guide.scopes.map((scope) => (
								<Badge
									key={scope}
									variant="outline"
									className="text-xs"
								>
									{scope}
								</Badge>
							))}
						</div>
					</div>

					{/* Setup Steps */}
					{guide.steps.map((step, index) => (
						<div key={index}>
							<h4 className="font-medium mb-2">{step.title}</h4>
							{step.content}
						</div>
					))}

					{/* Quick Link to Settings */}
					<div className="pt-2 border-t">
						<p className="text-muted-foreground">
							Ready to configure?{" "}
							<IntegrationsSettingsLink className="text-blue-600 hover:underline inline-flex items-center gap-1">
								Go to Integrations Settings
							</IntegrationsSettingsLink>
						</p>
					</div>

					{/* Common Errors */}
					{guide.errors && guide.errors.length > 0 && (
						<div className="pt-2 border-t">
							<h4 className="font-medium mb-2 text-amber-700 dark:text-amber-400">
								Common Errors
							</h4>
							<ul className="text-muted-foreground space-y-1 text-xs">
								{guide.errors.map((error) => (
									<li key={error.code}>
										<strong>{error.code}</strong> -{" "}
										{error.description}
									</li>
								))}
							</ul>
						</div>
					)}
				</CardContent>
			)}
		</Card>
	);
}

// Utility to get integration type from data source type string
export function getIntegrationTypeFromDataSource(
	dataSourceType: string,
): IntegrationType | null {
	const typeMap: Record<string, IntegrationType> = {
		slack: "slack",
		"slack-channel": "slack",
		"slack-messages": "slack",
		github: "github",
		"github-repo": "github",
		"github-issues": "github",
		"github-prs": "github",
		linear: "linear",
		"linear-issues": "linear",
		"linear-project": "linear",
		atlassian: "atlassian",
		jira: "atlassian",
		"jira-issues": "atlassian",
		confluence: "atlassian",
	};

	return typeMap[dataSourceType.toLowerCase()] || null;
}
