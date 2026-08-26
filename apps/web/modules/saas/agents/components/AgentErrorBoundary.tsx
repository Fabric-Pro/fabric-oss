"use client";

import { AlertCircle, RefreshCw } from "lucide-react";
import { Component, type ReactNode } from "react";

interface Props {
	children: ReactNode;
	fallback?: ReactNode;
}

interface State {
	hasError: boolean;
	error: Error | null;
	errorInfo: string | null;
}

/**
 * Error Boundary for Agent Components
 *
 * Catches errors in agent components and displays a user-friendly error message
 * with the option to retry.
 */
export class AgentErrorBoundary extends Component<Props, State> {
	constructor(props: Props) {
		super(props);
		this.state = {
			hasError: false,
			error: null,
			errorInfo: null,
		};
	}

	static getDerivedStateFromError(error: Error): State {
		return {
			hasError: true,
			error,
			errorInfo: error.message,
		};
	}

	componentDidCatch(error: Error, errorInfo: React.ErrorInfo) {
		console.error("[AgentErrorBoundary] Error caught:", {
			error,
			errorInfo,
			componentStack: errorInfo.componentStack,
		});
	}

	handleReset = () => {
		this.setState({
			hasError: false,
			error: null,
			errorInfo: null,
		});
		// Reload the page to reset the agent state
		window.location.reload();
	};

	render() {
		if (this.state.hasError) {
			if (this.props.fallback) {
				return this.props.fallback;
			}

			return (
				<div className="flex items-center justify-center min-h-screen p-4">
					<div className="max-w-md w-full bg-card border border-destructive/20 rounded-lg p-6 shadow-lg">
						<div className="flex items-start gap-4">
							<div className="shrink-0">
								<AlertCircle className="h-6 w-6 text-destructive" />
							</div>
							<div className="flex-1">
								<h2 className="text-lg font-semibold text-foreground mb-2">
									Something went wrong
								</h2>
								<p className="text-sm text-muted-foreground mb-4">
									The agent encountered an error and couldn't
									complete the operation.
								</p>
								{this.state.errorInfo && (
									<div className="bg-muted/50 rounded p-3 mb-4">
										<p className="text-xs font-mono text-muted-foreground break-all">
											{this.state.errorInfo}
										</p>
									</div>
								)}
								<button
									type="button"
									onClick={this.handleReset}
									className="inline-flex items-center gap-2 px-4 py-2 bg-primary text-primary-foreground rounded-md hover:bg-primary/90 transition-colors text-sm font-medium"
								>
									<RefreshCw className="h-4 w-4" />
									Try Again
								</button>
							</div>
						</div>
					</div>
				</div>
			);
		}

		return this.props.children;
	}
}
