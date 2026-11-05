"use client";
import { skillCreateSchema } from "@repo/ai/skill-contracts";
import { orpcClient } from "@shared/lib/orpc-client";
import { useMutation } from "@tanstack/react-query";
import { Alert, AlertDescription, AlertTitle } from "@ui/components/alert";
import { Button } from "@ui/components/button";
import { Label } from "@ui/components/label";
import { Markdown } from "@ui/components/markdown";
import {
	Sheet,
	SheetContent,
	SheetDescription,
	SheetHeader,
	SheetTitle,
} from "@ui/components/sheet";
import { Textarea } from "@ui/components/textarea";
import { SendIcon } from "lucide-react";
import { useId, useState } from "react";
import { type SkillDraft, skillSlug, skillUiError } from "../lib/skill-ui";

type Message = { role: "user" | "assistant"; content: string };
export function SkillAssistant({
	organizationId,
	open,
	onOpenChange,
	draft,
	onApply,
	canCreate,
	checkingPermissions = false,
}: {
	organizationId: string;
	open: boolean;
	onOpenChange: (open: boolean) => void;
	draft: SkillDraft;
	onApply: (draft: SkillDraft) => void;
	canCreate: boolean;
	checkingPermissions?: boolean;
}) {
	const id = useId();
	const [input, setInput] = useState("");
	const [history, setHistory] = useState<Message[]>([]);
	const [proposal, setProposal] = useState<{
		value: SkillDraft;
		base: string;
		applied: boolean;
	}>();
	const fingerprint = JSON.stringify(draft);
	const tooLarge = draft.content.length > 60000;
	const ask = useMutation({
		mutationFn: async () => {
			const text = input.trim();
			const base = JSON.stringify(draft);
			const result = await orpcClient.skills.assist({
				organizationId,
				draft,
				message: text,
				history: history.slice(-10),
			});
			return { result, text, base };
		},
		retry: false,
		onSuccess: ({ result, text, base }) => {
			setHistory((previous) =>
				[
					...previous,
					{ role: "user" as const, content: text },
					{ role: "assistant" as const, content: result.message },
				].slice(-10),
			);
			if (result.proposal) {
				setProposal({ value: result.proposal, base, applied: false });
			} else {
				setProposal(undefined);
			}
			setInput((current) => (current.trim() === text ? "" : current));
		},
	});
	const validated = proposal
		? skillCreateSchema.safeParse({
				...proposal.value,
				slug: proposal.value.slug || skillSlug(proposal.value.name),
				isPublished: false,
				isDiscoverable: false,
			})
		: undefined;
	const stale = !!proposal && proposal.base !== fingerprint;
	return (
		<Sheet open={open} onOpenChange={onOpenChange}>
			<SheetContent
				side="right"
				className="flex w-full min-w-0 flex-col p-0 sm:max-w-xl"
			>
				<SheetHeader className="shrink-0 border-b border-border px-5 py-4">
					<SheetTitle>Skill assistant</SheetTitle>
					<SheetDescription>
						Describe the outcome. Review a proposal before applying
						it to your draft.
					</SheetDescription>
				</SheetHeader>
				<div className="min-h-0 flex-1 space-y-5 overflow-y-auto p-5">
					<div className="space-y-2">
						<h2 className="text-sm font-semibold">
							What should this skill help your team do?
						</h2>
						<p className="text-sm text-muted-foreground">
							I can draft instructions or help refine when this
							skill should be used. Nothing is saved or shared
							until you choose to save it.
						</p>
					</div>
					{!history.length && (
						<Button
							type="button"
							variant="outline"
							size="sm"
							className="h-auto whitespace-normal text-left"
							onClick={() =>
								setInput(
									"Help me create a reusable skill for writing a clear delivery update with progress, risks, evidence and next steps. Ask me what context and output my team needs before proposing instructions.",
								)
							}
						>
							Help draft a delivery update skill
						</Button>
					)}
					{history.map((message, index) => (
						<div
							key={`${index}-${message.role}`}
							className="space-y-2"
						>
							<p className="text-xs font-medium text-muted-foreground">
								{message.role === "user" ? "You" : "Fabric"}
							</p>
							<Markdown>{message.content}</Markdown>
						</div>
					))}
					{ask.isPending && (
						<output className="block text-sm text-muted-foreground">
							Preparing a suggestion…
						</output>
					)}
					{ask.isError && (
						<Alert variant="error">
							<AlertTitle>Assistant could not respond</AlertTitle>
							<AlertDescription>
								{skillUiError(ask.error)}
							</AlertDescription>
						</Alert>
					)}
					{proposal && (
						<section
							aria-label="Review skill proposal"
							className="space-y-3 rounded-lg border border-border p-4"
						>
							<h3 className="text-sm font-semibold">
								Review suggested draft
							</h3>
							<dl className="space-y-2 text-sm">
								<div>
									<dt className="font-medium">Name</dt>
									<dd>
										{proposal.value.name || "Not provided"}
									</dd>
								</div>
								<div>
									<dt className="font-medium">When to use</dt>
									<dd className="whitespace-pre-wrap break-words">
										{proposal.value.description ||
											"Not provided"}
									</dd>
								</div>
							</dl>
							<div className="max-h-64 overflow-y-auto rounded-md border border-border bg-muted/20 p-3">
								<Markdown>
									{proposal.value.content ||
										"No instructions provided."}
								</Markdown>
							</div>
							{stale && !proposal.applied && (
								<p className="text-sm text-muted-foreground">
									Your draft changed after this request. Ask
									for a new proposal before applying changes.
								</p>
							)}
							{validated && !validated.success && (
								<p className="text-sm text-muted-foreground">
									This proposal needs a complete name,
									purpose, and instructions before it can be
									applied. Ask the assistant to complete it.
								</p>
							)}
							{proposal.applied ? (
								<output className="block text-sm text-success">
									Proposal applied to your draft. Review and
									save it when ready.
								</output>
							) : (
								<div className="flex flex-wrap gap-2">
									<Button
										type="button"
										size="sm"
										disabled={
											stale ||
											!validated?.success ||
											!canCreate
										}
										onClick={() => {
											if (!validated?.success) {
												return;
											}
											const value = validated.data;
											onApply({
												name: value.name,
												slug: value.slug,
												description: value.description,
												content: value.content,
												category: value.category,
												tags: value.tags,
											});
											setProposal((previous) =>
												previous
													? {
															...previous,
															applied: true,
														}
													: undefined,
											);
										}}
									>
										Apply proposal to draft
									</Button>
									<Button
										type="button"
										variant="ghost"
										size="sm"
										onClick={() => setProposal(undefined)}
									>
										Dismiss
									</Button>
								</div>
							)}
						</section>
					)}
				</div>
				<form
					className="shrink-0 space-y-2 border-t border-border bg-card p-4"
					onSubmit={(event) => {
						event.preventDefault();
						if (
							input.trim() &&
							!ask.isPending &&
							!tooLarge &&
							!checkingPermissions &&
							canCreate
						) {
							ask.mutate();
						}
					}}
				>
					<Label htmlFor={id}>Message skill assistant</Label>
					<Textarea
						id={id}
						value={input}
						onChange={(e) => setInput(e.target.value)}
						rows={3}
						maxLength={8000}
						placeholder="Describe your skill or ask for a refinement…"
						disabled={ask.isPending}
					/>
					{tooLarge && (
						<p className="text-xs text-muted-foreground">
							The assistant supports instructions up to 60,000
							characters. You can still edit and save the larger
							skill.
						</p>
					)}
					{checkingPermissions ? (
						<output className="block text-xs text-muted-foreground">
							Checking authoring permissions…
						</output>
					) : (
						!canCreate && (
							<p className="text-xs text-muted-foreground">
								Your current role or policy does not allow
								authoring skills.
							</p>
						)
					)}
					<Button
						type="submit"
						size="sm"
						loading={ask.isPending}
						disabled={
							!input.trim() ||
							ask.isPending ||
							tooLarge ||
							checkingPermissions ||
							!canCreate
						}
					>
						<SendIcon className="size-4" />
						Send request
					</Button>
				</form>
			</SheetContent>
		</Sheet>
	);
}
