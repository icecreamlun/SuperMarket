import Anthropic from "@anthropic-ai/sdk";
import type {
	GitHubEnrichment,
	InboundEvent,
	Priority,
	TriageResult,
} from "./types";

const TRIAGE_TOOL = {
	name: "report_triage",
	description:
		"Report the triage classification, priority, and recommended next step for an inbound opportunity.",
	input_schema: {
		type: "object" as const,
		properties: {
			type: {
				type: "string",
				enum: [
					"partnership",
					"enterprise-demo",
					"dev-user",
					"lead-signal",
					"community-buzz",
					"competitive-intel",
					"complaint",
					"noise",
					"unclear",
				],
			},
			devUserSubtype: {
				type: "string",
				enum: [
					"eval-signal",
					"feature-interest",
					"bug-feedback",
					"deep-eval",
				],
				description: "Only set when type=dev-user.",
			},
			priority: { type: "string", enum: ["high", "medium", "low"] },
			confidence: {
				type: "number",
				minimum: 0,
				maximum: 100,
				description: "Confidence in the classification, 0-100.",
			},
			summary: {
				type: "string",
				description:
					"One-sentence summary of who this is and what they want.",
			},
			whyType: {
				type: "string",
				description: "One sentence: why this type label.",
			},
			whyPriority: {
				type: "string",
				description: "One sentence: why this priority tier.",
			},
			missingInfo: {
				type: "array",
				items: { type: "string" },
				description: "Specific facts you'd need to raise confidence.",
			},
			recommendedMotion: {
				type: "string",
				description:
					"Concrete next step (e.g. 'BD intro email', 'route to DevRel', 'add to weekly community digest').",
			},
			suggestedOwner: {
				type: "string",
				description:
					"One of: BizOps, Sales, DevRel, Founder, Review queue.",
			},
			draftResponse: {
				type: "string",
				description:
					"Short, warm draft reply addressed to the contact. 2-4 sentences. Plain text.",
			},
		},
		required: [
			"type",
			"priority",
			"confidence",
			"summary",
			"whyType",
			"whyPriority",
			"missingInfo",
			"recommendedMotion",
			"suggestedOwner",
			"draftResponse",
		],
		additionalProperties: false,
	},
};

const SYSTEM_PROMPT = `You are the triage layer of an opportunity sidekick for a dev-tool startup's GTM team. Inputs come from two surfaces:
  - INBOX (reactive): someone is trying to reach us — GitHub issue/star/fork, Slack DM, forwarded email
  - RADAR (proactive): ambient signals we scraped from X/Twitter

Pick the SINGLE best type. Choose RADAR types only when source starts with "x-" (x-mention, x-brand, x-self). Otherwise prefer INBOX types.

INBOX types:
- partnership: integrations, co-marketing, ecosystem asks
- enterprise-demo: clear buying signal — demo / pricing / rollout / evaluation
- dev-user: GitHub-style signal from an individual developer. Subtype: eval-signal (star + enterprise account), feature-interest (feature request issue), bug-feedback (bug issue), deep-eval (fork)
- unclear: missing information or ambiguous intent

RADAR types (X only):
- lead-signal: public expression of evaluation/buying intent we could act on ("anyone tried X?", "looking for an alternative to Y", "need a tool that does Z"). High value — these can be promoted to INBOX.
- community-buzz: positive mention, advocacy, fan post about a brand we monitor
- competitive-intel: chatter about competitors or adjacent products that affects our positioning
- complaint: negative mention worth knowing (about us or a competitor we could win from)
- noise: irrelevant, off-topic, joke, or false-positive keyword match (e.g. "minimax algorithm" when monitoring "MiniMax AI brand"). Score noise honestly — most random tweets are noise.

Priority guide:
- high: clear buying/partnership intent, enterprise-affiliated author, large following (>10k) with relevant context, lead-signal explicitly asking for what we sell
- medium: plausible but partial info; mid-following developer; positive community buzz from credible account
- low: vague, small account, off-topic; classify most X chatter low unless you see a real signal

Calibrate confidence honestly. If signals are thin, say so via missingInfo.
Pick suggestedOwner from: BizOps, Sales, DevRel, Founder, Review queue, None (for noise).
The draftResponse must be short, warm, specific to what they said. For RADAR items, draftResponse can be a 1-line @-reply suggestion or empty for noise. Never invent facts.

Call the report_triage tool exactly once. Do not return prose.`;

export async function triage(
	event: InboundEvent,
	enrichment?: GitHubEnrichment | null,
): Promise<TriageResult> {
	const apiKey = process.env.ANTHROPIC_API_KEY;
	if (!apiKey) {
		return heuristicTriage(event, enrichment);
	}

	const client = new Anthropic({ apiKey });

	const userBlock = JSON.stringify(
		{
			source: event.source,
			contact: event.contact,
			content: event.content,
			githubEnrichment: enrichment ?? null,
		},
		null,
		2,
	);

	const response = await client.messages.create({
		model: "claude-sonnet-4-5",
		max_tokens: 1024,
		system: SYSTEM_PROMPT,
		tools: [TRIAGE_TOOL],
		tool_choice: { type: "tool", name: "report_triage" },
		messages: [
			{
				role: "user",
				content: `Triage this inbound event:\n\n${userBlock}`,
			},
		],
	});

	for (const block of response.content) {
		if (block.type === "tool_use" && block.name === "report_triage") {
			return block.input as TriageResult;
		}
	}
	return heuristicTriage(event, enrichment);
}

function heuristicTriage(
	event: InboundEvent,
	enrichment?: GitHubEnrichment | null,
): TriageResult {
	let priority: Priority = "low";
	if (enrichment?.isLikelyEnterprise) priority = "high";
	else if ((enrichment?.followers ?? 0) > 50) priority = "medium";

	const subtype =
		event.source === "github-fork"
			? "deep-eval"
			: event.source === "github-issue"
				? "feature-interest"
				: "eval-signal";

	return {
		type: "dev-user",
		devUserSubtype: subtype,
		priority,
		confidence: 50,
		summary: event.content.title,
		whyType: "Heuristic fallback (no LLM key configured).",
		whyPriority: enrichment?.isLikelyEnterprise
			? "Likely enterprise actor."
			: "Default tier.",
		missingInfo: ["No LLM available — heuristic only"],
		recommendedMotion: "Manual review",
		suggestedOwner: "Review queue",
		draftResponse: "",
	};
}
