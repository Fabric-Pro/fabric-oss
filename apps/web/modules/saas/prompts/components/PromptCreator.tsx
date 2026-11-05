"use client";
import {
	DEFAULT_PROMPT_RESPONSE,
	promptResponseContract,
} from "@repo/ai/lib/prompt-response-contract";
import { useOrganizationContext } from "@saas/organizations/hooks/use-organization-context";
import { orpcClient } from "@shared/lib/orpc-client";
import { orpc } from "@shared/lib/orpc-query-utils";
import { useMutation, useQuery } from "@tanstack/react-query";
import { Button } from "@ui/components/button";
import { Input } from "@ui/components/input";
import { useRouter, useSearchParams } from "next/navigation";
import { useTranslations } from "next-intl";
import { useRef, useState } from "react";
import { toast } from "sonner";
import { promptReturnHref } from "../lib/prompt-navigation";
import { LoadFailure } from "./LoadFailure";
import { PromptEditor, type PromptEditorData } from "./PromptEditor";
export function PromptCreator({ organizationId }: { organizationId?: string }) {
	const tResponse = useTranslations("prompts.response");
	const router = useRouter();
	const params = useSearchParams();
	const { basePath, userRole, loaded } = useOrganizationContext();
	const canCreate = userRole === "owner" || userRole === "admin";
	const [selected, setSelected] = useState<string>();
	const sourceId = selected || params.get("duplicateFrom");
	const mode = params.get("mode");
	const [search, setSearch] = useState("");
	const [offset, setOffset] = useState(0);
	const [unconfirmed, setUnconfirmed] = useState(false);
	const [createError, setCreateError] = useState<string>();
	const [attempted, setAttempted] = useState<PromptEditorData>();
	const inFlight = useRef(false);
	const source = useQuery({
		...orpc.prompts.get.byId.queryOptions({
			input: { id: sourceId || "", organizationId },
		}),
		enabled: !!sourceId && !!organizationId && canCreate,
		retry: false,
	});
	const catalog = useQuery({
		...orpc.prompts.list.queryOptions({
			input: {
				organizationId,
				limit: 25,
				offset,
				search: search || undefined,
			},
		}),
		enabled:
			mode === "existing" && !sourceId && !!organizationId && canCreate,
		retry: false,
	});
	const mutation = useMutation({
		retry: false,
		mutationFn: async (data: PromptEditorData) => {
			if (!organizationId) {
				throw new Error("An organization is required.");
			}
			return orpcClient.prompts.create({
				key: `${
					data.name
						.toLowerCase()
						.replace(/[^a-z0-9]+/g, "-")
						.replace(/^-|-$/g, "")
						.slice(0, 80) || "prompt"
				}-${crypto.randomUUID().slice(0, 8)}`,
				name: data.name,
				description: data.description,
				scope: "ORG",
				organizationId,
				format: data.format,
				category: data.category,
				tags: data.tags,
				isPublic: false,
				initialContent: data.content,
				responseContract: data.responseContract,
			});
		},
		onSuccess: (result) => {
			toast.success(
				"Organization prompt created. No action defaults changed.",
			);
			router.push(
				`${basePath}/prompts/${encodeURIComponent(result.prompt.id)}`,
			);
		},
		onError: (error) => {
			inFlight.current = false;
			if (
				error &&
				typeof error === "object" &&
				"code" in error &&
				[
					"BAD_REQUEST",
					"FORBIDDEN",
					"UNAUTHORIZED",
					"CONFLICT",
				].includes(String(error.code))
			) {
				setCreateError(
					String(error.code) === "FORBIDDEN"
						? "Only organization owners and administrators can create shared prompts. Your draft is preserved."
						: String(error.code) === "UNAUTHORIZED"
							? "Sign in again before saving. Your draft is preserved."
							: error instanceof Error
								? error.message
								: "Check the name, content and format before saving. Your draft is preserved.",
				);
				return;
			}
			setUnconfirmed(true);
			toast.error(
				"Creation could not be confirmed. Check the prompt library before creating another copy.",
			);
		},
	});
	const close = () =>
		router.push(promptReturnHref(basePath, params.get("returnTo")));
	if (!organizationId) {
		return <p role="alert">Choose an organization to create a prompt.</p>;
	}
	if (loaded === false) {
		return <output>Checking prompt creation permissions…</output>;
	}
	if (!canCreate) {
		return (
			<div className="mx-auto max-w-2xl space-y-4">
				<h1 className="text-xl font-semibold">
					Create organization prompts
				</h1>
				<p role="alert">
					Organization owners and administrators can create shared
					prompts. Ask an administrator to create one, or use an
					existing prompt.
				</p>
				<Button onClick={close}>Back to prompts</Button>
			</div>
		);
	}
	if (mode === "existing" && !sourceId) {
		return (
			<div className="mx-auto max-w-3xl space-y-5">
				<div className="flex items-center justify-between">
					<h1 className="text-xl font-semibold">
						Start from an existing prompt
					</h1>
					<Button variant="ghost" onClick={close}>
						Cancel
					</Button>
				</div>
				<p className="text-sm text-muted-foreground">
					Choose an accessible prompt to copy. Review the text before
					creating a separate organization prompt. Bindings and
					defaults are never copied.
				</p>
				<Input
					aria-label="Search source prompts"
					placeholder="Search prompts…"
					value={search}
					onChange={(e) => {
						setSearch(e.target.value);
						setOffset(0);
					}}
				/>
				{catalog.isPending ? (
					<output>Loading prompts…</output>
				) : catalog.isError ? (
					<LoadFailure
						message="Could not load source prompts."
						onRetry={() => catalog.refetch()}
					/>
				) : (
					<>
						<ul className="divide-y divide-border">
							{catalog.data?.prompts.map((prompt) => (
								<li key={prompt.id}>
									<Button
										variant="ghost"
										className="h-auto w-full justify-start whitespace-normal py-3 text-left"
										onClick={() => setSelected(prompt.id)}
									>
										{prompt.name}
									</Button>
								</li>
							))}
						</ul>
						{!catalog.data?.prompts.length && (
							<p>No accessible prompts match your search.</p>
						)}
						<div className="flex justify-end gap-2">
							<Button
								variant="outline"
								disabled={offset === 0}
								onClick={() =>
									setOffset((v) => Math.max(0, v - 25))
								}
							>
								Previous
							</Button>
							<Button
								variant="outline"
								disabled={
									offset + 25 >= (catalog.data?.total || 0)
								}
								onClick={() => setOffset((v) => v + 25)}
							>
								Next
							</Button>
						</div>
					</>
				)}
			</div>
		);
	}
	if (sourceId && (source.isPending || !source.data)) {
		return source.isPending ? (
			<output>Loading source prompt…</output>
		) : (
			<div className="space-y-3">
				<LoadFailure
					message="Could not load this source prompt. Your copy has not been created."
					onRetry={() => source.refetch()}
				/>
				<Button onClick={close}>Back to prompts</Button>
			</div>
		);
	}
	if (unconfirmed) {
		return (
			<div className="mx-auto max-w-2xl space-y-4">
				<h1 className="text-xl font-semibold">
					Check whether your prompt was created
				</h1>
				<p>
					The request may have reached the server. Open the library
					and check before creating another copy.
				</p>
				<Button onClick={close}>Open prompt library</Button>
				<Button variant="outline" onClick={() => setUnconfirmed(false)}>
					I checked — return to my draft
				</Button>
			</div>
		);
	}
	const savedResponse = promptResponseContract.safeParse(
		source.data?.versions?.[0]?.responseContract ?? DEFAULT_PROMPT_RESPONSE,
	);
	const initial: PromptEditorData = {
		name: source.data ? `${source.data.name.slice(0, 248)} (copy)` : "",
		description: source.data?.description || "",
		scope: "ORG",
		format: source.data?.format || "MARKDOWN",
		category: source.data?.category || undefined,
		tags: source.data?.tags || [],
		isPublic: false,
		content: source.data?.versions?.[0]?.content || "",
		responseContract: savedResponse.success
			? savedResponse.data
			: undefined,
	};
	return (
		<PromptEditor
			key={`${organizationId}:${sourceId || "new"}`}
			responseContractError={
				savedResponse.success ? undefined : tResponse("unsupported")
			}
			initialData={attempted || initial}
			error={createError}
			onSave={(data) => {
				if (inFlight.current) {
					return;
				}
				inFlight.current = true;
				setCreateError(undefined);
				setAttempted(data);
				mutation.mutate(data);
			}}
			onCancel={close}
			isLoading={mutation.isPending}
			canEditScope={false}
			organizationId={organizationId}
			creating
			startWithAssistant={mode === "conversation"}
		/>
	);
}
