/**
 * MCP Delete Dialogs
 *
 * Confirmation dialogs for deleting MCP configurations and servers.
 */

import {
	AlertDialog,
	AlertDialogAction,
	AlertDialogCancel,
	AlertDialogContent,
	AlertDialogDescription,
	AlertDialogFooter,
	AlertDialogHeader,
	AlertDialogTitle,
} from "@ui/components/alert-dialog";
import type { McpConfig, McpServer } from "../types";

export interface McpDeleteConfigDialogProps {
	open: boolean;
	onOpenChange: (open: boolean) => void;
	config: McpConfig | null;
	onConfirm: () => void;
}

export function McpDeleteConfigDialog({
	open,
	onOpenChange,
	config,
	onConfirm,
}: McpDeleteConfigDialogProps) {
	return (
		<AlertDialog open={open} onOpenChange={onOpenChange}>
			<AlertDialogContent>
				<AlertDialogHeader>
					<AlertDialogTitle>
						Delete MCP Configuration
					</AlertDialogTitle>
					<AlertDialogDescription>
						Are you sure you want to delete the configuration for "
						{config?.mcpServer?.name || config?.mcpServer?.key}"?
						This action cannot be undone.
					</AlertDialogDescription>
				</AlertDialogHeader>
				<AlertDialogFooter>
					<AlertDialogCancel>Cancel</AlertDialogCancel>
					<AlertDialogAction
						onClick={onConfirm}
						variant="destructive"
					>
						Delete
					</AlertDialogAction>
				</AlertDialogFooter>
			</AlertDialogContent>
		</AlertDialog>
	);
}

export interface McpDeleteServerDialogProps {
	open: boolean;
	onOpenChange: (open: boolean) => void;
	server: McpServer | null;
	onConfirm: () => void;
}

export function McpDeleteServerDialog({
	open,
	onOpenChange,
	server,
	onConfirm,
}: McpDeleteServerDialogProps) {
	return (
		<AlertDialog open={open} onOpenChange={onOpenChange}>
			<AlertDialogContent>
				<AlertDialogHeader>
					<AlertDialogTitle>
						Delete Custom MCP Server
					</AlertDialogTitle>
					<AlertDialogDescription>
						Are you sure you want to delete "
						{server?.name || server?.key}"? This will also delete
						all configurations using this server. This action cannot
						be undone.
					</AlertDialogDescription>
				</AlertDialogHeader>
				<AlertDialogFooter>
					<AlertDialogCancel>Cancel</AlertDialogCancel>
					<AlertDialogAction
						onClick={onConfirm}
						variant="destructive"
					>
						Delete
					</AlertDialogAction>
				</AlertDialogFooter>
			</AlertDialogContent>
		</AlertDialog>
	);
}
