"use client";

/**
 * What a GitHub token must allow, shown when the server refused to save one
 * (`checkGitHubTokenForSave` in the API). Every form that saves a pasted
 * GitHub token shows it, so the rule reads the same everywhere:
 *
 * - a classic token: each required scope with ✓ or ✗, from GitHub's answer;
 * - a fine-grained token: the repository permissions Fabric needs, which
 *   GitHub does not report, and a confirmation the person must tick before
 *   the token is saved.
 */

import { Checkbox } from "@ui/components/checkbox";
import { Label } from "@ui/components/label";
import { CheckIcon, XIcon } from "lucide-react";
import { useId } from "react";

export type GitHubTokenRefusal =
	| {
			reason: "GITHUB_TOKEN_MISSING_SCOPES";
			tokenType: "classic";
			required: string[];
			missing: string[];
	  }
	| {
			reason: "GITHUB_TOKEN_CONFIRM_PERMISSIONS";
			tokenType: "fine-grained";
			permissions: { name: string; access: "read" | "write" }[];
			canListRepositories: boolean | null;
	  };

function isStringArray(value: unknown): value is string[] {
	return (
		Array.isArray(value) && value.every((item) => typeof item === "string")
	);
}

/** The structured refusal in an oRPC error's `data`, if it is one. */
export function readGitHubTokenRefusal(
	error: unknown,
): GitHubTokenRefusal | null {
	const data = (error as { data?: unknown } | null | undefined)?.data as
		| Record<string, unknown>
		| undefined;
	if (!data || typeof data !== "object") {
		return null;
	}
	if (
		data.reason === "GITHUB_TOKEN_MISSING_SCOPES" &&
		isStringArray(data.required) &&
		isStringArray(data.missing)
	) {
		return {
			reason: "GITHUB_TOKEN_MISSING_SCOPES",
			tokenType: "classic",
			required: data.required,
			missing: data.missing,
		};
	}
	if (
		data.reason === "GITHUB_TOKEN_CONFIRM_PERMISSIONS" &&
		Array.isArray(data.permissions)
	) {
		const permissions = data.permissions.flatMap(
			(p: unknown): { name: string; access: "read" | "write" }[] => {
				const item = p as { name?: unknown; access?: unknown };
				return typeof item.name === "string" &&
					(item.access === "read" || item.access === "write")
					? [{ name: item.name, access: item.access }]
					: [];
			},
		);
		return {
			reason: "GITHUB_TOKEN_CONFIRM_PERMISSIONS",
			tokenType: "fine-grained",
			permissions,
			canListRepositories:
				typeof data.canListRepositories === "boolean"
					? data.canListRepositories
					: null,
		};
	}
	return null;
}

/** True while a fine-grained token waits for its confirmation. */
export function needsGitHubTokenConfirmation(
	refusal: GitHubTokenRefusal | null,
	confirmed: boolean,
): boolean {
	return refusal?.reason === "GITHUB_TOKEN_CONFIRM_PERMISSIONS" && !confirmed;
}

const ACCESS_LABEL = { read: "Read", write: "Read and write" } as const;

export function GitHubTokenChecklist({
	refusal,
	confirmed,
	onConfirmedChange,
}: {
	refusal: GitHubTokenRefusal;
	confirmed: boolean;
	onConfirmedChange: (confirmed: boolean) => void;
}) {
	const id = useId();

	if (refusal.reason === "GITHUB_TOKEN_MISSING_SCOPES") {
		const missing = new Set(refusal.missing);
		return (
			<div
				className="space-y-2 rounded-md border border-destructive/40 p-3 text-sm"
				role="alert"
			>
				<p className="font-medium">
					This token is missing {refusal.missing.join(", ")}
				</p>
				<p className="text-muted-foreground text-xs">
					Edit it on GitHub (Settings → Developer settings → Personal
					access tokens), add the scopes marked ✗, then save again.
				</p>
				<ul className="space-y-1" aria-label="Required scopes">
					{refusal.required.map((scope) => {
						const absent = missing.has(scope);
						return (
							<li key={scope} className="flex items-center gap-2">
								{absent ? (
									<XIcon
										className="size-4 text-destructive"
										aria-hidden="true"
									/>
								) : (
									<CheckIcon
										className="size-4 text-success"
										aria-hidden="true"
									/>
								)}
								<code className="text-xs">{scope}</code>
								<span className="sr-only">
									{absent ? "missing" : "granted"}
								</span>
							</li>
						);
					})}
				</ul>
			</div>
		);
	}

	return (
		<div className="space-y-2 rounded-md border p-3 text-sm">
			<p className="font-medium">
				Fine-grained token: these can&apos;t be checked before use —
				make sure the token has these
			</p>
			<ul className="space-y-1" aria-label="Repository permissions">
				{refusal.permissions.map((permission) => (
					<li key={permission.name} className="flex gap-2">
						<span>{permission.name}</span>
						<span className="text-muted-foreground">
							{ACCESS_LABEL[permission.access]}
						</span>
					</li>
				))}
			</ul>
			{refusal.canListRepositories === false ? (
				<p className="flex items-center gap-2 text-destructive text-xs">
					<XIcon className="size-4" aria-hidden="true" />
					GitHub would not list repositories with this token. Check
					its repository access.
				</p>
			) : refusal.canListRepositories === true ? (
				<p className="flex items-center gap-2 text-muted-foreground text-xs">
					<CheckIcon
						className="size-4 text-success"
						aria-hidden="true"
					/>
					The token can list repositories.
				</p>
			) : null}
			<div className="flex items-center gap-2">
				<Checkbox
					id={`${id}-confirm`}
					checked={confirmed}
					onCheckedChange={(value) =>
						onConfirmedChange(value === true)
					}
				/>
				<Label htmlFor={`${id}-confirm`} className="font-normal">
					I&apos;ve granted these
				</Label>
			</div>
		</div>
	);
}
