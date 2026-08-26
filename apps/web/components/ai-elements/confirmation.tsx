"use client";

import { Alert, AlertDescription, AlertTitle } from "@ui/components/alert";
import { Button } from "@ui/components/button";
import { cn } from "@ui/lib";
import { AlertCircleIcon, CheckCircle2Icon, XCircleIcon } from "lucide-react";
import {
	type ComponentProps,
	createContext,
	type ReactNode,
	useContext,
} from "react";

// Custom approval state types for Fabric
type ApprovalState = "requested" | "accepted" | "rejected" | "pending";

// Context for confirmation state
interface ConfirmationContextValue {
	approvalState?: ApprovalState;
}

const ConfirmationContext = createContext<ConfirmationContextValue>({
	approvalState: "requested",
});

function useConfirmationContext() {
	const context = useContext(ConfirmationContext);
	if (!context) {
		throw new Error(
			"Confirmation components must be used within a Confirmation provider",
		);
	}
	return context;
}

// Main Confirmation component
export type ConfirmationProps = ComponentProps<typeof Alert> & {
	approvalState?: ApprovalState;
};

export const Confirmation = ({
	approvalState = "requested",
	className,
	children,
	...props
}: ConfirmationProps) => {
	const isRequested = approvalState === "requested";
	const isAccepted = approvalState === "accepted";
	const isRejected = approvalState === "rejected";

	return (
		<ConfirmationContext.Provider value={{ approvalState }}>
			<Alert
				className={cn(
					"relative",
					isRequested && "border-amber-500/50 bg-amber-500/10",
					isAccepted && "border-green-500/50 bg-green-500/10",
					isRejected && "border-red-500/50 bg-red-500/10",
					className,
				)}
				{...props}
			>
				{children}
			</Alert>
		</ConfirmationContext.Provider>
	);
};

// Confirmation icon based on state
export const ConfirmationIcon = ({ className }: { className?: string }) => {
	const { approvalState } = useConfirmationContext();

	if (approvalState === "requested") {
		return (
			<AlertCircleIcon
				className={cn("h-5 w-5 text-amber-500", className)}
			/>
		);
	}
	if (approvalState === "accepted") {
		return (
			<CheckCircle2Icon
				className={cn("h-5 w-5 text-green-500", className)}
			/>
		);
	}
	if (approvalState === "rejected") {
		return (
			<XCircleIcon className={cn("h-5 w-5 text-red-500", className)} />
		);
	}
	return null;
};

// Content shown when approval is requested
export const ConfirmationRequest = ({
	children,
	className,
}: {
	children: ReactNode;
	className?: string;
}) => {
	const { approvalState } = useConfirmationContext();
	if (approvalState !== "requested") {
		return null;
	}
	return <div className={className}>{children}</div>;
};

// Actions container
export const ConfirmationActions = ({
	className,
	...props
}: ComponentProps<"div">) => (
	<div className={cn("flex items-center gap-2 mt-3", className)} {...props} />
);

// Individual action button
export const ConfirmationAction = ({
	className,
	variant = "outline",
	size = "sm",
	...props
}: ComponentProps<typeof Button>) => (
	<Button className={className} variant={variant} size={size} {...props} />
);

// Title for confirmation
export const ConfirmationTitle = ({
	className,
	...props
}: ComponentProps<typeof AlertTitle>) => (
	<AlertTitle
		className={cn("flex items-center gap-2", className)}
		{...props}
	/>
);

// Description for confirmation
export const ConfirmationDescription = ({
	className,
	...props
}: ComponentProps<typeof AlertDescription>) => (
	<AlertDescription className={className} {...props} />
);
