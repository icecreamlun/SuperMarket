/**
 * Test the email webhook by simulating an email event to the webhook.
 * Also works for 3rd party workflow tools e.g. Zapier to convert an email event into a webhook call.
 */

const fetch = require("node-fetch");
require("dotenv").config();
const testEmailWebhook = async (webhookUrl, subject, sentFrom, body) => {
    try {
        const response = await fetch(webhookUrl, {
            method: "POST",
            headers: {
                "Content-Type": "application/json",
            },
            body: JSON.stringify({
                type: "email",
                subject,
                from: sentFrom,
                body,
            })
        });

        if (!response.ok) {
            throw new Error(`HTTP error! status: ${response.status}`);
        }

        const data = await response.json();
        console.log("Response:", response.status, data);
        return {
            status: response.status,
            data: data,
        }
    }
    catch (error) {
        console.error("Error:", error);
        return { error: error.message, status: "500" };
    }
}

const inputData = {
    subject: "Test email",
    sentFrom: "test@example.com",
    body: "Test email body",
}

return testEmailWebhook(process.env.EMAIL_WEBHOOK_URL, inputData);
