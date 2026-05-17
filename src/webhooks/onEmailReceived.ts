import express, { type Router } from "express";
import type { Client } from "@notionhq/client";
import type { IncomingHttpHeaders } from "node:http";
import { processEmailReceived } from "../handler/email.js";

function normalizeHeaders(
	headers: IncomingHttpHeaders,
): Record<string, string> {
	const normalized: Record<string, string> = {};
	for (const [key, value] of Object.entries(headers)) {
		if (value === undefined) continue;
		normalized[key.toLowerCase()] = Array.isArray(value)
			? value.join(", ")
			: value;
	}
	return normalized;
}

export function createOnEmailReceivedRouter(notion: Client): Router {
	const router = express.Router();
	router.use(express.json({ limit: "1mb" }));

	router.post("/", async (req, res) => {
		const deliveryIdHeader = req.headers["x-delivery-id"];
		const deliveryId =
			(typeof deliveryIdHeader === "string" ? deliveryIdHeader : undefined) ??
			`local-${Date.now()}`;

		await processEmailReceived(
			{
				deliveryId,
				body: req.body as Record<string, unknown>,
				headers: normalizeHeaders(req.headers),
				method: req.method,
				rawBody: JSON.stringify(req.body),
			},
			notion,
		);

		res.sendStatus(202);
	});

	return router;
}
