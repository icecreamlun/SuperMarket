import type { Client } from "@notionhq/client";
import { writeInboundToNotion } from "./notion";
import type {
	InboundEvent,
	InboundSource,
	OpportunityType,
	Priority,
	TriageResult,
} from "./types";

interface NotionPage {
	id: string;
	url?: string;
	properties: Record<string, NotionProperty>;
}

interface NotionProperty {
	type?: string;
	title?: Array<{ plain_text?: string }>;
	rich_text?: Array<{ plain_text?: string }>;
	select?: { name?: string } | null;
	multi_select?: Array<{ name?: string }>;
	number?: number;
	checkbox?: boolean;
	url?: string;
	email?: string;
	date?: { start?: string };
}

interface QueryResult {
	results: NotionPage[];
}

async function queryDataSource(
	_notion: Client,
	dataSourceId: string,
	body: Record<string, unknown>,
): Promise<QueryResult> {
	const token = process.env.NOTION_API_TOKEN;
	if (!token) throw new Error("NOTION_API_TOKEN not configured");
	const res = await fetch(
		`https://api.notion.com/v1/data_sources/${dataSourceId}/query`,
		{
			method: "POST",
			headers: {
				Authorization: `Bearer ${token}`,
				"Notion-Version": "2025-09-03",
				"Content-Type": "application/json",
			},
			body: JSON.stringify(body),
		},
	);
	if (!res.ok) {
		const text = await res.text();
		throw new Error(
			`data_sources/${dataSourceId}/query failed (${res.status}): ${text.slice(0, 200)}`,
		);
	}
	return (await res.json()) as QueryResult;
}

function textOf(prop: NotionProperty | undefined): string {
	if (!prop) return "";
	if (prop.title?.length) return prop.title.map((t) => t.plain_text ?? "").join("");
	if (prop.rich_text?.length) return prop.rich_text.map((t) => t.plain_text ?? "").join("");
	if (prop.select?.name) return prop.select.name;
	if (typeof prop.number === "number") return String(prop.number);
	if (typeof prop.checkbox === "boolean") return prop.checkbox ? "yes" : "no";
	if (prop.url) return prop.url;
	if (prop.email) return prop.email;
	if (prop.date?.start) return prop.date.start;
	return "";
}

function numberOf(prop: NotionProperty | undefined): number | null {
	return typeof prop?.number === "number" ? prop.number : null;
}

function selectOf(prop: NotionProperty | undefined): string | null {
	return prop?.select?.name ?? null;
}

const PRIORITY_RANK: Record<Priority, number> = {
	high: 3,
	medium: 2,
	low: 1,
};

export interface InboxRow {
	pageUrl: string;
	title: string;
	type: string;
	priority: string;
	confidence: number | null;
	source: string;
	owner: string;
	company: string;
	summary: string;
	recommendedMotion: string;
}

export async function queryInbox(
	notion: Client,
	opts: {
		type?: OpportunityType;
		priority?: Priority;
		sinceDays?: number;
		limit?: number;
	},
): Promise<InboxRow[]> {
	const dataSourceId = process.env.INTAKE_DATA_SOURCE_ID;
	if (!dataSourceId) throw new Error("INTAKE_DATA_SOURCE_ID not configured");

	const filters: Record<string, unknown>[] = [];
	if (opts.type) {
		filters.push({
			property: "Opportunity Type",
			select: { equals: opts.type },
		});
	}
	if (opts.priority) {
		filters.push({ property: "Priority", select: { equals: opts.priority } });
	}

	const body: Record<string, unknown> = {
		page_size: opts.limit ?? 20,
		sorts: [{ timestamp: "created_time", direction: "descending" }],
	};
	if (filters.length === 1) body.filter = filters[0];
	else if (filters.length > 1) body.filter = { and: filters };

	const data = await queryDataSource(notion, dataSourceId, body);

	const rows = data.results.map((page) => ({
		pageUrl: page.url ?? "",
		title: textOf(page.properties.Title),
		type: selectOf(page.properties["Opportunity Type"]) ?? "unknown",
		priority: selectOf(page.properties.Priority) ?? "unknown",
		confidence: numberOf(page.properties.Confidence),
		source: selectOf(page.properties.Source) ?? "unknown",
		owner: textOf(page.properties["Suggested Owner"]),
		company: textOf(page.properties.Company),
		summary: textOf(page.properties.Summary),
		recommendedMotion: textOf(page.properties["Recommended Motion"]),
	}));

	rows.sort((a, b) => {
		const pa = PRIORITY_RANK[(a.priority as Priority) ?? "low"] ?? 0;
		const pb = PRIORITY_RANK[(b.priority as Priority) ?? "low"] ?? 0;
		if (pa !== pb) return pb - pa;
		return (b.confidence ?? 0) - (a.confidence ?? 0);
	});

	return rows;
}

export interface RadarRow {
	pageUrl: string;
	tweetId: string;
	author: string;
	authorFollowers: number | null;
	verified: boolean;
	content: string;
	url: string;
	matchedQuery: string;
	type: string;
	priority: string;
	confidence: number | null;
	summary: string;
	recommendedMotion: string;
	suggestedOwner: string;
	promotedToInbox: boolean;
}

export async function queryRadar(
	notion: Client,
	opts: {
		type?: string;
		priority?: Priority;
		minConfidence?: number;
		promotedOnly?: boolean;
		limit?: number;
	},
): Promise<RadarRow[]> {
	const dataSourceId = process.env.MARKET_SIGNALS_DATA_SOURCE_ID;
	if (!dataSourceId)
		throw new Error("MARKET_SIGNALS_DATA_SOURCE_ID not configured");

	const filters: Record<string, unknown>[] = [];
	if (opts.type) {
		filters.push({ property: "Type", select: { equals: opts.type } });
	}
	if (opts.priority) {
		filters.push({ property: "Priority", select: { equals: opts.priority } });
	}
	if (opts.minConfidence !== undefined) {
		filters.push({
			property: "Confidence",
			number: { greater_than_or_equal_to: opts.minConfidence },
		});
	}
	if (opts.promotedOnly) {
		filters.push({
			property: "Promoted to Inbox",
			checkbox: { equals: true },
		});
	}

	const body: Record<string, unknown> = {
		page_size: opts.limit ?? 25,
		sorts: [{ property: "Confidence", direction: "descending" }],
	};
	if (filters.length === 1) body.filter = filters[0];
	else if (filters.length > 1) body.filter = { and: filters };

	const data = await queryDataSource(notion, dataSourceId, body);

	return data.results.map((page) => ({
		pageUrl: page.url ?? "",
		tweetId: textOf(page.properties["Tweet ID"]),
		author: textOf(page.properties.Author),
		authorFollowers: numberOf(page.properties["Author Followers"]),
		verified: page.properties.Verified?.checkbox ?? false,
		content: textOf(page.properties.Content),
		url: textOf(page.properties.URL),
		matchedQuery: textOf(page.properties["Matched Query"]),
		type: selectOf(page.properties.Type) ?? "unknown",
		priority: selectOf(page.properties.Priority) ?? "unknown",
		confidence: numberOf(page.properties.Confidence),
		summary: textOf(page.properties.Summary),
		recommendedMotion: textOf(page.properties["Recommended Motion"]),
		suggestedOwner: textOf(page.properties["Suggested Owner"]),
		promotedToInbox: page.properties["Promoted to Inbox"]?.checkbox ?? false,
	}));
}

export async function promoteSignal(
	notion: Client,
	tweetId: string,
): Promise<{ opportunityUrl: string; alreadyPromoted: boolean }> {
	const dataSourceId = process.env.MARKET_SIGNALS_DATA_SOURCE_ID;
	if (!dataSourceId)
		throw new Error("MARKET_SIGNALS_DATA_SOURCE_ID not configured");

	const data = await queryDataSource(notion, dataSourceId, {
		filter: { property: "Tweet ID", rich_text: { equals: tweetId } },
		page_size: 1,
	});
	if (data.results.length === 0)
		throw new Error(`No Market Signal found with Tweet ID ${tweetId}`);
	const page = data.results[0];

	const alreadyPromoted =
		page.properties["Promoted to Inbox"]?.checkbox ?? false;

	const author = textOf(page.properties.Author);
	const handleMatch = author.match(/@([\w_]+)/);
	const handle = handleMatch ? `@${handleMatch[1]}` : author;
	const name = handleMatch ? author.replace(/\s*\(@[\w_]+\)\s*/, "") : author;

	const inbound: InboundEvent = {
		deliveryId: `promote-${tweetId}`,
		source: (selectOf(page.properties.Source) as InboundSource) ?? "x-brand",
		receivedAt: textOf(page.properties["Tweet Created At"]) || new Date().toISOString(),
		contact: {
			handle,
			name: name || undefined,
			profileUrl: handleMatch
				? `https://x.com/${handleMatch[1]}`
				: undefined,
		},
		content: {
			title: textOf(page.properties.Title).replace(/^\[[^\]]+\]\s*/, ""),
			body: textOf(page.properties.Content),
			url: textOf(page.properties.URL),
		},
		raw: { promotedFromTweet: tweetId, matchedQuery: textOf(page.properties["Matched Query"]) },
	};

	const triage: TriageResult = {
		type:
			(selectOf(page.properties.Type) as OpportunityType) ?? "lead-signal",
		priority: (selectOf(page.properties.Priority) as Priority) ?? "medium",
		confidence: numberOf(page.properties.Confidence) ?? 70,
		summary: textOf(page.properties.Summary),
		whyType: `Promoted from X Market Radar (matched query: ${textOf(page.properties["Matched Query"])})`,
		whyPriority: `Confidence ${numberOf(page.properties.Confidence) ?? "?"}, author followers ${numberOf(page.properties["Author Followers"]) ?? "?"}`,
		missingInfo: [],
		recommendedMotion: textOf(page.properties["Recommended Motion"]),
		suggestedOwner: textOf(page.properties["Suggested Owner"]),
		draftResponse: "",
	};

	const { pageUrl } = await writeInboundToNotion(notion, inbound, triage);

	return { opportunityUrl: pageUrl, alreadyPromoted };
}
