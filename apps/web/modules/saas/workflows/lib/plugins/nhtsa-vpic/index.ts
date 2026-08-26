/**
 * NHTSA VPIC Integration Plugin
 *
 * US vehicle data — VIN decoding, manufacturers, makes, and models.
 * Public API, no authentication required.
 */

import { registerIntegration } from "../registry";
import type { IntegrationPlugin } from "../types";
import { NhtsaVpicIcon } from "./icon";

const nhtsaVpicPlugin: IntegrationPlugin = {
	type: "NHTSA_VPIC",
	category: "knowledge",
	label: "NHTSA Vehicle Data",
	description:
		"US vehicle data — VIN decoding, manufacturers, makes, and models",
	icon: NhtsaVpicIcon,
	color: "text-blue-600",

	// No credentials needed — public API
	formFields: [],

	testConfig: {
		getTestFunction: async () => {
			const { testNhtsaVpicConnection } = await import("./test");
			return testNhtsaVpicConnection;
		},
	},

	actions: [
		{
			slug: "decode-vin",
			label: "Decode VIN",
			description:
				"Decode a Vehicle Identification Number (VIN) to get make, model, year, and more",
			category: "Vehicle Data",
			outputFields: [
				{ field: "vin", description: "The decoded VIN" },
				{
					field: "results",
					description: "Decoded vehicle information",
				},
			],
			outputConfig: { type: "json", field: "results" },
			configFields: [
				{
					key: "vin",
					label: "VIN",
					type: "template-input",
					required: true,
					placeholder: "17-character VIN or {{NodeName.vin}}",
				},
				{
					key: "modelYear",
					label: "Model Year (Optional)",
					type: "template-input",
					placeholder: "e.g., 2020",
					description: "Helps improve accuracy for pre-1981 VINs",
				},
			],
		},
		{
			slug: "decode-vin-batch",
			label: "Decode VIN Batch",
			description: "Decode multiple VINs at once (max 50)",
			category: "Vehicle Data",
			outputFields: [
				{ field: "results", description: "Array of decoded vehicles" },
				{ field: "count", description: "Number of results" },
			],
			outputConfig: { type: "json", field: "results" },
			configFields: [
				{
					key: "vins",
					label: "VINs (semicolon-separated)",
					type: "template-textarea",
					required: true,
					placeholder: "VIN1;VIN2;VIN3",
					rows: 3,
				},
			],
		},
		{
			slug: "decode-wmi",
			label: "Decode WMI",
			description:
				"Decode a World Manufacturer Identifier (first 3 or 6 chars of VIN)",
			category: "Vehicle Data",
			outputFields: [
				{ field: "wmi", description: "The decoded WMI" },
				{ field: "results", description: "Manufacturer information" },
			],
			outputConfig: { type: "json", field: "results" },
			configFields: [
				{
					key: "wmi",
					label: "WMI",
					type: "template-input",
					required: true,
					placeholder: "3 or 6 character WMI code",
				},
			],
		},
		{
			slug: "get-all-manufacturers",
			label: "Get All Manufacturers",
			description: "List all vehicle manufacturers",
			category: "Manufacturers",
			outputFields: [
				{
					field: "manufacturers",
					description: "List of manufacturers",
				},
				{ field: "count", description: "Number of results" },
			],
			outputConfig: { type: "json", field: "manufacturers" },
			configFields: [
				{
					key: "page",
					label: "Page Number",
					type: "number",
					placeholder: "1",
				},
				{
					key: "manufacturerType",
					label: "Manufacturer Type",
					type: "template-input",
					placeholder: "e.g., Intermediate",
				},
			],
		},
		{
			slug: "get-manufacturer-details",
			label: "Get Manufacturer Details",
			description:
				"Get detailed information about a specific manufacturer",
			category: "Manufacturers",
			outputFields: [
				{ field: "details", description: "Manufacturer details" },
			],
			outputConfig: { type: "json", field: "details" },
			configFields: [
				{
					key: "manufacturer",
					label: "Manufacturer",
					type: "template-input",
					required: true,
					placeholder: "Name or ID, e.g., Honda or 988",
				},
			],
		},
		{
			slug: "get-all-makes",
			label: "Get All Makes",
			description: "List all vehicle makes",
			category: "Makes & Models",
			outputFields: [
				{ field: "makes", description: "List of vehicle makes" },
				{ field: "count", description: "Number of results" },
			],
			outputConfig: { type: "json", field: "makes" },
			configFields: [],
		},
		{
			slug: "get-models-for-make",
			label: "Get Models for Make",
			description: "List all models for a specific vehicle make",
			category: "Makes & Models",
			outputFields: [
				{
					field: "models",
					description: "List of models for the make",
				},
				{ field: "count", description: "Number of results" },
			],
			outputConfig: { type: "json", field: "models" },
			configFields: [
				{
					key: "make",
					label: "Make",
					type: "template-input",
					required: true,
					placeholder: "e.g., Honda or {{NodeName.make}}",
				},
			],
		},
		{
			slug: "get-models-for-make-year",
			label: "Get Models for Make & Year",
			description:
				"List models for a make filtered by year and vehicle type",
			category: "Makes & Models",
			outputFields: [
				{
					field: "models",
					description: "List of models matching criteria",
				},
				{ field: "count", description: "Number of results" },
			],
			outputConfig: { type: "json", field: "models" },
			configFields: [
				{
					key: "make",
					label: "Make",
					type: "template-input",
					required: true,
					placeholder: "e.g., Honda",
				},
				{
					key: "year",
					label: "Model Year",
					type: "template-input",
					required: true,
					placeholder: "e.g., 2024",
				},
				{
					key: "vehicleType",
					label: "Vehicle Type (Optional)",
					type: "template-input",
					placeholder: "e.g., Truck, Motorcycle",
				},
			],
		},
		{
			slug: "get-vehicle-types-for-make",
			label: "Get Vehicle Types for Make",
			description: "Get the vehicle types produced by a specific make",
			category: "Makes & Models",
			outputFields: [
				{
					field: "vehicleTypes",
					description: "Vehicle types for the make",
				},
				{ field: "count", description: "Number of results" },
			],
			outputConfig: { type: "json", field: "vehicleTypes" },
			configFields: [
				{
					key: "make",
					label: "Make",
					type: "template-input",
					required: true,
					placeholder: "e.g., Honda or {{NodeName.make}}",
				},
			],
		},
	],
};

// Auto-register the plugin
registerIntegration(nhtsaVpicPlugin);
