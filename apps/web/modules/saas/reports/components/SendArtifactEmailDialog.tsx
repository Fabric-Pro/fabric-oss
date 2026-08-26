"use client";

/**
 * Dialog used from the Execution History row in `TemplateInstanceDetail` to
 * email a generated report artifact. Recipients can be drawn from either the
 * current organization's members or from freeform external email addresses.
 *
 * Send is synchronous (the oRPC handler loops over recipients) — see
 * packages/api/modules/reports/procedures/artifacts/send-email.ts. The result
 * `{ sent, failed[] }` is surfaced via toast so partial failures are not silent.
 */

import { useFullOrganizationQuery } from "@saas/organizations/lib/api";
import { orpc } from "@shared/lib/orpc-query-utils";
import { useMutation, useQueryClient } from "@tanstack/react-query";
import { Badge } from "@ui/components/badge";
import { Button } from "@ui/components/button";
import {
	Dialog,
	DialogContent,
	DialogDescription,
	DialogFooter,
	DialogHeader,
	DialogTitle,
} from "@ui/components/dialog";
import { Input } from "@ui/components/input";
import { Label } from "@ui/components/label";
import { Tabs, TabsContent, TabsList, TabsTrigger } from "@ui/components/tabs";
import { Textarea } from "@ui/components/textarea";
import { Loader2Icon, MailIcon, UsersIcon, XIcon } from "lucide-react";
import { useMemo, useState } from "react";
import { toast } from "sonner";
import { z } from "zod";

type Props = {
	artifactId: string;
	artifactName: string;
	organizationId?: string | null;
	open: boolean;
	onOpenChange: (open: boolean) => void;
	/** Called after a send that produced at least one SENT delivery. */
	onSent?: () => void;
};

const emailSchema = z.string().email();

export function SendArtifactEmailDialog({
	artifactId,
	artifactName,
	organizationId,
	open,
	onOpenChange,
	onSent,
}: Props) {
	const queryClient = useQueryClient();
	const { data: organization } = useFullOrganizationQuery(
		organizationId ?? "",
	);

	const orgMembers = useMemo(
		() =>
			(organization?.members ?? []).map((m) => ({
				id: m.user.id,
				name: m.user.name ?? null,
				email: m.user.email,
			})),
		[organization?.members],
	);

	const [selectedMemberIds, setSelectedMemberIds] = useState<Set<string>>(
		new Set(),
	);
	const [emailInput, setEmailInput] = useState("");
	const [emailInputError, setEmailInputError] = useState<string | null>(null);
	const [externalEmails, setExternalEmails] = useState<string[]>([]);
	const [messageBody, setMessageBody] = useState("");

	const totalRecipients = selectedMemberIds.size + externalEmails.length;

	function resetForm() {
		setSelectedMemberIds(new Set());
		setEmailInput("");
		setEmailInputError(null);
		setExternalEmails([]);
		setMessageBody("");
	}

	function handleOpenChange(next: boolean) {
		if (!next) {
			resetForm();
		}
		onOpenChange(next);
	}

	function toggleMember(id: string) {
		setSelectedMemberIds((prev) => {
			const next = new Set(prev);
			if (next.has(id)) {
				next.delete(id);
			} else {
				next.add(id);
			}
			return next;
		});
	}

	function commitEmailInput() {
		const trimmed = emailInput.trim();
		if (!trimmed) {
			return;
		}
		const parsed = emailSchema.safeParse(trimmed);
		if (!parsed.success) {
			setEmailInputError("Invalid email address");
			return;
		}
		if (
			externalEmails.some(
				(e) => e.toLowerCase() === trimmed.toLowerCase(),
			)
		) {
			setEmailInputError("Already added");
			return;
		}
		setExternalEmails((prev) => [...prev, trimmed]);
		setEmailInput("");
		setEmailInputError(null);
	}

	function removeExternalEmail(email: string) {
		setExternalEmails((prev) => prev.filter((e) => e !== email));
	}

	const sendMutation = useMutation(
		orpc.reports.artifacts.sendEmail.mutationOptions({
			onSuccess: (result) => {
				if (result.failed.length === 0) {
					toast.success(
						result.sent === 1
							? "Sent to 1 recipient"
							: `Sent to ${result.sent} recipients`,
					);
					handleOpenChange(false);
				} else if (result.sent === 0) {
					toast.error(
						`All ${result.failed.length} sends failed: ${result.failed
							.slice(0, 3)
							.map((f) => f.email)
							.join(", ")}${result.failed.length > 3 ? "…" : ""}`,
					);
				} else {
					toast.warning(
						`Sent ${result.sent}, failed ${result.failed.length}: ${result.failed
							.slice(0, 3)
							.map((f) => f.email)
							.join(", ")}${result.failed.length > 3 ? "…" : ""}`,
					);
					// Keep dialog open so the user can retry / adjust.
				}
				if (result.sent > 0) {
					queryClient.invalidateQueries({
						queryKey:
							orpc.reports.artifacts.listDeliveries.queryKey({
								input: {
									artifactId,
									organizationId: organizationId ?? null,
								},
							}),
					});
					onSent?.();
				}
			},
			onError: (e) => {
				toast.error(e.message ?? "Failed to send report");
			},
		}),
	);

	function handleSend() {
		if (totalRecipients === 0) {
			return;
		}
		sendMutation.mutate({
			artifactId,
			organizationId: organizationId ?? null,
			recipientUserIds: Array.from(selectedMemberIds),
			recipientEmails: externalEmails,
			messageBody: messageBody.trim() ? messageBody.trim() : undefined,
		});
	}

	const hasOrg = !!organizationId;
	const isSending = sendMutation.isPending;

	return (
		<Dialog open={open} onOpenChange={handleOpenChange}>
			<DialogContent className="max-w-2xl">
				<DialogHeader>
					<DialogTitle className="flex items-center gap-2">
						<MailIcon className="h-4 w-4" />
						Send report by email
					</DialogTitle>
					<DialogDescription>
						Send <span className="font-medium">{artifactName}</span>{" "}
						as an attachment.
					</DialogDescription>
				</DialogHeader>

				<div className="space-y-4">
					{totalRecipients > 0 && (
						<div className="rounded-md border bg-muted/40 p-2">
							<div className="mb-2 text-xs uppercase tracking-wider text-muted-foreground">
								Recipients ({totalRecipients})
							</div>
							<div className="flex flex-wrap gap-1.5">
								{Array.from(selectedMemberIds).map((id) => {
									const m = orgMembers.find(
										(om) => om.id === id,
									);
									if (!m) {
										return null;
									}
									return (
										<Badge
											key={`u-${id}`}
											variant="secondary"
											className="gap-1"
										>
											<UsersIcon className="h-3 w-3" />
											{m.name ?? m.email}
											<button
												type="button"
												onClick={() => toggleMember(id)}
												aria-label={`Remove ${m.email}`}
												className="ml-1 opacity-70 hover:opacity-100"
											>
												<XIcon className="h-3 w-3" />
											</button>
										</Badge>
									);
								})}
								{externalEmails.map((email) => (
									<Badge
										key={`e-${email}`}
										variant="outline"
										className="gap-1"
									>
										<MailIcon className="h-3 w-3" />
										{email}
										<button
											type="button"
											onClick={() =>
												removeExternalEmail(email)
											}
											aria-label={`Remove ${email}`}
											className="ml-1 opacity-70 hover:opacity-100"
										>
											<XIcon className="h-3 w-3" />
										</button>
									</Badge>
								))}
							</div>
						</div>
					)}

					<Tabs defaultValue={hasOrg ? "members" : "external"}>
						<TabsList>
							{hasOrg && (
								<TabsTrigger value="members">
									Team members
								</TabsTrigger>
							)}
							<TabsTrigger value="external">
								Email addresses
							</TabsTrigger>
						</TabsList>

						{hasOrg && (
							<TabsContent value="members">
								<div className="max-h-60 overflow-y-auto rounded-md border">
									{orgMembers.length === 0 ? (
										<div className="px-3 py-6 text-center text-sm text-muted-foreground">
											No other members in this
											organization.
										</div>
									) : (
										<ul className="divide-y">
											{orgMembers.map((m) => {
												const selected =
													selectedMemberIds.has(m.id);
												return (
													<li key={m.id}>
														<button
															type="button"
															onClick={() =>
																toggleMember(
																	m.id,
																)
															}
															className={`flex w-full items-center justify-between px-3 py-2 text-left text-sm hover:bg-muted/60 ${
																selected
																	? "bg-muted"
																	: ""
															}`}
														>
															<div>
																<div className="font-medium">
																	{m.name ??
																		m.email}
																</div>
																{m.name && (
																	<div className="text-xs text-muted-foreground">
																		{
																			m.email
																		}
																	</div>
																)}
															</div>
															<input
																type="checkbox"
																readOnly
																checked={
																	selected
																}
																aria-label={`Select ${m.email}`}
															/>
														</button>
													</li>
												);
											})}
										</ul>
									)}
								</div>
							</TabsContent>
						)}

						<TabsContent value="external">
							<div className="space-y-2">
								<Label htmlFor="external-email">
									Add an email address
								</Label>
								<div className="flex gap-2">
									<Input
										id="external-email"
										type="email"
										autoComplete="off"
										placeholder="name@example.com"
										value={emailInput}
										onChange={(e) => {
											setEmailInput(e.target.value);
											if (emailInputError) {
												setEmailInputError(null);
											}
										}}
										onKeyDown={(e) => {
											if (
												e.key === "Enter" ||
												e.key === ","
											) {
												e.preventDefault();
												commitEmailInput();
											}
										}}
									/>
									<Button
										type="button"
										variant="outline"
										onClick={commitEmailInput}
										disabled={!emailInput.trim()}
									>
										Add
									</Button>
								</div>
								{emailInputError && (
									<p className="text-xs text-destructive">
										{emailInputError}
									</p>
								)}
								<p className="text-xs text-muted-foreground">
									Press Enter or click Add to attach a
									recipient.
								</p>
							</div>
						</TabsContent>
					</Tabs>

					<div className="space-y-2">
						<Label htmlFor="message-body">Message (optional)</Label>
						<Textarea
							id="message-body"
							placeholder="Add a short note for the recipients…"
							value={messageBody}
							onChange={(e) => setMessageBody(e.target.value)}
							rows={3}
							maxLength={10_000}
						/>
					</div>
				</div>

				<DialogFooter>
					<Button
						type="button"
						variant="outline"
						onClick={() => handleOpenChange(false)}
						disabled={isSending}
					>
						Cancel
					</Button>
					<Button
						type="button"
						onClick={handleSend}
						disabled={totalRecipients === 0 || isSending}
					>
						{isSending && (
							<Loader2Icon className="mr-2 h-4 w-4 animate-spin" />
						)}
						Send
					</Button>
				</DialogFooter>
			</DialogContent>
		</Dialog>
	);
}
