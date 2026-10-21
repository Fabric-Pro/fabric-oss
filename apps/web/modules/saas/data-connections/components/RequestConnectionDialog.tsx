"use client";

import { useOrganizationContext } from "@saas/organizations/hooks/use-organization-context";
import { orpcClient } from "@shared/lib/orpc-client";
import { useMutation } from "@tanstack/react-query";
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
import { Input } from "@ui/components/input";
import { Label } from "@ui/components/label";
import {
	Select,
	SelectContent,
	SelectItem,
	SelectTrigger,
	SelectValue,
} from "@ui/components/select";
import { Textarea } from "@ui/components/textarea";
import { useState } from "react";
import { toast } from "sonner";

type RequestType = "mcp" | "integration" | "unsure";

export function RequestConnectionDialog() {
	const { organizationId } = useOrganizationContext();
	const [open, setOpen] = useState(false);
	const [type, setType] = useState<RequestType | "">("");
	const [name, setName] = useState("");
	const [notes, setNotes] = useState("");

	const request = useMutation({
		mutationFn: async (requestType: RequestType) =>
			orpcClient.dataConnections.request({
				type: requestType,
				name: name.trim(),
				notes: notes.trim() || undefined,
				organizationId: organizationId ?? null,
			}),
		onSuccess: ({ mailto }) => {
			setOpen(false);
			setType("");
			setName("");
			setNotes("");
			if (mailto) {
				// Assign rather than window.open: a mailto goes to the OS mail
				// handler and the page stays put; window.open leaves a blank tab.
				window.location.href = mailto;
				toast.success("Opening your email app", {
					description: "Your request is ready to send.",
				});
			} else {
				toast.info(
					"Connection requests aren't set up on this Fabric deployment.",
				);
			}
		},
		onError: () => {
			toast.error("We couldn't prepare your request. Please try again.");
		},
	});

	const canSubmit = type !== "" && name.trim() !== "";

	return (
		<Dialog open={open} onOpenChange={setOpen}>
			<DialogTrigger asChild>
				<Button variant="outline">Request connection</Button>
			</DialogTrigger>
			<DialogContent>
				<DialogHeader>
					<DialogTitle>Request a connection</DialogTitle>
					<DialogDescription>
						Tell us which integration or MCP server you need. We'll
						open an email for you to send.
					</DialogDescription>
				</DialogHeader>
				<form
					className="space-y-5"
					onSubmit={(event) => {
						event.preventDefault();
						if (type !== "" && canSubmit) {
							request.mutate(type);
						}
					}}
				>
					<div className="space-y-3">
						<Label
							htmlFor="request-connection-type"
							className="text-base"
						>
							Type
						</Label>
						<Select
							value={type}
							onValueChange={(value) =>
								setType(value as RequestType)
							}
						>
							<SelectTrigger id="request-connection-type">
								<SelectValue placeholder="Select a type" />
							</SelectTrigger>
							<SelectContent>
								<SelectItem value="mcp">MCP</SelectItem>
								<SelectItem value="integration">
									Integrations
								</SelectItem>
								<SelectItem value="unsure">Not sure</SelectItem>
							</SelectContent>
						</Select>
					</div>
					<div className="space-y-3">
						<Label
							htmlFor="request-connection-name"
							className="text-base"
						>
							Integration or MCP server name
						</Label>
						<Input
							id="request-connection-name"
							value={name}
							onChange={(event) => setName(event.target.value)}
							maxLength={100}
							required
						/>
					</div>
					<div className="space-y-3">
						<Label
							htmlFor="request-connection-notes"
							className="text-base"
						>
							Notes (optional)
						</Label>
						<Textarea
							id="request-connection-notes"
							value={notes}
							onChange={(event) => setNotes(event.target.value)}
							maxLength={1000}
						/>
					</div>
					<DialogFooter>
						<Button
							type="button"
							variant="outline"
							onClick={() => setOpen(false)}
						>
							Cancel
						</Button>
						<Button
							type="submit"
							disabled={!canSubmit}
							loading={request.isPending}
						>
							Open email draft
						</Button>
					</DialogFooter>
				</form>
			</DialogContent>
		</Dialog>
	);
}
