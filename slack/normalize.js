export function normalizeSlackToInboundEvent(slack) {
    return {
      source: slack.type,
      raw: slack.text,
      contact: {
        slackUser: slack.userId,
        slackUserName: slack.userName ?? null,
        channel: slack.channel,
      },
      content: {
        text: slack.text,
        thread: slack.thread ?? null,
      },
      receivedAt: new Date().toISOString(),
    };
  }