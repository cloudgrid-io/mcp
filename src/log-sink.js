// src/log-sink.js
// Pluggable delivery for the QA session log. Default sink posts to a Slack
// incoming webhook. Dark by default: createSink returns null when the webhook
// env var is unset, so the logger factory returns null and capture is a no-op.
//
// NOTE: Slack incoming webhooks cannot upload file attachments — only a JSON
// message body. We post the summary + the full log inside a fenced code block.
// True file attachment (files.upload) needs a bot token and is deferred.
const SLACK_TEXT_LIMIT = 38000; // headroom under Slack's ~40k message cap

export class SlackWebhookSink {
  constructor(url, { fetchImpl } = {}) {
    this.url = url;
    this.fetchImpl = fetchImpl || globalThis.fetch;
  }
  async send({ filename, summary, text }) {
    try {
      const body = String(text || "");
      const clipped = body.length > SLACK_TEXT_LIMIT
        ? body.slice(0, SLACK_TEXT_LIMIT) + "\n…(truncated)"
        : body;
      const message = `*${filename}* — ${summary}\n\`\`\`\n${clipped}\n\`\`\``;
      await this.fetchImpl(this.url, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ text: message }),
      });
    } catch { /* delivery is best-effort; never throws */ }
  }
}

export function createSink(env = process.env) {
  const url = env.CLOUDGRID_QA_SLACK_WEBHOOK;
  if (!url) return null;
  return new SlackWebhookSink(url);
}
