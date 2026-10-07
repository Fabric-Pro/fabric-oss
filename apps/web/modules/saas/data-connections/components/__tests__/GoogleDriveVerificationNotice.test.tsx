import { render, screen } from "@testing-library/react";
import { describe, expect, it } from "vitest";
import { GoogleDriveVerificationNotice } from "../GoogleDriveVerificationNotice";

describe("GoogleDriveVerificationNotice", () => {
	it("renders the verification requirement warning copy", () => {
		render(<GoogleDriveVerificationNotice />);

		expect(
			screen.getByText(
				"Google Drive access requires Google verification",
			),
		).toBeInTheDocument();
		expect(
			screen.getByText(
				"To use Google Drive with Fabric, you must first complete Google’s verification process.",
			),
		).toBeInTheDocument();
	});

	it("has status role and accessible label for assistive tech", () => {
		render(<GoogleDriveVerificationNotice />);

		expect(
			screen.getByRole("status", {
				name: "Google Drive verification notice",
			}),
		).toBeInTheDocument();
	});
});
