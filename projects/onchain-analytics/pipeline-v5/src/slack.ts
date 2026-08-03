/**
 * slack.ts -- Webhook alerting. No-op if SLACK_WEBHOOK_URL is empty.
 */

import { CONFIG } from "./config.js";
import { log } from "./log.js";

async function postToSlack(payload: Record<string, any>): Promise<void> {
  if (!CONFIG.SLACK_WEBHOOK_URL) return;

  try {
    const response = await fetch(CONFIG.SLACK_WEBHOOK_URL, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(payload),
    });
    if (!response.ok) {
      log.warn(`Slack webhook returned ${response.status}`, { status: response.status });
    }
  } catch (e: any) {
    log.warn(`Slack webhook failed: ${e.message}`);
  }
}

export async function alertFailure(
  runId: string,
  mode: string,
  exitCode: number,
  error: string,
  rowsProcessed: number
): Promise<void> {
  await postToSlack({
    text: `:rotating_light: *Pipeline failed* (exit ${exitCode})`,
    blocks: [
      {
        type: "section",
        text: {
          type: "mrkdwn",
          text: [
            `:rotating_light: *Pipeline failed*`,
            `*Mode:* ${mode} | *Exit:* ${exitCode} | *Run:* ${runId}`,
            `*Rows processed:* ${rowsProcessed}`,
            `*Error:* \`${error.slice(0, 200)}\``,
          ].join("\n"),
        },
      },
    ],
  });
}

export async function alertStaleness(
  tableId: string,
  network: string,
  lastTimestamp: Date,
  hoursStale: number
): Promise<void> {
  await postToSlack({
    text: `:warning: Data stale: ${tableId}/${network} is ${Math.round(hoursStale)}h behind`,
    blocks: [
      {
        type: "section",
        text: {
          type: "mrkdwn",
          text: [
            `:warning: *Data freshness alert*`,
            `*Table:* ${tableId} | *Network:* ${network}`,
            `*Last data:* ${lastTimestamp.toISOString()} (${Math.round(hoursStale)}h ago)`,
            `*Threshold:* ${CONFIG.FRESHNESS_THRESHOLD_HOURS}h`,
          ].join("\n"),
        },
      },
    ],
  });
}
