import { App } from '@slack/bolt';
import dotenv from 'dotenv';
import { normalizeSlackToInboundEvent } from './normalize.js';

dotenv.config();

const app = new App({
  token: process.env.SLACK_BOT_TOKEN,
  signingSecret: process.env.SLACK_SIGNING_SECRET,
});

async function triggerTriagePipeline(inboundEvent) {
  console.log('[triage] event:', JSON.stringify(inboundEvent, null, 2));
  try {
    const res = await fetch(process.env.TRIAGE_PIPELINE_URL, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(inboundEvent),
    });
    console.log('[triage] pipeline response:', res.status);
  } catch (err) {
    console.error('[triage] pipeline unreachable, event logged only');
  }
}

app.command('/triage', async ({ command, ack, say }) => {
  await ack();

  const event = normalizeSlackToInboundEvent({
    type: 'slack-command',
    userId: command.user_id,
    userName: command.user_name,
    channel: command.channel_id,
    text: command.text,
  });

  await triggerTriagePipeline(event);
  await say(`✅ Triage started: "${command.text}"`);
});

app.event('app_mention', async ({ event, say }) => {
  const inbound = normalizeSlackToInboundEvent({
    type: 'slack-mention',
    userId: event.user,
    channel: event.channel,
    text: event.text,
    thread: event.thread_ts,
  });

  await triggerTriagePipeline(inbound);
  await say({
    text: '👀 Got it, triaging now...',
    thread_ts: event.ts,
  });
});

(async () => {
  await app.start(3000);
  console.log('⚡️ Slack app running on port 3000');
})();