"use client";

import { useActiveOrganization } from "@saas/organizations/hooks/use-active-organization";
import { orpcClient } from "@shared/lib/orpc-client";
import { useMutation } from "@tanstack/react-query";
import { Button } from "@ui/components/button";
import { Checkbox } from "@ui/components/checkbox";
import {
	Dialog,
	DialogContent,
	DialogDescription,
	DialogFooter,
	DialogHeader,
	DialogTitle,
	DialogTrigger,
} from "@ui/components/dialog";
import { Input } from "@ui/components/input";
import { Label } from "@ui/components/label";
import {
	Select,
	SelectContent,
	SelectItem,
	SelectTrigger,
	SelectValue,
} from "@ui/components/select";
import { PlusIcon } from "lucide-react";
import { type FormEvent, useId, useState } from "react";
import { toast } from "sonner";
import {
	CREDENTIAL_PROVIDER_LABELS,
	type CredentialProviderKey,
} from "../lib/labels";

type ManualKind = "PAT" | "API_KEY" | "BASIC";

const MANUAL_KIND_LABELS: Record<ManualKind, string> = {
	PAT: "Personal access token",
	API_KEY: "API key",
	BASIC: "User name and token",
};

/** Providers whose instance varies, so the URL is asked for up front. */
const ASK_ORIGIN = new Set<CredentialProviderKey>([
	"GITLAB",
	"AZURE_DEVOPS",
	"ATLASSIAN",
	"AZURE_OPENAI",
	"CUSTOM",
]);

/**
 * Paste-in credential form. The secret goes straight to the server, which
 * encrypts it; it is never echoed back or kept in the query cache.
 */
export function AddCredentialDialog({
	organizationId,
	onCreated,
	provider: fixedProvider,
	triggerLabel = "Add credential",
	triggerVariant,
}: {
	organizationId: string;
	/** Gets the saved credential, so a picker can select it at once. */
	onCreated: (credential: { id: string; label: string }) => void;
	/** Fixes the provider: the dialog is opened for one connection. */
	provider?: CredentialProviderKey;
	triggerLabel?: string;
	triggerVariant?: "outline" | "secondary" | "ghost";
}) {
	const { isOrganizationAdmin } = useActiveOrganization();
	const id = useId();
	const [open, setOpen] = useState(false);
	const [provider, setProvider] = useState<CredentialProviderKey>(
		fixedProvider ?? "GITHUB",
	);
	const [kind, setKind] = useState<ManualKind>("PAT");
	const [label, setLabel] = useState("");
	const [origin, setOrigin] = useState("");
	const [username, setUsername] = useState("");
	const [secret, setSecret] = useState("");
	const [owner, setOwner] = useState<"me" | "organization">("me");
	const [share, setShare] = useState(false);

	const reset = () => {
		setLabel("");
		setOrigin("");
		setUsername("");
		setSecret("");
		setShare(false);
		setOwner("me");
	};

	const create = useMutation({
		mutationFn: () =>
			orpcClient.credentialManager.create({
				organizationId,
				owner,
				shareWithOrganization: share,
				provider,
				kind,
				label: label.trim(),
				origin: origin.trim() || undefined,
				username: kind === "BASIC" ? username.trim() : undefined,
				secret,
			}),
		onSuccess: (result) => {
			toast.success("Credential saved");
			reset();
			setOpen(false);
			onCreated({
				id: result.credential.id,
				label: result.credential.label,
			});
		},
		onError: (error) =>
			toast.error("Could not save the credential", {
				description: error instanceof Error ? error.message : undefined,
			}),
	});

	const needsOrigin = ASK_ORIGIN.has(provider);
	const canSubmit =
		label.trim().length > 0 &&
		secret.trim().length > 0 &&
		(kind !== "BASIC" || username.trim().length > 0) &&
		(provider !== "CUSTOM" || origin.trim().length > 0);

	const submit = (event: FormEvent) => {
		event.preventDefault();
		if (canSubmit && !create.isPending) {
			create.mutate();
		}
	};

	return (
		<Dialog
			open={open}
			onOpenChange={(next) => {
				setOpen(next);
				if (!next) {
					reset();
				}
			}}
		>
			<DialogTrigger asChild>
				<Button type="button" size="sm" variant={triggerVariant}>
					<PlusIcon className="size-4" aria-hidden="true" />
					{triggerLabel}
				</Button>
			</DialogTrigger>
			<DialogContent>
				<form onSubmit={submit} className="space-y-4">
					<DialogHeader>
						<DialogTitle>Add a credential</DialogTitle>
						<DialogDescription>
							Paste a token or key once; pick it later wherever
							Fabric connects. Sign-ins and app installations are
							added from each provider&apos;s Connect button.
						</DialogDescription>
					</DialogHeader>

					<div className="grid gap-3 sm:grid-cols-2">
						<div className="space-y-1.5">
							<Label htmlFor={`${id}-provider`}>Provider</Label>
							<Select
								value={provider}
								disabled={fixedProvider !== undefined}
								onValueChange={(v) =>
									setProvider(v as CredentialProviderKey)
								}
							>
								<SelectTrigger id={`${id}-provider`}>
									<SelectValue />
								</SelectTrigger>
								<SelectContent>
									{Object.entries(
										CREDENTIAL_PROVIDER_LABELS,
									).map(([value, text]) => (
										<SelectItem key={value} value={value}>
											{text}
										</SelectItem>
									))}
								</SelectContent>
							</Select>
						</div>
						<div className="space-y-1.5">
							<Label htmlFor={`${id}-kind`}>Type</Label>
							<Select
								value={kind}
								onValueChange={(v) => setKind(v as ManualKind)}
							>
								<SelectTrigger id={`${id}-kind`}>
									<SelectValue />
								</SelectTrigger>
								<SelectContent>
									{Object.entries(MANUAL_KIND_LABELS).map(
										([value, text]) => (
											<SelectItem
												key={value}
												value={value}
											>
												{text}
											</SelectItem>
										),
									)}
								</SelectContent>
							</Select>
						</div>
					</div>

					<div className="space-y-1.5">
						<Label htmlFor={`${id}-label`}>Name</Label>
						<Input
							id={`${id}-label`}
							value={label}
							onChange={(e) => setLabel(e.target.value)}
							placeholder="e.g. GitHub — read-only CI token"
							maxLength={120}
							required
						/>
					</div>

					{needsOrigin ? (
						<div className="space-y-1.5">
							<Label htmlFor={`${id}-origin`}>
								Instance URL
								{provider === "CUSTOM" ? "" : " (optional)"}
							</Label>
							<Input
								id={`${id}-origin`}
								type="url"
								inputMode="url"
								value={origin}
								onChange={(e) => setOrigin(e.target.value)}
								placeholder="https://gitlab.example.com"
								required={provider === "CUSTOM"}
							/>
						</div>
					) : null}

					{kind === "BASIC" ? (
						<div className="space-y-1.5">
							<Label htmlFor={`${id}-username`}>
								User name or email
							</Label>
							<Input
								id={`${id}-username`}
								value={username}
								onChange={(e) => setUsername(e.target.value)}
								autoComplete="off"
								required
							/>
						</div>
					) : null}

					<div className="space-y-1.5">
						<Label htmlFor={`${id}-secret`}>
							{kind === "API_KEY" ? "Key" : "Token"}
						</Label>
						<Input
							id={`${id}-secret`}
							type="password"
							value={secret}
							onChange={(e) => setSecret(e.target.value)}
							autoComplete="off"
							spellCheck={false}
							required
						/>
					</div>

					{isOrganizationAdmin ? (
						<div className="space-y-1.5">
							<Label htmlFor={`${id}-owner`}>Owner</Label>
							<Select
								value={owner}
								onValueChange={(v) =>
									setOwner(v as "me" | "organization")
								}
							>
								<SelectTrigger id={`${id}-owner`}>
									<SelectValue />
								</SelectTrigger>
								<SelectContent>
									<SelectItem value="me">Me</SelectItem>
									<SelectItem value="organization">
										The organization (every member may use
										it)
									</SelectItem>
								</SelectContent>
							</Select>
						</div>
					) : null}

					{owner === "me" ? (
						<div className="flex items-center gap-2">
							<Checkbox
								id={`${id}-share`}
								checked={share}
								onCheckedChange={(v) => setShare(v === true)}
							/>
							<Label
								htmlFor={`${id}-share`}
								className="font-normal"
							>
								Let other members of the organization use it
							</Label>
						</div>
					) : null}

					<DialogFooter>
						<Button
							type="submit"
							disabled={!canSubmit}
							loading={create.isPending}
						>
							Save
						</Button>
					</DialogFooter>
				</form>
			</DialogContent>
		</Dialog>
	);
}
