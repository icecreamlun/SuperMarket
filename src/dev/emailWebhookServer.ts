import { Client } from "@notionhq/client";
import express from "express";
import { createOnEmailReceivedRouter } from "../webhooks/onEmailReceived.js";

const port = Number(process.env.EMAIL_WEBHOOK_PORT ?? 3001);
const token = process.env.NOTION_API_TOKEN;

if (!token) {
	console.error(
		"NOTION_API_TOKEN is not set. Add it to .env before starting the dev server.",
	);
	process.exit(1);
}

const notion = new Client({ auth: token });
const app = express();

app.use("/onEmailReceived", createOnEmailReceivedRouter(notion));

app.listen(port, () => {
	console.log(
		`Email webhook dev server listening at http://localhost:${port}/onEmailReceived`,
	);
	console.log("Test with: npm run test:email-webhook");
});
