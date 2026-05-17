import type { Client } from "@notionhq/client";
import type {
	GitHubEnrichment,
	InboundEvent,
	TriageResult,
} from "./types";

const SELECT_OPTIONS = {
	source: [
		"github-star",
		"github-issue",
		"github-fork",
		"slack-dm",
		"slack-command",
		"gmail",
	],
	type: ["partnership", "enterprise-demo", "dev-user", "unclear"],
	priority: ["high", "medium", "low"],
	status: ["new", "review", "routed", "in-progress"],
};

function richText(text: string) {
	return [{ type: "text" as const, text: { content: text.slice(0, 2000) } }];
}

function bucketConfidence(score: number): "high" | "medium" | "low" {
	if (score >= 80) return "high";
	if (score >= 50) return "medium";
	return "low";
}

function heading(text: string) {
	return {
		object: "block" as const,
		type: "heading_2" as const,
		heading_2: { rich_text: richText(text) },
	};
}

function paragraph(text: string) {
	return {
		object: "block" as const,
		type: "paragraph" as const,
		paragraph: { rich_text: richText(text) },
	};
}

function bulletItem(text: string) {
	return {
		object: "block" as const,
		type: "bulleted_list_item" as const,
		bulleted_list_item: { rich_text: richText(text) },
	};
}

function codeBlock(text: string, language = "json") {
	return {
		object: "block" as const,
		type: "code" as const,
		code: {
			rich_text: richText(text),
			language: language as "json",
		},
	};
}

export async function writeInboundToNotion(
	notion: Client,
	event: InboundEvent,
	triage: TriageResult,
	enrichment?: GitHubEnrichment | null,
): Promise<{ pageId: string; pageUrl: string }> {
	const databaseId = process.env.INTAKE_DATABASE_ID;
	if (!databaseId) {
		throw new Error("INTAKE_DATABASE_ID not configured");
	}

	const company =
		enrichment?.company ?? event.contact.company ?? event.contact.handle;
	const title = `${triage.type} – ${company ?? event.contact.handle ?? "unknown"}`;

	const properties: Record<string, unknown> = {
		Title: { title: richText(title) },
		Source: { select: { name: event.source } },
		"Opportunity Type": { select: { name: triage.type } },
		Priority: { select: { name: triage.priority } },
		Confidence: { select: { name: bucketConfidence(triage.confidence) } },
		Status: {
			select: { name: triage.priority === "low" ? "review" : "new" },
		},
		"Suggested Owner": { rich_text: richText(triage.suggestedOwner) },
		Summary: { rich_text: richText(triage.summary) },
		"Recommended Motion": { rich_text: richText(triage.recommendedMotion) },
	};

	if (company) properties.Company = { rich_text: richText(company) };
	if (enrichment?.name)
		properties["Contact Name"] = { rich_text: richText(enrichment.name) };
	if (enrichment?.email)
		properties["Contact Email"] = { email: enrichment.email };
	if (event.contact.handle)
		properties["GitHub Username"] = {
			rich_text: richText(event.contact.handle),
		};

	const children = buildWorkspaceBlocks(event, triage, enrichment);

	const created = await notion.pages.create({
		parent: { database_id: databaseId },
		properties: properties as never,
		children: children as never,
	});

	return {
		pageId: created.id,
		pageUrl: (created as { url?: string }).url ?? "",
	};
}

function buildWorkspaceBlocks(
	event: InboundEvent,
	triage: TriageResult,
	enrichment?: GitHubEnrichment | null,
) {
	const blocks: unknown[] = [];

	blocks.push(heading("Overview"));
	blocks.push(
		bulletItem(`Type: ${triage.type} — ${triage.whyType}`),
		bulletItem(`Priority: ${triage.priority} — ${triage.whyPriority}`),
		bulletItem(`Confidence: ${triage.confidence}/100`),
		bulletItem(`Source: ${event.source}`),
		bulletItem(`Suggested owner: ${triage.suggestedOwner}`),
	);

	blocks.push(heading("Raw inbound"));
	blocks.push(paragraph(event.content.title));
	if (event.content.body) blocks.push(paragraph(event.content.body));
	if (event.content.url) blocks.push(paragraph(`Link: ${event.content.url}`));

	blocks.push(heading("Extracted context"));
	blocks.push(paragraph(triage.summary));
	if (enrichment) {
		blocks.push(
			bulletItem(
				`GitHub: @${enrichment.login}${
					enrichment.name ? ` (${enrichment.name})` : ""
				}`,
			),
		);
		if (enrichment.company)
			blocks.push(bulletItem(`Company: ${enrichment.company}`));
		if (enrichment.email)
			blocks.push(bulletItem(`Email: ${enrichment.email}`));
		if (enrichment.location)
			blocks.push(bulletItem(`Location: ${enrichment.location}`));
		if (enrichment.inferredTechStack.length)
			blocks.push(
				bulletItem(
					`Inferred tech stack: ${enrichment.inferredTechStack.join(", ")}`,
				),
			);
		if (enrichment.topRepos?.length)
			blocks.push(
				bulletItem(
					`Top repos: ${enrichment.topRepos
						.map((r) => `${r.name} (★${r.stars})`)
						.join(", ")}`,
				),
			);
	}
	if (triage.missingInfo.length) {
		blocks.push(heading("Missing info"));
		for (const m of triage.missingInfo) blocks.push(bulletItem(m));
	}

	blocks.push(heading("Recommended next step"));
	blocks.push(paragraph(triage.recommendedMotion));

	if (triage.draftResponse) {
		blocks.push(heading("Draft response"));
		blocks.push(paragraph(triage.draftResponse));
	}

	blocks.push(heading("Action log"));
	blocks.push(
		bulletItem(`${event.receivedAt} — inbound received (${event.source})`),
		bulletItem(`${new Date().toISOString()} — workspace created`),
	);

	blocks.push(heading("Raw payload"));
	blocks.push(codeBlock(JSON.stringify(event.raw, null, 2)));

	return blocks;
}

export { SELECT_OPTIONS };
