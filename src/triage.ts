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
				enum: ["partnership", "enterprise-demo", "dev-user", "unclear"],
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

const SYSTEM_PROMPT = `You are the triage layer of an inbound opportunity sidekick for a dev-tool startup's GTM team.

Classify every inbound into exactly one type:
- partnership: integrations, co-marketing, ecosystem asks
- enterprise-demo: clear buying signal — demo / pricing / rollout / evaluation
- dev-user: signal from an individual developer using the product (esp. GitHub events). Subtype: eval-signal (star + enterprise account), feature-interest (feature request), bug-feedback (bug issue), deep-eval (fork)
- unclear: missing information or ambiguous intent

Priority guide:
- high: clear buying/partnership intent, strong company signal (work email / enterprise account), urgent wording, or a GitHub stargazer at a known enterprise
- medium: plausible but information is partial; active developer on personal account; community-channel high-quality question
- low: vague/generic, small or bot-like account, off-topic

Calibrate confidence honestly. If signals are thin, say so via missingInfo.
Pick suggestedOwner from: BizOps, Sales, DevRel, Founder, Review queue.
The draftResponse must be short, warm, specific to what they said. Never invent facts.

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
