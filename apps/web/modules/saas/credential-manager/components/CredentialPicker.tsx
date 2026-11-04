"use client";

import { orpc } from "@shared/lib/orpc-query-utils";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { Label } from "@ui/components/label";
import {
	Select,
	SelectContent,
	SelectItem,
	SelectTrigger,
	SelectValue,
} from "@ui/components/select";
import { useId } from "react";
import type { CredentialProviderKey } from "../lib/labels";
import { AddCredentialDialog } from "./AddCredentialDialog";

/** The "no saved credential" choice: the caller's own connection. */
const CONNECTION = "__connection__";

const KIND_LABELS: Record<string, string> = {
	PAT: "token",
	API_KEY: "API key",
	OAUTH: "sign-in",
	GITHUB_APP_USER: "sign-in",
	APP_INSTALLATION: "app",
	BASIC: "user and token",
};

/**
 * Picks the credential a connection runs with (ADR-026): one saved in the
 * credential manager that the person may use, or none — their own provider
 * connection. "Add" saves a new credential there and selects it.
 */
export function CredentialPicker({
	organizationId,
	provider,
	value,
	onChange,
	kinds,
	connectionLabel,
	label = "Credential",
	disabled,
}: {
	organizationId: string;
	provider: CredentialProviderKey;
	/** The chosen credential id; null for the person's own connection. */
	value: string | null;
	onChange: (credentialId: string | null) => void;
	/** Kinds the connection can run with; others are not offered. */
	kinds?: readonly string[];
	connectionLabel: string;
	label?: string;
	disabled?: boolean;
}) {
	const id = useId();
	const queryClient = useQueryClient();
	const listOptions = orpc.credentialManager.list.queryOptions({
		input: { organizationId, provider },
	});
	const { data, isLoading } = useQuery(listOptions);
	const credentials = (data?.credentials ?? []).filter(
		(c) => c.status !== "REVOKED" && (!kinds || kinds.includes(c.kind)),
	);
	const selected = credentials.find((c) => c.id === value);
	const describe = (c: (typeof credentials)[number]) =>
		`${c.label} · ${KIND_LABELS[c.kind] ?? c.kind}${
			c.externalAccountLogin ? ` · ${c.externalAccountLogin}` : ""
		}${
			c.ownedByMe
				? ""
				: c.owner === "organization"
					? " · organization"
					: " · shared"
		}`;

	return (
		<div className="space-y-1.5">
			<Label htmlFor={`${id}-credential`}>{label}</Label>
			<div className="flex flex-wrap items-center gap-2">
				<Select
					value={value ?? CONNECTION}
					disabled={disabled || isLoading}
					onValueChange={(next) =>
						onChange(next === CONNECTION ? null : next)
					}
				>
					<SelectTrigger
						id={`${id}-credential`}
						className="min-w-64 flex-1"
					>
						<SelectValue>
							{value === null
								? connectionLabel
								: selected
									? describe(selected)
									: "A credential you can no longer use"}
						</SelectValue>
					</SelectTrigger>
					<SelectContent>
						<SelectItem value={CONNECTION}>
							{connectionLabel}
						</SelectItem>
						{credentials.map((c) => (
							<SelectItem key={c.id} value={c.id}>
								{describe(c)}
							</SelectItem>
						))}
					</SelectContent>
				</Select>
				<AddCredentialDialog
					organizationId={organizationId}
					provider={provider}
					triggerLabel="New"
					triggerVariant="outline"
					onCreated={(credential) => {
						queryClient.invalidateQueries({
							queryKey: listOptions.queryKey,
						});
						onChange(credential.id);
					}}
				/>
			</div>
		</div>
	);
}
