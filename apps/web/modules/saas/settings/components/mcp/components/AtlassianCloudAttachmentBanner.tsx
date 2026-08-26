/**
 * Atlassian Cloud Attachment Banner
 *
 * Shown beneath a connected Atlassian (Rovo MCP) config card. Surfaces
 * the state of the SECONDARY hybrid Atlassian Cloud OAuth connection —
 * the one that unlocks real-screenshot attachment upload on Jira push.
 *
 * Three states, driven by `mcp.atlassianCloud.status`:
 *
 *   A) connected            → subtle success pill, no nagging.
 *   B) envConfigured, !connected → actionable "Enable image attachments"
 *                              banner with a one-click connect button.
 *                              Covers the case where the Rovo→Cloud
 *                              auto-chain didn't fire (e.g. user connected
 *                              before the secrets were synced).
 *   C) !envConfigured        → admin-only muted hint that real-screenshot
 *                              uploads need a one-time workspace setup,
 *                              linking to the setup guide. Hidden for
 *                              non-admins (they can't fix env vars).
 *
 * The banner renders nothing for non-Atlassian configs, for disconnected
 * Atlassian configs (connect the primary Rovo OAuth first), and while the
 * status query is in flight.
 */

import { orpcClient } from "@shared/lib/orpc-client";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { Button } from "@ui/components/button";
import {
	CheckCircle2Icon,
	ExternalLinkIcon,
	ImageIcon,
	InfoIcon,
	LoaderIcon,
} from "lucide-react";
import { toast } from "sonner";
import type { McpConfig } from "../types";

/** Public docs page explaining the Atlassian Console + env-var setup. */
const SETUP_GUIDE_URL = "/docs/integrations/atlassian-cloud-attachments";

/**
 * Strict detection: only the official Atlassian Rovo MCP qualifies for
 * the hybrid Cloud flow. Hostname match guards against lookalike custom
 * servers; serverKey is the STDIO/no-baseUrl fallback.
 */
function isAtlassianRovoConfig(config: McpConfig): boolean {
	if (config.mcpServer?.key === "atlassian") {
		return true;
	}
	const url = config.baseUrl || config.mcpServer?.defaultUrl;
	if (!url) {
		return false;
	}
	try {
		return new URL(url).hostname === "mcp.atlassian.com";
	} catch {
		return false;
	}
}

export interface AtlassianCloudAttachmentBannerProps {
	config: McpConfig;
	/** Whether the primary Rovo OAuth is connected (gates the banner). */
	isConnected: boolean;
	/** Whether the current user can change workspace OAuth setup. */
	isAdmin?: boolean;
}

export function AtlassianCloudAttachmentBanner({
	config,
	isConnected,
	isAdmin = false,
}: AtlassianCloudAttachmentBannerProps) {
	const queryClient = useQueryClient();
	const isAtlassian = isAtlassianRovoConfig(config);

	const { data: status, isLoading } = useQuery({
		queryKey: ["atlassian-cloud-status", config.id],
		queryFn: () =>
			orpcClient.mcp.atlassianCloud.status({ configId: config.id }),
		// Only query for connected Atlassian configs — no point otherwise.
		enabled: isAtlassian && isConnected,
		staleTime: 30_000,
	});

	const connectMutation = useMutation({
		mutationFn: async () => {
			const redirectUri = `${window.location.origin}/api/mcp/atlassian-cloud/callback`;
			const result = await orpcClient.mcp.atlassianCloud.start({
				configId: config.id,
				redirectUri,
			});
			return result.authorizationUrl;
		},
		onSuccess: (authorizationUrl) => {
			const width = 600;
			const height = 700;
			const left = window.screenX + (window.outerWidth - width) / 2;
			const top = window.screenY + (window.outerHeight - height) / 2;
			const popup = window.open(
				authorizationUrl,
				"atlassian_cloud_oauth_popup",
				`width=${width},height=${height},left=${left},top=${top},toolbar=no,menubar=no,location=no,status=no`,
			);
			if (!popup) {
				toast.error("Popup blocked", {
					description:
						"Please allow popups for this site to connect Atlassian Cloud.",
				});
				return;
			}
			const handleMessage = (event: MessageEvent) => {
				if (event.origin !== window.location.origin) {
					return;
				}
				if (event.data?.type === "atlassian_cloud_oauth_success") {
					toast.success("Image attachments enabled", {
						description:
							"Jira cards will now render Fabric images inline.",
					});
					queryClient.invalidateQueries({
						queryKey: ["atlassian-cloud-status", config.id],
					});
					window.removeEventListener("message", handleMessage);
				} else if (event.data?.type === "atlassian_cloud_oauth_error") {
					toast.error("Atlassian Cloud connection failed", {
						description: event.data.message || "Please try again.",
					});
					window.removeEventListener("message", handleMessage);
				}
			};
			window.addEventListener("message", handleMessage);
		},
		onError: (err) => {
			toast.error("Could not start Atlassian Cloud connection", {
				description:
					err instanceof Error ? err.message : "Unknown error",
			});
		},
	});

	// Render nothing unless this is a connected Atlassian config with a
	// resolved status.
	if (!isAtlassian || !isConnected || isLoading || !status) {
		return null;
	}

	// State A — fully connected. Subtle confirmation, no call to action.
	if (status.connected) {
		return (
			<div className="mt-2 flex items-center gap-2 rounded-md border border-secondary/30 bg-secondary/5 px-3 py-2 text-xs text-muted-foreground">
				<CheckCircle2Icon className="size-3.5 shrink-0 text-secondary" />
				<span>
					Image attachments enabled
					{status.siteUrl ? (
						<>
							{" "}
							on{" "}
							<span className="font-medium text-foreground">
								{status.siteUrl.replace(/^https?:\/\//, "")}
							</span>
						</>
					) : null}
					. Fabric screenshots render inline on Jira cards.
				</span>
			</div>
		);
	}

	// State B — env configured but no Cloud token. Actionable connect.
	if (status.envConfigured) {
		return (
			<div className="mt-2 rounded-md border border-highlight/40 bg-highlight/5 px-3 py-2.5">
				<div className="flex items-start gap-2">
					<ImageIcon className="mt-0.5 size-4 shrink-0 text-highlight" />
					<div className="min-w-0 flex-1">
						<p className="text-sm font-medium">
							Enable image attachments on Jira cards
						</p>
						<p className="mt-0.5 text-xs text-muted-foreground">
							Authorize one extra Atlassian permission so Fabric
							can upload screenshots as real attachments. Without
							it, large images are skipped on Jira push.
						</p>
						<Button
							size="sm"
							className="mt-2"
							disabled={connectMutation.isPending}
							onClick={() => connectMutation.mutate()}
						>
							{connectMutation.isPending ? (
								<>
									<LoaderIcon className="size-3.5 animate-spin" />
									Opening…
								</>
							) : (
								"Connect image attachments"
							)}
						</Button>
					</div>
				</div>
			</div>
		);
	}

	// State C — env NOT configured. Admin-only hint; hide for members who
	// can't change workspace OAuth setup.
	if (!isAdmin) {
		return null;
	}
	return (
		<div className="mt-2 rounded-md border border-border bg-muted/40 px-3 py-2.5">
			<div className="flex items-start gap-2">
				<InfoIcon className="mt-0.5 size-4 shrink-0 text-muted-foreground" />
				<div className="min-w-0 flex-1">
					<p className="text-sm font-medium">
						Real-screenshot uploads need a one-time setup
					</p>
					<p className="mt-0.5 text-xs text-muted-foreground">
						Jira renders Fabric images inline once an admin
						registers an Atlassian OAuth app and adds its
						credentials to this environment. Until then, large
						images are skipped on Jira push (small ones still
						embed).
					</p>
					<a
						href={SETUP_GUIDE_URL}
						target="_blank"
						rel="noreferrer"
						className="mt-2 inline-flex items-center gap-1 text-xs font-medium text-primary hover:underline"
					>
						View setup guide
						<ExternalLinkIcon className="size-3" />
					</a>
				</div>
			</div>
		</div>
	);
}
