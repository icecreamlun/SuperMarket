import * as Builder from "@notionhq/workers/builder";
import * as Schema from "@notionhq/workers/schema";
import { Worker } from "@notionhq/workers";
import type {
	InboundEvent,
	OpportunityType,
	Priority,
	TriageResult,
	XTweet,
} from "./types";

export function declareMarketSignalsDatabase(worker: Worker) {
	return worker.database("marketSignals", {
		type: "managed",
		initialTitle: "Market Signals (X Radar)",
		primaryKeyProperty: "Tweet ID",
		schema: {
			properties: {
				Title: Schema.title(),
				"Tweet ID": Schema.richText(),
				Source: Schema.select([
					{ name: "x-mention" },
					{ name: "x-brand" },
					{ name: "x-self" },
				]),
				"Matched Query": Schema.richText(),
				Author: Schema.richText(),
				"Author Followers": Schema.number(),
				Verified: Schema.checkbox(),
				Content: Schema.richText(),
				URL: Schema.url(),
				Type: Schema.select([
					{ name: "partnership" },
					{ name: "enterprise-demo" },
					{ name: "dev-user" },
					{ name: "lead-signal", color: "green" },
					{ name: "community-buzz", color: "blue" },
					{ name: "competitive-intel", color: "yellow" },
					{ name: "complaint", color: "red" },
					{ name: "noise", color: "gray" },
					{ name: "unclear" },
				]),
				Priority: Schema.select([
					{ name: "high", color: "red" },
					{ name: "medium", color: "yellow" },
					{ name: "low", color: "gray" },
				]),
				Confidence: Schema.number(),
				Summary: Schema.richText(),
				"Recommended Motion": Schema.richText(),
				"Suggested Owner": Schema.richText(),
				"Promoted to Inbox": Schema.checkbox(),
				"Tweet Created At": Schema.date(),
			},
		},
	});
}

export function buildSignalChange(
	tweet: XTweet,
	event: InboundEvent,
	triage: TriageResult,
	promoted: boolean,
) {
	const title = `[${triage.type}] @${tweet.author.userName}: ${tweet.text.slice(0, 60)}${
		tweet.text.length > 60 ? "…" : ""
	}`;

	return {
		type: "upsert" as const,
		key: tweet.id,
		properties: {
			Title: Builder.title(title),
			"Tweet ID": Builder.richText(tweet.id),
			Source: Builder.select(event.source),
			"Matched Query": Builder.richText(tweet.matchedQuery),
			Author: Builder.richText(
				tweet.author.name
					? `${tweet.author.name} (@${tweet.author.userName})`
					: `@${tweet.author.userName}`,
			),
			"Author Followers": Builder.number(tweet.author.followers ?? 0),
			Verified: Builder.checkbox(
				Boolean(tweet.author.verified || tweet.author.isBlueVerified),
			),
			Content: Builder.richText(tweet.text),
			URL: Builder.url(tweet.url),
			Type: Builder.select(triage.type satisfies OpportunityType),
			Priority: Builder.select(triage.priority satisfies Priority),
			Confidence: Builder.number(triage.confidence),
			Summary: Builder.richText(triage.summary),
			"Recommended Motion": Builder.richText(triage.recommendedMotion),
			"Suggested Owner": Builder.richText(triage.suggestedOwner),
			"Promoted to Inbox": Builder.checkbox(promoted),
			"Tweet Created At": Builder.date(tweet.createdAt.slice(0, 10)),
		},
	};
}

export const PROMOTABLE_TYPES: ReadonlySet<OpportunityType> = new Set([
	"lead-signal",
	"partnership",
	"enterprise-demo",
] as const);

export const PROMOTION_CONFIDENCE_THRESHOLD = 70;

export function shouldPromote(triage: TriageResult): boolean {
	return (
		triage.confidence >= PROMOTION_CONFIDENCE_THRESHOLD &&
		PROMOTABLE_TYPES.has(triage.type)
	);
}
