"use client";

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
import { Check, Copy, Globe, Lock, Mail, Users, X } from "lucide-react";
import { useState } from "react";

interface ShareFrameSheetProps {
	frameId: string;
	organizationId?: string | null;
	open: boolean;
	onOpenChange: (open: boolean) => void;
}

type ShareScope = "PRIVATE" | "EMAILS_ONLY" | "WORKSPACE_AND_EMAILS" | "PUBLIC";

interface _SharingGrant {
	id: string;
	email: string | null;
	invitedBy: string;
	invitedAt: string;
	lastAccessedAt: string | null;
	accessCount: number;
}

const SCOPE_OPTIONS: {
	value: ShareScope;
	label: string;
	description: string;
	icon: React.ReactNode;
}[] = [
	{
		value: "PRIVATE",
		label: "Private",
		description: "Only you can access this frame",
		icon: <Lock className="h-4 w-4" />,
	},
	{
		value: "EMAILS_ONLY",
		label: "Email invites only",
		description: "Only people you invite by email can view",
		icon: <Mail className="h-4 w-4" />,
	},
	{
		value: "WORKSPACE_AND_EMAILS",
		label: "Workspace members and email invites",
		description: "Organization members plus invited emails",
		icon: <Users className="h-4 w-4" />,
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
	open,
	onOpenChange,
}: ShareFrameSheetProps) {
	const { toast } = useToast();
	const queryClient = useQueryClient();
	const [emailInput, setEmailInput] = useState("");
	const [copied, setCopied] = useState(false);

	// Fetch grants and current scope
	const { data: grantsData, isLoading: _isLoadingGrants } = useQuery({
		queryKey: ["frame", "grants", frameId],
		queryFn: () =>
			orpcClient.frames.listGrants({
				id: frameId,
				organizationId: organizationId ?? null,
			}),
		enabled: open,
	});

	// Share mutation
	const shareMutation = useMutation({
		mutationFn: (shareScope: ShareScope) =>
			orpcClient.frames.share({
				id: frameId,
				organizationId: organizationId ?? null,
				shareScope,
			}),
		onSuccess: () => {
			queryClient.invalidateQueries({
				queryKey: ["frame", "grants", frameId],
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
			}),
		onSuccess: () => {
			setEmailInput("");
			queryClient.invalidateQueries({
				queryKey: ["frame", "grants", frameId],
			});
			toast({ title: "Invitations sent" });
		},
		onError: (error: any) => {
			toast({
				title: "Failed to send invitations",
				description: error?.message,
				variant: "destructive",
			});
		},
	});

	// Revoke mutation
	const revokeMutation = useMutation({
		mutationFn: (email: string) =>
			orpcClient.frames.revokeInvite({
				id: frameId,
				organizationId: organizationId ?? null,
				email,
			}),
		onSuccess: () => {
			queryClient.invalidateQueries({
				queryKey: ["frame", "grants", frameId],
			});
			toast({ title: "Access revoked" });
		},
	});

	const currentScope = grantsData?.shareScope ?? "PRIVATE";
	const grants = grantsData?.grants ?? [];

	const handleCopyLink = async () => {
		// Get share URL from the frame data or construct it
		const shareUrl = `${window.location.origin}/share/frame/${frameId}`;
		await navigator.clipboard.writeText(shareUrl);
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
		currentScope === "WORKSPACE_AND_EMAILS";

	return (
		<Sheet open={open} onOpenChange={onOpenChange}>
			<SheetContent className="w-full sm:max-w-lg overflow-y-auto">
				<SheetHeader>
					<SheetTitle>Share Frame</SheetTitle>
					<SheetDescription>
						Choose who can access this frame
					</SheetDescription>
				</SheetHeader>

				<div className="space-y-6 py-6">
					{/* Scope Selection */}
					<div className="space-y-4">
						<Label>Access Level</Label>
						<RadioGroup
							value={currentScope}
							onValueChange={(value) =>
								shareMutation.mutate(value as ShareScope)
							}
							className="space-y-3"
						>
							{SCOPE_OPTIONS.map((option) => (
								<div
									key={option.value}
									className="flex items-start space-x-3"
								>
									<RadioGroupItem
										value={option.value}
										id={option.value}
										className="mt-1"
									/>
									<div className="flex-1">
										<Label
											htmlFor={option.value}
											className="flex items-center gap-2 font-medium cursor-pointer"
										>
											{option.icon}
											{option.label}
										</Label>
										<p className="text-sm text-muted-foreground mt-1">
											{option.description}
										</p>
									</div>
								</div>
							))}
						</RadioGroup>
					</div>

					{/* Share Link (for PUBLIC) */}
					{currentScope === "PUBLIC" && (
						<div className="space-y-2">
							<Label>Share Link</Label>
							<div className="flex gap-2">
								<Input
									value={`${window.location.origin}/share/frame/${frameId}`}
									readOnly
									className="flex-1"
								/>
								<Button
									variant="outline"
									size="icon"
									onClick={handleCopyLink}
								>
									{copied ? (
										<Check className="h-4 w-4" />
									) : (
										<Copy className="h-4 w-4" />
									)}
								</Button>
							</div>
						</div>
					)}

					{/* Email Invites */}
					{showEmailSection && (
						<div className="space-y-4">
							<div className="space-y-2">
								<Label>Invite by Email</Label>
								<div className="flex gap-2">
									<Input
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
										disabled={inviteMutation.isPending}
									>
										{inviteMutation.isPending
											? "Adding..."
											: "Add"}
									</Button>
								</div>
							</div>

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
													onClick={() =>
														grant.email &&
														revokeMutation.mutate(
															grant.email,
														)
													}
													disabled={
														revokeMutation.isPending
													}
												>
													<X className="h-4 w-4" />
												</Button>
											</div>
										))}
									</div>
								</div>
							)}
						</div>
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
									"This frame is completely private. Only you can access it."}
								{currentScope === "EMAILS_ONLY" &&
									"Only the people you invite by email will be able to access this frame."}
								{currentScope === "WORKSPACE_AND_EMAILS" &&
									"All organization members and invited emails can access this frame."}
								{currentScope === "PUBLIC" &&
									"Anyone with the link can view this frame without signing in."}
							</CardDescription>
						</CardContent>
					</Card>
				</div>
			</SheetContent>
		</Sheet>
	);
}
