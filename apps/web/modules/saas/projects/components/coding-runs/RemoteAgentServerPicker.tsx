"use client";

import { orpcClient } from "@shared/lib/orpc-client";
import { useMutation, useQueryClient } from "@tanstack/react-query";
import { Button } from "@ui/components/button";
import { Input } from "@ui/components/input";
import { Label } from "@ui/components/label";
import { useTranslations } from "next-intl";
import { useId, useState } from "react";

export interface RemoteAgentServerOption {
	id: string;
	name: string;
	scope: string;
	url: string;
	ownedByCaller: boolean;
}

export function RemoteAgentServerPicker({
	projectId,
	organizationId,
	servers,
	canShare,
	value,
	onChange,
}: {
	projectId: string;
	organizationId?: string | null;
	servers: RemoteAgentServerOption[];
	canShare: boolean;
	value: string;
	onChange: (id: string) => void;
}) {
	const t = useTranslations("projects.remoteAgents");
	const id = useId();
	const queryClient = useQueryClient();
	const [name, setName] = useState("");
	const [url, setUrl] = useState("");
	const [secret, setSecret] = useState("");
	const [scope, setScope] = useState<"PRIVATE" | "TEAM">("PRIVATE");
	const selected = servers.find((server) => server.id === value);
	const connect = useMutation({
		mutationFn: () =>
			orpcClient.codingRuns.remoteServers.connect({
				projectId,
				organizationId,
				name,
				url,
				secret,
				scope,
			}),
		onSuccess: async (server) => {
			setSecret("");
			setName("");
			setUrl("");
			await queryClient.invalidateQueries({
				queryKey: ["remoteAgentServers", projectId],
			});
			onChange(server.id);
		},
	});
	const disconnect = useMutation({
		mutationFn: () =>
			orpcClient.codingRuns.remoteServers.disconnect({
				projectId,
				organizationId,
				id: value,
			}),
		onSuccess: async () => {
			onChange("");
			await queryClient.invalidateQueries({
				queryKey: ["remoteAgentServers", projectId],
			});
		},
	});
	return (
		<section
			className="space-y-3 border-b border-border pb-4"
			aria-label={t("title")}
		>
			<Label htmlFor={`${id}-server`}>{t("title")}</Label>
			<select
				id={`${id}-server`}
				className="h-10 w-full rounded-md border border-input bg-background px-3 text-sm"
				value={value}
				onChange={(event) => onChange(event.target.value)}
			>
				<option value="">{t("choose")}</option>
				<optgroup label={t("mine")}>
					{servers
						.filter((server) => server.scope === "PRIVATE")
						.map((server) => (
							<option key={server.id} value={server.id}>
								{server.name}
							</option>
						))}
				</optgroup>
				<optgroup label={t("team")}>
					{servers
						.filter((server) => server.scope === "TEAM")
						.map((server) => (
							<option key={server.id} value={server.id}>
								{server.name}
							</option>
						))}
				</optgroup>
			</select>
			<p className="text-xs leading-5 text-muted-foreground">
				{selected
					? t(selected.scope === "TEAM" ? "teamHelp" : "privateHelp")
					: t("emptyHelp")}
			</p>
			{selected &&
				(selected.scope === "PRIVATE"
					? selected.ownedByCaller
					: canShare) && (
					<Button
						type="button"
						variant="ghost"
						size="sm"
						loading={disconnect.isPending}
						onClick={() => disconnect.mutate()}
					>
						{t("disconnect")}
					</Button>
				)}
			<details className="space-y-3">
				<summary className="cursor-pointer text-sm underline underline-offset-4">
					{t("connect")}
				</summary>
				<p className="text-xs leading-5 text-muted-foreground">
					{t("connectionHelp")}
				</p>
				<div className="space-y-2">
					<Label htmlFor={`${id}-name`}>{t("name")}</Label>
					<Input
						id={`${id}-name`}
						value={name}
						onChange={(event) => setName(event.target.value)}
						maxLength={80}
					/>
				</div>
				<div className="space-y-2">
					<Label htmlFor={`${id}-url`}>{t("url")}</Label>
					<Input
						id={`${id}-url`}
						type="url"
						placeholder="https://agents.example.com"
						value={url}
						onChange={(event) => setUrl(event.target.value)}
					/>
				</div>
				<div className="space-y-2">
					<Label htmlFor={`${id}-secret`}>{t("secret")}</Label>
					<Input
						id={`${id}-secret`}
						type="password"
						autoComplete="new-password"
						value={secret}
						onChange={(event) => setSecret(event.target.value)}
					/>
				</div>
				<div className="space-y-2">
					<Label htmlFor={`${id}-scope`}>{t("visibility")}</Label>
					<select
						id={`${id}-scope`}
						className="h-10 w-full rounded-md border border-input bg-background px-3 text-sm"
						value={scope}
						onChange={(event) =>
							setScope(event.target.value as "PRIVATE" | "TEAM")
						}
					>
						<option value="PRIVATE">{t("mine")}</option>
						{canShare && <option value="TEAM">{t("team")}</option>}
					</select>
				</div>
				<Button
					type="button"
					disabled={!name.trim() || !url || secret.length < 32}
					loading={connect.isPending}
					onClick={() => connect.mutate()}
				>
					{t("verify")}
				</Button>
			</details>
			{(connect.error || disconnect.error) && (
				<p role="alert" className="text-sm text-destructive">
					{(connect.error || disconnect.error)?.message}
				</p>
			)}
		</section>
	);
}
