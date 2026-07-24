import {
  getBroadcastById,
  getBroadcasts,
  updateBroadcastStatus,
  getFriendsByTag,
  jstNow,
} from '@ig-harness/db';
import type { Broadcast } from '@ig-harness/db';
import type { InstagramClient } from '@ig-harness/ig-sdk';
import { calculateStaggerDelay, sleep } from './rate-limit.js';
import { recordDmFailure } from '../lib/health.js';
import {
  reserveAutoSend,
  withinStandardWindow,
  DEFAULT_AUTO_DM_CAPS,
  type AutoDmCaps,
} from './auto-send-safety.js';

const BATCH_SIZE = 50; // IG API is more conservative than LINE

/**
 * Per-recipient compliance + cap guard for one broadcast send. Returns true
 * when the send may fire. POLICY: a broadcast is a recipient:{id} push, legal
 * only within the recipient's 24h standard window (last inbound message) —
 * out-of-window recipients are SKIPPED, not failed (their sends would be
 * rejected by Meta and each rejection is a spam signal against the account).
 * When the account cap denies, the caller stops the whole remaining run.
 */
async function guardBroadcastRecipient(
  db: D1Database,
  followerId: number | string,
  igsid: string,
  accountId: string,
  caps: AutoDmCaps,
): Promise<'send' | 'skip_window' | 'stop_cap'> {
  const inWindow = await withinStandardWindow(db, followerId);
  if (!inWindow) return 'skip_window';
  const reserved = await reserveAutoSend(db, { accountId, igsid, kind: 'broadcast', caps });
  if (!reserved.ok) return 'stop_cap';
  return 'send';
}

export async function processBroadcastSend(
  db: D1Database,
  igClient: InstagramClient,
  broadcastId: number | string,
  _workerUrl?: string,
  accountId?: string,
  caps: AutoDmCaps = DEFAULT_AUTO_DM_CAPS,
): Promise<Broadcast> {
  await updateBroadcastStatus(db, broadcastId, 'sending');

  const broadcast = await getBroadcastById(db, broadcastId);
  if (!broadcast) {
    throw new Error(`Broadcast ${broadcastId} not found`);
  }

  const capAccountId = accountId ?? broadcast.account_id ?? 'default';
  const messageBody = JSON.parse(broadcast.body) as Record<string, unknown>;
  let totalSent = 0;
  let skippedWindow = 0;
  let stoppedByCap = false;

  try {
    if (!broadcast.tag_filter) {
      // No tag filter — send to all of the owning account's followers.
      // account_id NULL (legacy pre-backfill rows / single-account deploys
      // before seed) keeps the unscoped behavior.
      const stmt = broadcast.account_id
        ? db.prepare(`SELECT id, igsid FROM followers WHERE account_id = ?`).bind(broadcast.account_id)
        : db.prepare(`SELECT id, igsid FROM followers`);
      const followers = await stmt.all<{ id: number; igsid: string }>();
      const allFollowers = followers.results;

      outer: for (let i = 0; i < allFollowers.length; i += BATCH_SIZE) {
        const batch = allFollowers.slice(i, i + BATCH_SIZE);
        const batchIndex = Math.floor(i / BATCH_SIZE);

        if (batchIndex > 0) {
          const delay = calculateStaggerDelay(allFollowers.length, batchIndex);
          await sleep(delay);
        }

        for (const follower of batch) {
          try {
            const verdict = await guardBroadcastRecipient(db, follower.id, follower.igsid, capAccountId, caps);
            if (verdict === 'skip_window') { skippedWindow++; continue; }
            if (verdict === 'stop_cap') { stoppedByCap = true; break outer; }
            await sendIgMessage(igClient, follower.igsid, broadcast.message_type, messageBody);
            totalSent++;

            await db
              .prepare(
                `INSERT INTO messages_log (follower_id, direction, message_type, body, trigger_source)
                 VALUES (?, 'out', ?, ?, 'broadcast')`,
              )
              .bind(follower.id, broadcast.message_type, broadcast.body)
              .run();
          } catch (err) {
            console.error(`Broadcast send failed for follower ${follower.id}:`, err);
            await recordDmFailure(db, accountId ?? broadcast.account_id ?? 'unknown').catch(() => {});
          }
        }
      }
    } else {
      // tag_filter present — parse and send to matching followers
      const tagFilter = JSON.parse(broadcast.tag_filter) as { tagId?: string };
      if (!tagFilter.tagId) {
        throw new Error('tag_filter must contain tagId');
      }

      const friends = await getFriendsByTag(db, tagFilter.tagId, {
        accountId: broadcast.account_id ?? undefined,
      });

      outerTag: for (let i = 0; i < friends.length; i += BATCH_SIZE) {
        const batch = friends.slice(i, i + BATCH_SIZE);
        const batchIndex = Math.floor(i / BATCH_SIZE);

        if (batchIndex > 0) {
          const delay = calculateStaggerDelay(friends.length, batchIndex);
          await sleep(delay);
        }

        for (const friend of batch) {
          try {
            const verdict = await guardBroadcastRecipient(db, friend.id, friend.igsid, capAccountId, caps);
            if (verdict === 'skip_window') { skippedWindow++; continue; }
            if (verdict === 'stop_cap') { stoppedByCap = true; break outerTag; }
            await sendIgMessage(igClient, friend.igsid, broadcast.message_type, messageBody);
            totalSent++;

            await db
              .prepare(
                `INSERT INTO messages_log (follower_id, direction, message_type, body, trigger_source)
                 VALUES (?, 'out', ?, ?, 'broadcast')`,
              )
              .bind(friend.id, broadcast.message_type, broadcast.body)
              .run();
          } catch (err) {
            console.error(`Broadcast send failed for friend ${friend.id}:`, err);
            await recordDmFailure(db, accountId ?? broadcast.account_id ?? 'unknown').catch(() => {});
          }
        }
      }
    }

    if (skippedWindow > 0 || stoppedByCap) {
      console.warn(
        `[broadcast] ${broadcastId}: sent=${totalSent} skipped_out_of_window=${skippedWindow} stopped_by_cap=${stoppedByCap ? 1 : 0}`,
      );
    }
    await updateBroadcastStatus(db, broadcastId, 'sent', { totalSent });
  } catch (err) {
    await updateBroadcastStatus(db, broadcastId, 'draft');
    throw err;
  }

  return (await getBroadcastById(db, broadcastId))!;
}

export async function processScheduledBroadcasts(
  db: D1Database,
  igClient: InstagramClient,
  workerUrl?: string,
  accountId?: string,
  caps: AutoDmCaps = DEFAULT_AUTO_DM_CAPS,
): Promise<void> {
  // When an accountId is given, the due extraction is scoped at the SQL level
  // so each account's cron tick only picks up its own scheduled broadcasts.
  const allBroadcasts = await getBroadcasts(db, accountId ? { accountId } : {});
  const nowMs = Date.now();

  const scheduled = allBroadcasts.filter(
    (b) =>
      b.status === 'scheduled' &&
      b.scheduled_at !== null &&
      new Date(b.scheduled_at).getTime() <= nowMs,
  );

  for (const broadcast of scheduled) {
    try {
      await processBroadcastSend(db, igClient, broadcast.id, workerUrl, accountId, caps);
    } catch (err) {
      console.error(`Failed to send scheduled broadcast ${broadcast.id}:`, err);
    }
  }
}

async function sendIgMessage(
  igClient: InstagramClient,
  recipientId: string,
  messageType: string,
  body: Record<string, unknown>,
): Promise<void> {
  switch (messageType) {
    case 'text':
      await igClient.sendText(recipientId, body.text as string);
      break;
    case 'image':
      await igClient.sendImage(recipientId, body.url as string);
      break;
    case 'template':
      await igClient.sendGenericTemplate(recipientId, body.elements as never[]);
      break;
    case 'quick_reply':
      await igClient.sendQuickReply(
        recipientId,
        body.text as string,
        body.quick_replies as never[],
      );
      break;
    default:
      if (typeof body.text === 'string') {
        await igClient.sendText(recipientId, body.text);
      }
  }
}
