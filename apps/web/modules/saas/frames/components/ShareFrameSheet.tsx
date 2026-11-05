"use client";

import type { FrameShareScope } from "@repo/database/prisma/zod";
import { useSession } from "@saas/auth/hooks/use-session";
import { orpcClient } from "@shared/lib/orpc-client";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { Button } from "@ui/components/button";
import {
	Card,
	CardContent,
	CardDescription,
	CardHeader,
	CardTitle,
} from "@ui/components/card";
import { Input } from "@ui/components/input";
import { Label } from "@ui/components/label";
import { RadioGroup, RadioGroupItem } from "@ui/components/radio-group";
import {
	Sheet,
	SheetContent,
	SheetDescription,
	SheetHeader,
	SheetTitle,
} from "@ui/components/sheet";
import { useToast } from "@ui/hooks/use-toast";
import { formatDistanceToNow } from "date-fns";
import {
	Check,
	Copy,
	FolderKanban,
	Globe,
	Lock,
	Mail,
	Users,
	X,
} from "lucide-react";
import { useTranslations } from "next-intl";
import { useState } from "react";

interface ShareFrameSheetProps {
	frameId: string;
	organizationId?: string | null;
	/** True when the frame belongs to a project; exposes the PROJECT scope. */
	isProjectFrame?: boolean;
	open: boolean;
	onOpenChange: (open: boolean) => void;
}

/**
 * PROJECT is assigned by the backend when an agent creates a project frame
 * (spike demo); `frames.share` does not accept it, so it is shown as the
 * current state but cannot be selected here.
 */
type SelectableShareScope = Exclude<FrameShareScope, "PROJECT">;

const SCOPE_OPTIONS: {
	value: FrameShareScope;
	label: string;
	description: string;
	icon: React.ReactNode;
}[] = [
	{
		value: "PRIVATE",
		label: "Private",
		description: "No additional sharing",
		icon: <Lock className="h-4 w-4" />,
	},
	{
		value: "EMAILS_ONLY",
		label: "Email invites only",
		description: "People you invite by email can also view",
		icon: <Mail className="h-4 w-4" />,
	},
	{
		value: "WORKSPACE_AND_EMAILS",
		label: "Organization members and email invites",
		description: "Everyone in your organization plus invited emails",
		icon: <Users className="h-4 w-4" />,
	},
	{
		value: "PROJECT",
		label: "Project members",
		description:
			"Accepted members of the frame's project, including project-scoped guests",
		icon: <FolderKanban className="h-4 w-4" />,
	},
	{
		value: "PUBLIC",
		label: "Anyone with the link",
		description: "No sign-in required",
		icon: <Globe className="h-4 w-4" />,
	},
];

export function ShareFrameSheet({
	frameId,
	organizationId,
	isProjectFrame = false,
	open,
	onOpenChange,
}: ShareFrameSheetProps) {
	const { toast } = useToast();
	const { user } = useSession();
	const t = useTranslations("frameSharing");
	const [confirmation, setConfirmation] = useState<
		"all" | "public-link" | null
	>(null);
	const queryClient = useQueryClient();
	const [emailInput, setEmailInput] = useState("");
	const [copied, setCopied] = useState(false);

	// Fetch grants and current scope
	const {
		data: grantsData,
		isError: grantsError,
		refetch: refetchGrants,
	} = useQuery({
		queryKey: ["frame", "grants", frameId, organizationId, user?.id],
		queryFn: () =>
			orpcClient.frames.listGrants({
				id: frameId,
				organizationId: organizationId ?? null,
			}),
		enabled: open && Boolean(organizationId) && Boolean(user?.id),
		retry: false,
	});

	// Share mutation
	const shareMutation = useMutation({
		mutationFn: (shareScope: SelectableShareScope) =>
			orpcClient.frames.share({
				id: frameId,
				organizationId: organizationId ?? null,
				shareScope,
				expectedUpdatedAt: grantsData?.updatedAt,
			}),
		onSuccess: () => {
			setConfirmation(null);
			queryClient.invalidateQueries({
				queryKey: [
					"frame",
					"grants",
					frameId,
					organizationId,
					user?.id,
				],
			});
			toast({ title: "Sharing settings updated" });
		},
		onError: () => {
			toast({
				title: "Failed to update sharing",
				variant: "destructive",
			});
		},
	});

	// Invite mutation
	const inviteMutation = useMutation({
		mutationFn: (emails: string[]) =>
			orpcClient.frames.invite({
				id: frameId,
				organizationId: organizationId ?? null,
				emails,
				expectedUpdatedAt: grantsData?.updatedAt,
			}),
		onSuccess: () => {
			setEmailInput("");
			queryClient.invalidateQueries({
				queryKey: [
					"frame",
					"grants",
					frameId,
					organizationId,
					user?.id,
				],
			});
			toast({ title: t("accessAdded") });
		},
		onError: () => {
			toast({
				title: t("accessError"),
				variant: "destructive",
			});
		},
	});

	// Revoke mutation
	const revokeMutation = useMutation({
		mutationFn: (email: string) => {
			if (!grantsData?.canRevoke) {
				throw new Error("Insufficient permission");
			}
			return orpcClient.frames.revokeInvite({
				id: frameId,
				organizationId: organizationId ?? null,
				email,
				expectedUpdatedAt: grantsData?.updatedAt,
			});
		},
		onSuccess: () => {
			queryClient.invalidateQueries({
				queryKey: [
					"frame",
					"grants",
					frameId,
					organizationId,
					user?.id,
				],
			});
			toast({ title: "Access revoked" });
		},
		onError: () =>
			toast({ title: t("removeError"), variant: "destructive" }),
	});

	const revokeSharingMutation = useMutation({
		mutationFn: (mode: "all" | "public-link") => {
			if (!grantsData?.canRevoke) {
				throw new Error("Insufficient permission");
			}
			return orpcClient.frames.revokeShare({
				id: frameId,
				organizationId: organizationId ?? null,
				mode,
				expectedUpdatedAt: grantsData?.updatedAt,
			});
		},
		onSuccess: () => {
			setConfirmation(null);
			queryClient.invalidateQueries({
				queryKey: [
					"frame",
					"grants",
					frameId,
					organizationId,
					user?.id,
				],
			});
			toast({ title: t("removed") });
		},
		onError: () => {
			toast({ title: t("removeError"), variant: "destructive" });
		},
	});
	const mutationPending =
		shareMutation.isPending ||
		inviteMutation.isPending ||
		revokeMutation.isPending ||
		revokeSharingMutation.isPending;
	const currentScope = grantsError ? undefined : grantsData?.shareScope;
	const hasPublicLink = Boolean(
		grantsData?.hasPublicLink ??
			(currentScope === "PUBLIC" && grantsData?.shareToken),
	);
	const publicSharingAllowed = grantsData?.canShareFramesPublicly === true;
	const activePublicLink = hasPublicLink && publicSharingAllowed;
	const publicShareUrl =
		activePublicLink && grantsData?.shareToken
			? `${window.location.origin}/share/frame/${grantsData.shareToken}`
			: "";
	// PROJECT only makes sense for project-scoped frames; keep it visible when
	// it is already the current scope so the label is never blank.
	const scopeOptions = SCOPE_OPTIONS.filter(
		(option) =>
			option.value !== "PROJECT" ||
			isProjectFrame ||
			currentScope === "PROJECT",
	);
	const grants = grantsData?.grants ?? [];

	const handleCopyLink = async () => {
		if (!publicShareUrl) {
			return;
		}
		await navigator.clipboard.writeText(publicShareUrl);
		setCopied(true);
		setTimeout(() => setCopied(false), 2000);
	};

	const handleAddEmails = () => {
		const emails = emailInput
			.split(/[,\n]/)
			.map((e) => e.trim())
			.filter((e) => e?.includes("@"));

		if (emails.length === 0) {
			toast({
				title: "No valid emails",
				description: "Please enter at least one valid email address",
				variant: "destructive",
			});
			return;
		}

		inviteMutation.mutate(emails);
	};

	const showEmailSection =
		currentScope === "EMAILS_ONLY" ||
		currentScope === "WORKSPACE_AND_EMAILS" ||
		grants.length > 0;

	return (
		<Sheet open={open} onOpenChange={onOpenChange}>
			<SheetContent className="w-full sm:max-w-lg overflow-y-auto">
				<SheetHeader>
					<SheetTitle>Share Frame</SheetTitle>
					<SheetDescription>
						Choose who can access this frame
					</SheetDescription>
				</SheetHeader>

				{grantsError && (
					<div role="alert" className="space-y-3 py-6">
						<p>
							Unable to load sharing settings. Current access
							could not be verified.
						</p>
						<Button
							variant="outline"
							onClick={() => refetchGrants()}
						>
							Try again
						</Button>
					</div>
				)}
				{!grantsError && !grantsData && (
					<output className="block py-6 text-muted-foreground">
						Loading sharing settings…
					</output>
				)}
				{currentScope && (
					<div className="space-y-6 py-6">
						{/* Scope Selection */}
						<div className="space-y-4">
							<Label>Access Level</Label>
							<RadioGroup
								aria-label="Access Level"
								value={currentScope}
								onValueChange={(value) => {
									const option = scopeOptions.find(
										(option) => option.value === value,
									);
									if (option && option.value !== "PROJECT") {
										if (option.value === "PRIVATE") {
											setConfirmation("all");
											return;
										}
										shareMutation.mutate(option.value);
									}
								}}
								className="space-y-3"
							>
								{scopeOptions.map((option) => (
									<div
										key={option.value}
										className="flex items-start space-x-3"
									>
										<RadioGroupItem
											value={option.value}
											id={option.value}
											className="mt-1"
											disabled={
												option.value === "PROJECT" ||
												(option.value === "PUBLIC" &&
													!publicSharingAllowed) ||
												mutationPending
											}
										/>
										<div className="flex-1">
											<Label
												htmlFor={option.value}
												className="flex items-center gap-2 font-medium cursor-pointer"
											>
												{option.icon}
												{option.value === "PUBLIC" &&
												!publicSharingAllowed
													? t("publicDisabledLabel")
													: option.label}
											</Label>
											<p className="text-sm text-muted-foreground mt-1">
												{option.value === "PUBLIC" &&
												!publicSharingAllowed
													? t("publicPolicyDisabled")
													: option.description}
											</p>
										</div>
									</div>
								))}
							</RadioGroup>
						</div>

						{/* Share Link (for PUBLIC) */}
						{hasPublicLink && (
							<div className="space-y-2">
								<Label>Share Link</Label>
								{activePublicLink ? (
									<div className="flex gap-2">
										<Input
											value={publicShareUrl}
											aria-label="Public share link"
											readOnly
											className="flex-1"
										/>
										<Button
											variant="outline"
											size="icon"
											onClick={handleCopyLink}
											aria-label="Copy share link"
											disabled={!publicShareUrl}
										>
											{copied ? (
												<Check className="h-4 w-4" />
											) : (
												<Copy className="h-4 w-4" />
											)}
										</Button>
									</div>
								) : (
									<output className="block text-sm text-muted-foreground">
										{t("retainedLinkDisabled")}
									</output>
								)}
								<Button
									variant="outline"
									disabled={
										mutationPending ||
										!grantsData?.canRevoke
									}
									onClick={() =>
										setConfirmation("public-link")
									}
								>
									{t("removePublicLink")}
								</Button>
							</div>
						)}

						{/* Email Invites */}
						{showEmailSection && (
							<div className="space-y-4">
								<div className="space-y-2">
									<Label
										htmlFor={`frame-invite-emails-${frameId}`}
									>
										{t("addAccessByEmail")}
									</Label>
									<div className="flex gap-2">
										<Input
											id={`frame-invite-emails-${frameId}`}
											aria-describedby={`frame-invite-notice-${frameId}`}
											placeholder="Enter emails (comma or newline separated)"
											value={emailInput}
											onChange={(e) =>
												setEmailInput(e.target.value)
											}
											className="flex-1"
											onKeyDown={(e) => {
												if (e.key === "Enter") {
													handleAddEmails();
												}
											}}
										/>
										<Button
											onClick={handleAddEmails}
											disabled={mutationPending}
										>
											{inviteMutation.isPending
												? t("addingAccess")
												: t("addAccess")}
										</Button>
									</div>
								</div>

								<p
									id={`frame-invite-notice-${frameId}`}
									className="text-sm text-muted-foreground"
								>
									{t("noEmailSent")}
								</p>
								{/* Grant List */}
								{grants.length > 0 && (
									<div className="space-y-2">
										<Label className="text-sm text-muted-foreground">
											People with access ({grants.length})
										</Label>
										<div className="space-y-2 max-h-60 overflow-y-auto">
											{grants.map((grant) => (
												<div
													key={grant.id}
													className="flex items-center justify-between p-2 rounded-lg border bg-card"
												>
													<div className="min-w-0 flex-1">
														<p className="font-medium text-sm truncate">
															{grant.email}
														</p>
														<p className="text-xs text-muted-foreground">
															Invited{" "}
															{formatDistanceToNow(
																new Date(
																	grant.invitedAt,
																),
																{
																	addSuffix: true,
																},
															)}
															{grant.accessCount >
																0 &&
																` • Accessed ${grant.accessCount} time${grant.accessCount > 1 ? "s" : ""}`}
														</p>
													</div>
													<Button
														variant="ghost"
														size="icon"
														className="h-8 w-8 shrink-0"
														aria-label={t(
															"removeInvitation",
															{
																email:
																	grant.email ??
																	"",
															},
														)}
														onClick={() =>
															grant.email &&
															revokeMutation.mutate(
																grant.email,
															)
														}
														disabled={
															mutationPending ||
															!grantsData?.canRevoke
														}
													>
														<X
															className="h-4 w-4"
															aria-hidden
														/>
													</Button>
												</div>
											))}
										</div>
									</div>
								)}
							</div>
						)}

						{confirmation && (
							<div
								role="alert"
								className="space-y-3 rounded-lg border border-border p-3"
							>
								<p>
									{t(
										confirmation === "all"
											? isProjectFrame
												? "confirmAllProject"
												: "confirmAll"
											: "confirmPublic",
									)}
								</p>
								<div className="flex flex-wrap gap-2">
									<Button
										variant="outline"
										disabled={mutationPending}
										onClick={() => setConfirmation(null)}
									>
										{t("keepAccess")}
									</Button>
									<Button
										variant="destructive"
										disabled={mutationPending}
										onClick={() =>
											confirmation === "all"
												? shareMutation.mutate(
														"PRIVATE",
													)
												: revokeSharingMutation.mutate(
														"public-link",
													)
										}
									>
										{t(
											revokeSharingMutation.isPending ||
												shareMutation.isPending
												? "removing"
												: confirmation === "all"
													? "confirmMakePrivate"
													: "confirmRemovePublic",
										)}
									</Button>
								</div>
							</div>
						)}
						{(currentScope !== "PRIVATE" ||
							grants.length > 0 ||
							hasPublicLink) && (
							<Button
								variant="outline"
								disabled={mutationPending}
								onClick={() => setConfirmation("all")}
							>
								{t("makePrivate")}
							</Button>
						)}
						{!grantsData?.canRevoke &&
							(hasPublicLink || grants.length > 0) && (
								<p className="text-sm text-muted-foreground">
									{t("revokePermission")}
								</p>
							)}
						{/* Info Card */}
						<Card className="bg-muted/50">
							<CardHeader className="pb-2">
								<CardTitle className="text-sm font-medium">
									Sharing Information
								</CardTitle>
							</CardHeader>
							<CardContent>
								<CardDescription className="text-xs">
									{currentScope === "PRIVATE" &&
										!hasPublicLink &&
										(isProjectFrame
											? "No additional sharing is enabled for this frame."
											: "This frame is completely private. Only you can access it.")}
									{currentScope === "EMAILS_ONLY" &&
										"You and the people you invite by email can access this frame."}
									{currentScope === "WORKSPACE_AND_EMAILS" &&
										"All organization members and invited emails can access this frame."}
									{currentScope === "PROJECT" &&
										"Accepted members of this frame's project can access it. Same-organization users who are not project members cannot."}
									{activePublicLink &&
										"Anyone with the link can view this frame without signing in."}
								</CardDescription>
								{isProjectFrame && (
									<p className="mt-2 text-xs text-muted-foreground">
										You and accepted project members,
										including project-scoped guests, retain
										access regardless of this sharing
										setting.
									</p>
								)}
							</CardContent>
						</Card>
					</div>
				)}
			</SheetContent>
		</Sheet>
	);
}
