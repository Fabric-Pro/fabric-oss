"use client";

import { MAX_BULK_INVITATIONS } from "@repo/auth/lib/invitation-limits";
import {
	fullOrganizationQueryKey,
	orgInvitationsQueryKey,
} from "@saas/organizations/lib/api";
import { parseEmailList } from "@saas/organizations/lib/parse-email-list";
import { orpcClient } from "@shared/lib/orpc-client";
import { useMutation, useQueryClient } from "@tanstack/react-query";
import { Button } from "@ui/components/button";
import {
	Dialog,
	DialogContent,
	DialogDescription,
	DialogFooter,
	DialogHeader,
	DialogTitle,
	DialogTrigger,
} from "@ui/components/dialog";
import { Textarea } from "@ui/components/textarea";
import { cn } from "@ui/lib";
import { useTranslations } from "next-intl";
import { useMemo, useState } from "react";
import { toast } from "sonner";

export function BulkInviteMembersDialog({
	organizationId,
}: {
	organizationId: string;
}) {
	const t = useTranslations();
	const queryClient = useQueryClient();
	const [open, setOpen] = useState(false);
	const [text, setText] = useState("");
	const emails = useMemo(() => parseEmailList(text), [text]);
	const tooMany = emails.length > MAX_BULK_INVITATIONS;

	const invite = useMutation({
		mutationFn: () =>
			orpcClient.organizations.invitations.bulk({
				organizationId,
				emails,
			}),
		onSuccess: () => {
			queryClient.invalidateQueries({
				queryKey: fullOrganizationQueryKey(organizationId),
			});
			queryClient.invalidateQueries({
				queryKey: orgInvitationsQueryKey(organizationId),
			});
		},
		onError: () => {
			toast.error(t("organizations.settings.members.bulkInvite.error"));
		},
	});
	const results = invite.data?.results;

	const reset = () => {
		setText("");
		invite.reset();
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
				<Button type="button" variant="outline">
					{t("organizations.settings.members.bulkInvite.open")}
				</Button>
			</DialogTrigger>
			<DialogContent>
				<DialogHeader>
					<DialogTitle>
						{t("organizations.settings.members.bulkInvite.title")}
					</DialogTitle>
					<DialogDescription>
						{t(
							"organizations.settings.members.bulkInvite.description",
						)}
					</DialogDescription>
				</DialogHeader>

				{/* Mounted before the request, so the outcome is announced. */}
				{/* biome-ignore lint/a11y/useSemanticElements: status text is not a form output; <p role="status"> is the WAI-ARIA recommendation */}
				<p role="status" className="text-sm empty:hidden">
					{results &&
						t("organizations.settings.members.bulkInvite.summary", {
							invited: results.filter(
								(result) => result.status === "invited",
							).length,
							total: results.length,
						})}
				</p>

				{results ? (
					<>
						<ul className="max-h-80 divide-y overflow-y-auto rounded-md border text-sm">
							{results.map((result, index) => (
								<li
									key={`${result.email}-${index}`}
									className="flex items-center justify-between gap-4 px-3 py-2"
								>
									<span className="min-w-0 break-all">
										{result.email}
									</span>
									<span
										className={cn(
											"shrink-0",
											result.status === "invited"
												? "text-muted-foreground"
												: "text-destructive",
										)}
									>
										{t(
											`organizations.settings.members.bulkInvite.status.${result.status}`,
										)}
									</span>
								</li>
							))}
						</ul>
						<DialogFooter>
							<Button
								type="button"
								variant="outline"
								onClick={reset}
							>
								{t(
									"organizations.settings.members.bulkInvite.inviteMore",
								)}
							</Button>
						</DialogFooter>
					</>
				) : (
					<>
						<Textarea
							aria-label={t(
								"organizations.settings.members.bulkInvite.title",
							)}
							className="min-h-40"
							placeholder={t(
								"organizations.settings.members.bulkInvite.placeholder",
							)}
							value={text}
							onChange={(event) => setText(event.target.value)}
						/>
						{tooMany && (
							<p
								role="alert"
								className="text-destructive text-sm"
							>
								{t(
									"organizations.settings.members.bulkInvite.tooMany",
									{ max: MAX_BULK_INVITATIONS },
								)}
							</p>
						)}
						<DialogFooter>
							<Button
								type="button"
								loading={invite.isPending}
								disabled={emails.length === 0 || tooMany}
								onClick={() => invite.mutate()}
							>
								{t(
									"organizations.settings.members.bulkInvite.submit",
									{ count: emails.length },
								)}
							</Button>
						</DialogFooter>
					</>
				)}
			</DialogContent>
		</Dialog>
	);
}
