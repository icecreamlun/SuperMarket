import { Worker } from "@notionhq/workers";
import {
	enrichGitHubActor,
	normalizeGitHubEvent,
	verifyGitHubSignature,
} from "./github";
import { writeInboundToNotion } from "./notion";
import { triage } from "./triage";
import { processEmailReceived } from "./handler/email";

const worker = new Worker();
export default worker;

worker.webhook("onEmailReceived", {
	title: "Email Received",
	description: "Receives email events from the user's inbox, normalizes them.",
	execute: async (events, { notion }) => {
		await Promise.all(events.map((event) => processEmailReceived(event, notion)));
	},
});

worker.webhook("onGithubEvent", {
	title: "GitHub Inbound — Triage Sidekick",
	description:
		"Receives GitHub star / issues / fork events, classifies them, and writes a workspace page into the Notion intake DB.",
	execute: async (events, { notion }) => {
		for (const event of events) {
			verifyGitHubSignature(event.rawBody, event.headers);

			const githubEvent = event.headers["x-github-event"];
			if (!githubEvent || githubEvent === "ping") {
				console.log(`Skipping non-actionable event: ${githubEvent}`);
				continue;
			}

			const inbound = normalizeGitHubEvent(
				event.deliveryId,
				githubEvent,
				event.body as Parameters<typeof normalizeGitHubEvent>[2],
			);
			if (!inbound) {
				console.log(
					`Skipping ${githubEvent} (action not actionable for inbound triage)`,
				);
				continue;
			}

			const enrichment = inbound.contact.handle
				? await enrichGitHubActor(inbound.contact.handle).catch((err) => {
					console.warn("GitHub enrichment failed:", err);
					return null;
				})
				: null;
			inbound.enrichment = enrichment ?? undefined;
			if (enrichment) {
				inbound.contact.name = enrichment.name ?? inbound.contact.name;
				inbound.contact.company =
					enrichment.company ?? inbound.contact.company;
				inbound.contact.email = enrichment.email ?? inbound.contact.email;
			}

			const result = await triage(inbound, enrichment);

			const { pageUrl } = await writeInboundToNotion(
				notion,
				inbound,
				result,
				enrichment,
			);

			console.log(
				`[${inbound.deliveryId}] ${inbound.source} → ${result.type}/${result.priority} (${result.confidence}) → ${pageUrl}`,
			);
		}
	},
});
