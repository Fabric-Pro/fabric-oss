"use client";

import { orpcClient } from "@shared/lib/orpc-client";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { Button } from "@ui/components/button";
import { Label } from "@ui/components/label";
import {
	Select,
	SelectContent,
	SelectItem,
	SelectTrigger,
	SelectValue,
} from "@ui/components/select";
import { CheckCircle2Icon, Link2Icon, Loader2Icon } from "lucide-react";
import Link from "next/link";
import { useCallback, useEffect, useMemo, useRef } from "react";
import { toast } from "sonner";
import {
	getPmToolBrandIcon,
	PmToolBrandIcon,
} from "./stories/pm-sync/pm-tool-brand-icon";

const NONE_VALUE = "__none__";

export interface PmToolOption {
	key: string;
	displayName: string;
	iconKey: string;
	isDefault: boolean;
	isConfigured: boolean;
	mcpServerId: string;
	mcpConfigId: string | null;
	configDisplayName: string | null;
	transport: "mcp" | "rest" | null;
	/**
	 * True iff this row was synthesized for the "user has GitLab in
	 * personal scope but the wizard is in an org" case. Drives the
	 * distinct chip + CTA below.
	 */
	connectedInPersonalScope?: boolean;
}

interface PMToolSelectChange {
	mcpConfigId: string | null;
	mcpServerId: string | null;
	isDefault: boolean;
	isConfigured: boolean;
	transport: "mcp" | "rest" | null;
}

interface PMToolSelectProps {
	organizationId: string | null;
	/**
	 * Display name of the current organization. Used by the GitLab
	 * "Connect for {orgName}" CTA when surfaced. Pass `null` when in
	 * personal context (the CTA won't appear in that case).
	 */
	organizationName?: string | null;
	selectedMcpConfigId: string | null;
	selectedMcpServerId: string | null;
	onChange: (next: PMToolSelectChange) => void;
	mcpSettingsUrl: string;
	disabled?: boolean;
	label?: string;
	/**
	 * Fires when the internally-resolved selected option changes (incl. the
	 * first time the option list loads and matches the persisted ids). Lets
	 * the parent detect a GitLab REST selection on initial load — the parent
	 * has no server-key signal of its own.
	 */
	onResolvedSelection?: (info: {
		transport: "mcp" | "rest" | null;
		mcpServerId: string | null;
		mcpConfigId: string | null;
	}) => void;
}

function optionValue(option: PmToolOption): string {
	return option.mcpConfigId ?? `default:${option.key}`;
}

export function PMToolSelect({
	organizationId,
	organizationName,
	selectedMcpConfigId,
	selectedMcpServerId,
	onChange,
	mcpSettingsUrl,
	disabled = false,
	label = "Project Management Tool",
	onResolvedSelection,
}: PMToolSelectProps) {
	const queryClient = useQueryClient();
	const { data, isLoading, error } = useQuery({
		queryKey: ["mcp.availablePmTools", organizationId],
		queryFn: () => orpcClient.mcp.availablePmTools.list({ organizationId }),
		staleTime: 30_000,
	});

	useEffect(() => {
		const handleMessage = (event: MessageEvent) => {
			if (event.origin !== window.location.origin) {
				return;
			}
			if (event.data?.type === "gitlab_oauth_success") {
				queryClient.invalidateQueries({
					queryKey: ["mcp.availablePmTools"],
				});
			}
		};
		window.addEventListener("message", handleMessage);
		return () => window.removeEventListener("message", handleMessage);
	}, [queryClient]);

	const options: PmToolOption[] = useMemo(() => data ?? [], [data]);

	const selectedOption = useMemo(() => {
		if (selectedMcpConfigId) {
			return (
				options.find((o) => o.mcpConfigId === selectedMcpConfigId) ??
				null
			);
		}
		if (selectedMcpServerId) {
			// Server-only path: a server is chosen but no MCPConfig is
			// pinned. Match any option with no mcpConfigId (default stubs
			// AND the synthesized GitLab REST entry). Filtering on
			// `mcpConfigId === null` instead of `!isConfigured` is what
			// prevents accidentally pre-selecting another tenant's
			// configured row with the same mcpServerId — every such row
			// has a non-null mcpConfigId.
			return (
				options.find(
					(o) =>
						o.mcpServerId === selectedMcpServerId &&
						o.mcpConfigId === null,
				) ?? null
			);
		}
		return null;
	}, [options, selectedMcpConfigId, selectedMcpServerId]);

	const selectedValue: string = selectedOption
		? optionValue(selectedOption)
		: NONE_VALUE;

	const handleConnectForOrg = useCallback(async () => {
		if (!organizationId) {
			return;
		}
		try {
			const callbackUrl = `${window.location.origin}/api/integrations/gitlab/oauth/callback`;
			const returnUrl =
				window.location.pathname +
				window.location.search +
				window.location.hash;

			const result = await orpcClient.integrations.gitlab.start({
				redirectUri: callbackUrl,
				returnUrl,
				organizationId,
			});

			const width = 600;
			const height = 700;
			const left = window.screenX + (window.outerWidth - width) / 2;
			const top = window.screenY + (window.outerHeight - height) / 2;
			window.open(
				result.authorizationUrl,
				"gitlab-oauth",
				`width=${width},height=${height},left=${left},top=${top}`,
			);
		} catch (err) {
			toast.error(
				err instanceof Error
					? err.message
					: "Failed to start GitLab OAuth",
			);
		}
	}, [organizationId]);

	// Notify the parent of the resolved selection's transport whenever it
	// actually changes (guarded by a ref to avoid an effect loop). This is how
	// the parent learns a persisted selection is GitLab REST on initial load.
	const lastNotifiedRef = useRef<string | null>(null);
	useEffect(() => {
		if (!onResolvedSelection) {
			return;
		}
		const signature = selectedOption
			? `${selectedOption.transport}|${selectedOption.mcpServerId}|${selectedOption.mcpConfigId}`
			: "none";
		if (signature === lastNotifiedRef.current) {
			return;
		}
		lastNotifiedRef.current = signature;
		onResolvedSelection({
			transport: selectedOption?.transport ?? null,
			mcpServerId: selectedOption?.mcpServerId ?? null,
			mcpConfigId: selectedOption?.mcpConfigId ?? null,
		});
	}, [selectedOption, onResolvedSelection]);

	const helperText =
		selectedOption &&
		!selectedOption.isConfigured &&
		selectedOption.key !== "gitlab-official"
			? `You'll configure ${selectedOption.displayName} after setup.`
			: null;

	const showPersonalScopeCta =
		selectedOption?.key === "gitlab-official" &&
		selectedOption.connectedInPersonalScope === true;

	return (
		<div className="space-y-2">
			<Label htmlFor="pm-tool-select-trigger">{label}</Label>
			<Select
				value={selectedValue}
				disabled={disabled || isLoading}
				onValueChange={(value) => {
					if (value === NONE_VALUE) {
						onChange({
							mcpConfigId: null,
							mcpServerId: null,
							isDefault: false,
							isConfigured: false,
							transport: null,
						});
						return;
					}
					const next = options.find((o) => optionValue(o) === value);
					if (!next) {
						return;
					}
					onChange({
						mcpConfigId: next.mcpConfigId,
						mcpServerId: next.mcpServerId,
						isDefault: next.isDefault,
						isConfigured: next.isConfigured,
						transport: next.transport,
					});
				}}
			>
				<SelectTrigger
					id="pm-tool-select-trigger"
					aria-describedby={
						helperText ? "pm-tool-select-help" : undefined
					}
				>
					<SelectValue placeholder="Select a tool…" />
				</SelectTrigger>
				<SelectContent>
					<SelectItem value={NONE_VALUE}>None</SelectItem>
					{isLoading ? (
						<div className="flex items-center gap-2 px-2 py-1.5 text-sm text-muted-foreground">
							<Loader2Icon className="h-3.5 w-3.5 animate-spin" />
							Loading tools…
						</div>
					) : options.length === 0 ? (
						<div className="px-2 py-1.5 text-sm text-muted-foreground">
							No PM tools available.
						</div>
					) : (
						options.map((option) => (
							<SelectItem
								key={optionValue(option)}
								value={optionValue(option)}
							>
								<PmToolOptionRow option={option} />
							</SelectItem>
						))
					)}
				</SelectContent>
			</Select>
			{error ? (
				<p className="text-sm text-destructive">
					Failed to load PM tools.
				</p>
			) : null}
			{helperText ? (
				<p
					id="pm-tool-select-help"
					className="text-sm text-muted-foreground"
				>
					{helperText}{" "}
					<Link
						href={mcpSettingsUrl}
						target="_blank"
						rel="noopener noreferrer"
						className="text-primary hover:underline"
					>
						Configure now
					</Link>
				</p>
			) : null}
			{showPersonalScopeCta ? (
				<div className="space-y-2 text-sm">
					<p className="text-muted-foreground">
						GitLab is connected on your personal account.
						{organizationName ? (
							<>
								{" "}
								Connect again for{" "}
								<span className="font-medium text-foreground">
									{organizationName}
								</span>{" "}
								to use it as the PM tool here.
							</>
						) : (
							" Connect again for this organization to use it as the PM tool here."
						)}
					</p>
					<Button
						type="button"
						variant="secondary"
						size="sm"
						onClick={handleConnectForOrg}
					>
						Connect for {organizationName ?? "this organization"}
					</Button>
				</div>
			) : selectedOption?.key === "gitlab-official" &&
				!selectedOption.isConfigured ? (
				<p className="text-sm text-muted-foreground">
					GitLab isn't connected yet.{" "}
					<Link
						href={mcpSettingsUrl}
						target="_blank"
						rel="noopener noreferrer"
						className="text-primary hover:underline"
					>
						Connect in Settings → Integrations
					</Link>{" "}
					to start syncing.
				</p>
			) : null}
		</div>
	);
}

function PmToolOptionRow({ option }: { option: PmToolOption }) {
	const hasBrandIcon = Boolean(getPmToolBrandIcon(option.iconKey));
	const isPersonalScope = option.connectedInPersonalScope === true;
	return (
		<div className="flex w-full items-center gap-2">
			<span aria-hidden="true" className="flex h-4 w-4 items-center">
				{hasBrandIcon ? (
					<PmToolBrandIcon
						pmToolType={option.iconKey}
						className="h-4 w-4"
					/>
				) : (
					<Link2Icon className="h-4 w-4 text-muted-foreground" />
				)}
			</span>
			<span className="flex-1 truncate">
				{option.configDisplayName &&
				option.configDisplayName !== option.displayName
					? `${option.displayName} · ${option.configDisplayName}`
					: option.displayName}
			</span>
			<span
				aria-hidden="true"
				className="ml-2 inline-flex items-center gap-1 rounded-md bg-muted px-1.5 py-0.5 text-[10px] uppercase tracking-[0.06em] text-muted-foreground"
			>
				{isPersonalScope ? (
					"Connected in personal"
				) : option.isConfigured ? (
					<>
						<CheckCircle2Icon className="h-3 w-3 text-success" />
						Configured
					</>
				) : (
					"Not configured"
				)}
			</span>
			{option.transport === "rest" ? (
				<span
					aria-hidden="true"
					className="inline-flex items-center rounded-md bg-muted px-1.5 py-0.5 text-[10px] uppercase tracking-[0.06em] text-muted-foreground"
				>
					REST
				</span>
			) : null}
		</div>
	);
}
