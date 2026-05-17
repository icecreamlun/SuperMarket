import type { Client } from "@notionhq/client";
import type { WebhookEvent } from "@notionhq/workers";
import "dotenv/config";

function writeInboundToNotion(event: WebhookEvent & { eventId?: string }, notion: Client): Promise<any> {
    const databaseId = process.env.INTAKE_DATABASE_ID;
    if (!databaseId) {
        console.error("INTAKE_DATABASE_ID not configured");
        return Promise.reject(new Error("INTAKE_DATABASE_ID not configured"));
    }
    console.log(`Creating page for event: ${event.deliveryId} in database: ${databaseId}`);
    const eventId = event.eventId ?? event.deliveryId;
    const timestamp = new Date();
    return notion.pages.create({
        parent: { database_id: databaseId },
        properties: {
            // Ensure US Pacific Timezone (which is "America/Los_Angeles" in IANA time zone database)
            "Title": {
                title: [{
                    type: "text",
                    text: {
                        content:
                            "Email Received at " +
                            timestamp.toLocaleString("en-US", {
                                timeZone: "America/Los_Angeles",
                                timeZoneName: "short",
                            }),
                    }
                }]
            },

            "Source": { select: { name: "gmail" } },
            "Opportunity Type": { select: { name: "unclear" } },
            "Status": { select: { name: "new" } },
            "Summary": { rich_text: [{ type: "text", text: { content: JSON.stringify(event.body) } }] },
        },
        /* properties: {
            "Event ID": { title: [{ type: "text", text: { content: eventId } }] },
            "Status": { status: { name: "Received" } },
            "Received At": { date: { start: timestamp.toISOString() } },
            "Payload": { rich_text: [{ type: "text", text: { content: JSON.stringify(event.body) } }] },
            "Source": { rich_text: [{ type: "text", text: { content: event.headers["host"] ?? "" } }] },
            "Endpoint": { url: "/onEmailReceived" },
            "Event Type": { select: { name: "email.received" } },
        }, */
    });
}

export async function processEmailReceived(
    event: WebhookEvent & { eventId?: string },
    notion: Client,
): Promise<any> {
    const data = event.body;
    if (!data?.type || data.type !== "email") {
        console.log(`Skipping non-email event: ${String(data?.type)}`);
        return;
    }
    if (!event.deliveryId) {
        console.log(`Skipping event with no deliveryId: ${event.deliveryId}`);
        return;
    }

    return writeInboundToNotion(event, notion).then((page) => {
        console.log(
            `Created page: ${page.id} for event: ${event.deliveryId}`,
        );
    }).catch((err) => {
        console.error(`Error creating page: ${err}`);
        return null;
    });
};
