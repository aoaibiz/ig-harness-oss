import { Hono } from 'hono';
import {
  InstagramClient,
  verifyWebhookSignature,
  verifyWebhookChallenge,
} from '@ig-harness/ig-sdk';
import type { WebhookPayload, MessagingEvent } from '@ig-harness/ig-sdk';
import {
  upsertFriend,
  getFriendByIgsid,
  getScenarios,
  enrollFriendInScenario,
  getScenarioSteps,
  advanceFriendScenario,
  completeFriendScenario,
  jstNow,
  logMessage,
} from '@ig-harness/db';
import { buildIgMessage, expandVariables } from '../services/step-delivery.js';
import { handleFollowCheckPostback, handlePendingPrAck, triggerGateForComment, triggerGateForDmKeyword } from '../services/engagement-gate.js';
import {
  autoSendEnabled,
  autoDmCaps,
  claimTriggerDelivery,
  reserveAutoSend,
  DEFAULT_AUTO_DM_CAPS,
  type AutoDmCaps,
} from '../services/auto-send-safety.js';

/** Fail-closed default for internal handlers: auto-send OFF unless the route
 *  explicitly threads the runtime switch through. */
const AUTO_DM_OFF = { enabled: false, caps: DEFAULT_AUTO_DM_CAPS };
import type { IgAccountRef } from '../services/line-cross-link.js';
import { listIgAccounts } from '@ig-harness/db';
import { ensureDefaultAccount, pickAccountForEntry, toIgAccountRef, getAccountClient } from '../lib/accounts.js';
import { recordWebhookReceived } from '../lib/health.js';
import type { Env } from '../index.js';

export type PostbackPayload =
  | { kind: 'check_follow'; gateId: string; deliveryId: string }
  | { kind: 'unknown' };

export function parsePostbackPayload(raw: string): PostbackPayload {
  if (!raw) return { kind: 'unknown' };
  if (raw.startsWith('CHECK_FOLLOW:')) {
    const parts = raw.split(':');
    if (parts.length === 3 && parts[1] && parts[2]) {
      return { kind: 'check_follow', gateId: parts[1], deliveryId: parts[2] };
    }
  }
  return { kind: 'unknown' };
}

const webhook = new Hono<Env>();

// GET /webhook — Meta verification challenge
webhook.get('/webhook', async (c) => {
  const mode = c.req.query('hub.mode') ?? null;
  const token = c.req.query('hub.verify_token') ?? null;
  const challenge = c.req.query('hub.challenge') ?? null;

  // Accounts connected through a different Meta App carry their own verify
  // token — accept any known one so each App's webhook subscription succeeds.
  await ensureDefaultAccount(c.env, c.env.DB);
  const accounts = await listIgAccounts(c.env.DB);
  const expectedTokens = [c.env.IG_VERIFY_TOKEN, ...accounts.map((a) => a.verify_token)]
    .filter((t): t is string => !!t);
  for (const expected of expectedTokens) {
    const result = verifyWebhookChallenge(mode, token, challenge, expected);
    if (result) {
      return c.text(result, 200);
    }
  }
  return c.json({ error: 'Verification failed' }, 403);
});

// POST /webhook — Instagram webhook events
webhook.post('/webhook', async (c) => {
  const rawBody = await c.req.text();
  const signature = c.req.header('X-Hub-Signature-256') ?? '';
  const db = c.env.DB;

  // Verify signature — env App Secret first, then per-account secrets so
  // accounts connected through a different Meta App also validate.
  await ensureDefaultAccount(c.env, c.env.DB);
  const accounts = await listIgAccounts(c.env.DB);
  const secrets = [c.env.IG_APP_SECRET, ...accounts.map((a) => a.app_secret)]
    .filter((sec): sec is string => !!sec)
    .filter((sec, i, arr) => arr.indexOf(sec) === i);
  // Empty/missing header is immediately invalid — skip the secret loop.
  if (!signature) {
    return c.json({ error: 'invalid signature' }, 403);
  }

  let valid = false;
  for (const secret of secrets) {
    if (await verifyWebhookSignature(rawBody, signature, secret)) {
      valid = true;
      break;
    }
  }
  if (!valid) {
    console.warn('[webhook] signature verification failed; rejecting request');
    return c.json({ error: 'invalid signature' }, 403);
  }

  let body: WebhookPayload;
  try {
    body = JSON.parse(rawBody) as WebhookPayload;
  } catch {
    console.error('[webhook] failed to parse body');
    return c.json({ status: 'ok' }, 200);
  }

  console.log('[webhook] object:', body.object, 'entries:', body.entry?.length ?? 0);

  if (body.object !== 'instagram') {
    console.log('Skipping non-instagram webhook, object:', body.object);
    return c.json({ status: 'ok' }, 200);
  }

  // RUNTIME DARK-GATE (auto-DM capability switch): computed ONCE per webhook
  // and threaded into every handler. When off, pre-armed ACTIVE rules/gates/
  // scenarios in this worker's D1 can NOT fire — dark means dark at the
  // worker layer, independent of any upstream proxy forcing rules inactive.
  const autoDm = { enabled: autoSendEnabled(c.env), caps: autoDmCaps(c.env) };

  // Process asynchronously — Meta expects quick response
  const processingPromise = (async () => {
    for (const entry of body.entry) {
      // entry.id is the receiving business account's IG user id — resolve
      // which managed account this entry belongs to before any processing.
      const account = pickAccountForEntry(accounts, entry.id);
      if (!account) {
        console.warn(`[webhook] no account matches entry.id=${entry.id} (accounts=${accounts.length}); skipping entry`);
        continue;
      }
      // Register on waitUntil: the enclosing promise can settle before this
      // D1 write completes (e.g. entries with no messaging work).
      c.executionCtx.waitUntil(recordWebhookReceived(db, account.id).catch(() => {}));
      const igClient = await getAccountClient(c.env, db, account);
      const igAccount: IgAccountRef = toIgAccountRef(account);

      // Handle DM messaging events (messaging = primary, standby = secondary receiver)
      const messagingEvents = entry.messaging ?? entry.standby ?? [];
      for (const event of messagingEvents) {
        try {
          await handleMessagingEvent(db, igClient, event, c.env.WORKER_URL, igAccount, account.id, autoDm);
        } catch (err) {
          console.error('Error handling messaging event:', err);
        }
      }

      // Handle comment/mention change events
      if (entry.changes) {
        for (const change of entry.changes) {
          try {
            if (change.field === 'comments') {
              await handleCommentEvent(db, igClient, change.value, account.ig_user_id, c.env.WORKER_URL, igAccount, account.id, autoDm);
            } else if (change.field === 'mentions') {
              await handleMentionEvent(db, igClient, change.value, igAccount, account.id);
            }
          } catch (err) {
            console.error('Error handling change event:', err);
          }
        }
      }
    }
  })();

  c.executionCtx.waitUntil(processingPromise);
  return c.json({ status: 'ok' }, 200);
});

async function handleMessagingEvent(
  db: D1Database,
  igClient: InstagramClient,
  event: MessagingEvent,
  workerUrl?: string,
  igAccount?: IgAccountRef,
  accountId?: string,
  autoDm: { enabled: boolean; caps: AutoDmCaps } = AUTO_DM_OFF,
): Promise<void> {
  const senderId = event.sender.id;

  // Skip echo messages (our own outgoing messages)
  if (event.message?.is_echo) return;

  // Upsert follower (get profile from IG)
  let profile;
  try {
    profile = await igClient.getUserProfile(senderId);
  } catch (err) {
    console.error('Failed to get profile for', senderId, err);
  }

  const follower = await upsertFriend(db, {
    igsid: senderId,
    username: profile?.username ?? null,
    displayName: profile?.name ?? null,
    pictureUrl: profile?.profile_pic ?? null,
    isFollowing: profile?.is_user_follow_business ?? false,
    followerCount: profile?.follower_count ?? null,
    isVerified: profile?.is_verified_user ?? false,
    accountId,
  });

  if (event.message?.text) {
    const incomingText = event.message.text;
    const now = jstNow();
    const logId = crypto.randomUUID();

    // Log incoming message
    await db
      .prepare(
        `INSERT INTO messages_log (follower_id, direction, message_type, body, trigger_source)
         VALUES (?, 'in', 'text', ?, NULL)`,
      )
      .bind(follower.id, JSON.stringify({ text: incomingText }))
      .run();

    // Check LINE Harness UUID linkage token
    if (incomingText.startsWith('CONNECT:')) {
      const token = incomingText.slice(8).trim();
      // Look up token in tracked_links (ref_code = token, destination contains uid)
      const link = await db
        .prepare("SELECT destination_url FROM tracked_links WHERE ref_code = ?")
        .bind(token)
        .first<{ destination_url: string }>();

      if (link) {
        // Extract uid from destination URL
        const url = new URL(link.destination_url);
        const uid = url.searchParams.get('uid');
        if (uid) {
          await db
            .prepare("UPDATE followers SET external_user_id = ?, updated_at = datetime('now') WHERE id = ?")
            .bind(uid, follower.id)
            .run();

          await igClient.sendText(senderId, '✅ LINE連携が完了しました！LINEとInstagramのアカウントが紐づけられました。');

          await db
            .prepare(
              `INSERT INTO messages_log (follower_id, direction, message_type, body, trigger_source)
               VALUES (?, 'out', 'text', ?, 'manual')`,
            )
            .bind(follower.id, JSON.stringify({ text: 'LINE連携完了通知' }))
            .run();
        }
      } else {
        await igClient.sendText(senderId, '❌ 無効な連携コードです。LINEから再度リンクを取得してください。');
      }
      return; // Don't process further
    }

    // ── RUNTIME DARK-GATE: everything below this point is AUTOMATED
    // marketing-class sending (gates, scenarios). When the capability is off,
    // pre-armed ACTIVE rows in D1 must NOT fire. (The CONNECT ack above stays:
    // it is a transactional direct answer to the user's own explicit command,
    // sent inside their open 24h window.)
    if (!autoDm.enabled) {
      return;
    }

    // Private-reply CTA continuation: if this person has a parked comment-
    // gate CTA (pr_ack_pending), their reply = the "button press" — resume
    // the follow-check flow in-window. Consumes the message; keyword
    // triggers are skipped for this event.
    try {
      const acked = await handlePendingPrAck(db, igClient, {
        igsid: senderId,
        workerBaseUrl: workerUrl,
        igAccount,
        accountId,
        caps: autoDm.caps,
      });
      if (acked) return;
    } catch (err) {
      console.error('pr-ack continuation failed:', err);
    }

    // Engagement gate DM keyword trigger
    try {
      const triggered = await triggerGateForDmKeyword(db, igClient, {
        text: incomingText,
        follower: { id: follower.id, igsid: senderId },
        igAccount,
        accountId,
        messageId: event.message.mid,
        caps: autoDm.caps,
      });
      if (triggered) {
        // Skip scenario triggers if gate fired
        return;
      }
    } catch (err) {
      console.error('DM keyword gate trigger failed:', err);
    }

    // Check dm_keyword scenario triggers
    {
      const scenarios = await getScenarios(db, { accountId });
      for (const scenario of scenarios) {
        if (
          scenario.trigger_type === 'dm_keyword' &&
          scenario.is_active &&
          scenario.trigger_keyword
        ) {
          if (incomingText.includes(scenario.trigger_keyword)) {
            // Webhook-redelivery dedup: the same message mid re-delivered
            // must not double-enroll / double-send (claim-before-act).
            if (event.message.mid) {
              const claimed = await claimTriggerDelivery(db, {
                kind: 'scenario_dm',
                triggerId: String(scenario.id),
                eventId: event.message.mid,
                igsid: senderId,
              });
              if (!claimed) break;
            }
            const existing = await db
              .prepare(`SELECT id FROM follower_scenarios WHERE follower_id = ? AND scenario_id = ?`)
              .bind(follower.id, scenario.id)
              .first<{ id: string }>();
            if (!existing) {
              const friendScenario = await enrollFriendInScenario(db, follower.id, scenario.id);

              // Immediate delivery of first step if delay=0. The send is
              // in-window (answers the user's own message) — but it still
              // pays the outbound cap; denied → skip here and let the
              // (window+cap guarded) cron step-delivery retry later.
              const steps = await getScenarioSteps(db, scenario.id);
              const firstStep = steps[0];
              if (firstStep && firstStep.delay_minutes === 0 && friendScenario.status === 'active') {
                const reserved = await reserveAutoSend(db, {
                  accountId: accountId ?? 'default',
                  igsid: senderId,
                  kind: 'scenario_step',
                  caps: autoDm.caps,
                });
                if (!reserved.ok) break;
                try {
                  const expandedContent = expandVariables(firstStep.body, follower);
                  const parsed = JSON.parse(expandedContent);
                  await sendIgResponse(igClient, senderId, firstStep.message_type, parsed);

                  await db
                    .prepare(
                      `INSERT INTO messages_log (follower_id, direction, message_type, body, trigger_source)
                       VALUES (?, 'out', ?, ?, 'scenario')`,
                    )
                    .bind(follower.id, firstStep.message_type, firstStep.body)
                    .run();

                  const secondStep = steps[1] ?? null;
                  if (secondStep) {
                    const nextDeliveryDate = new Date(Date.now() + 9 * 60 * 60_000);
                    nextDeliveryDate.setMinutes(nextDeliveryDate.getMinutes() + secondStep.delay_minutes);
                    await advanceFriendScenario(db, friendScenario.id, firstStep.step_order, nextDeliveryDate.toISOString().slice(0, -1) + '+09:00');
                  } else {
                    await completeFriendScenario(db, friendScenario.id);
                  }
                } catch (err) {
                  console.error('Failed immediate delivery for scenario', scenario.id, err);
                }
              }
            }
            break;
          }
        }
      }
    }

  }

  // Handle postback events — gate-driven auto-sends (reward/reminder), so
  // the runtime dark-gate applies here too: an armed gate's button in an old
  // DM must not produce sends while the capability is off.
  if (event.postback) {
    if (!autoDm.enabled) {
      return;
    }
    const payload = parsePostbackPayload(event.postback.payload ?? '');
    if (payload.kind === 'check_follow') {
      // Webhook-redelivery dedup (claim-before-send): Meta postbacks are
      // at-least-once, so the SAME button press (same postback mid) can be
      // delivered again — without this claim it would re-run the follow-check
      // and re-send the reward/reminder (a rich reward fans out to N Graph
      // calls, so a redelivery duplicates up to N in-window messages and burns
      // the recipient cap). A DISTINCT press has a distinct mid, so legitimate
      // repeat presses (reminder → follow → reward) still proceed. Keyed under
      // kind='gate' with a 'pb:' event-id prefix so the postback-mid keyspace
      // is domain-separated from the comment-trigger 'gate' claims (whose
      // event_id is an IG comment id); a value collision could only ever fail
      // closed (suppress a send), never over-send, and the prefix removes even
      // that theoretical case. Fail-closed: a store error refuses the send.
      if (event.postback.mid) {
        const claimed = await claimTriggerDelivery(db, {
          kind: 'gate',
          triggerId: payload.gateId,
          eventId: `pb:${event.postback.mid}`,
          igsid: senderId,
        });
        if (!claimed) return;
      }
      try {
        await handleFollowCheckPostback(db, igClient, {
          gateId: payload.gateId,
          deliveryId: payload.deliveryId,
          igsid: senderId,
          workerBaseUrl: workerUrl,
          igAccount,
          accountId,
          caps: autoDm.caps,
        });
        // Log button press as inbound gate message
        const postbackTitle = event.postback.title ?? event.postback.payload ?? '';
        await logMessage(db, {
          followerId: follower.id,
          direction: 'in',
          messageType: 'quick_reply',
          body: `[ボタン] ${postbackTitle}`,
          triggerSource: 'gate',
        });
      } catch (err) {
        console.error('Follow check postback failed:', err);
      }
    } else {
      console.log('Unknown postback payload:', event.postback.payload);
    }
  }
}

async function handleCommentEvent(
  db: D1Database,
  igClient: InstagramClient,
  value: { id: string; text: string; from: { id: string; username: string }; media: { id: string }; created_time: string },
  igUserId: string,
  _workerUrl?: string,
  igAccount?: IgAccountRef,
  accountId?: string,
  autoDm: { enabled: boolean; caps: AutoDmCaps } = AUTO_DM_OFF,
): Promise<void> {
  const senderId = value.from.id;
  const commentText = value.text;
  const mediaId = value.media.id;

  // Skip our own comments — when the gate posts a public reply via
  // postCommentToMedia, IG fires a comment webhook for that too. Without
  // this guard we'd try to DM ourselves, fail, and pollute the gate
  // delivery table with a self-trigger.
  if (senderId === igUserId) {
    return;
  }

  // Upsert follower
  let profile;
  try {
    profile = await igClient.getUserProfile(senderId);
  } catch {
    // Profile fetch may fail for non-followers
  }

  const follower = await upsertFriend(db, {
    igsid: senderId,
    username: value.from.username ?? profile?.username ?? null,
    displayName: profile?.name ?? null,
    pictureUrl: profile?.profile_pic ?? null,
    isFollowing: profile?.is_user_follow_business ?? false,
    followerCount: profile?.follower_count ?? null,
    isVerified: profile?.is_verified_user ?? false,
    accountId,
  });

  // ── RUNTIME DARK-GATE: every comment-triggered path below is an automated
  // send (gate CTA, rule DM, scenario enrollment). When the capability is
  // off, a pre-armed ACTIVE rule in this worker's D1 must NOT fire — the
  // follower upsert above still runs (CRM data, no outbound).
  if (!autoDm.enabled) {
    return;
  }

  // Engagement gate trigger — runs FIRST so a configured gate takes precedence
  // over the legacy comment-rule flow. If a gate fires, we skip the rule loop
  // and the gate-triggered scenarios below to avoid double DMs.
  let gateFired = false;
  try {
    gateFired = await triggerGateForComment(db, igClient, {
      postId: mediaId,
      commentText,
      follower: { id: follower.id, igsid: senderId },
      commentId: value.id,
      commenterUsername: value.from?.username,
      igAccount,
      accountId,
      caps: autoDm.caps,
    });
  } catch (err) {
    console.error('Engagement gate trigger failed:', err);
  }

  // Check comment rules (match by keyword + optional media filter)
  // Only when no gate fired — gates supersede legacy rules.
  const commentRules = gateFired
    ? { results: [] as Array<{
        id: string;
        keyword: string;
        match_type: 'exact' | 'contains' | 'regex' | 'any_comment';
        media_id: string | null;
        response_type: string;
        response_body: string;
        delay_seconds: number;
      }> }
    : await db
        .prepare(
          // Rule precedence:
          //   1. keyword-specific rules (exact / contains / regex) before catch-all
          //   2. post-scoped rules before account-wide rules (media_id NOT NULL first)
          //   3. oldest first (stable)
          // Without (2) a global `any_comment` would always shadow a later
          // post-specific `any_comment` on the same post.
          `SELECT * FROM comment_rules WHERE is_active = 1
           ${accountId ? 'AND account_id = ?' : ''}
           ORDER BY CASE match_type WHEN 'any_comment' THEN 1 ELSE 0 END ASC,
                    CASE WHEN media_id IS NULL THEN 1 ELSE 0 END ASC,
                    created_at ASC`,
        )
        .bind(...(accountId ? [accountId] : []))
        .all<{
          id: string;
          keyword: string;
          match_type: 'exact' | 'contains' | 'regex' | 'any_comment';
          media_id: string | null;
          response_type: string;
          response_body: string;
          delay_seconds: number;
        }>();

  for (const rule of commentRules.results) {
    // Media filter: if rule specifies a media_id, only match that post
    if (rule.media_id && rule.media_id !== mediaId) continue;

    let isMatch = false;
    if (rule.match_type === 'any_comment') {
      // No keyword check — any comment on the targeted media (or all media
      // when media_id is NULL) fires the rule.
      isMatch = true;
    } else if (rule.match_type === 'exact') {
      isMatch = commentText === rule.keyword;
    } else if (rule.match_type === 'contains') {
      isMatch = commentText.toLowerCase().includes(rule.keyword.toLowerCase());
    } else if (rule.match_type === 'regex') {
      try {
        isMatch = new RegExp(rule.keyword, 'i').test(commentText);
      } catch {
        isMatch = false;
      }
    }

    if (isMatch) {
      // Dedup BEFORE anything fires (claim-before-send):
      //   • same comment REDELIVERED by Meta → PK conflict → no second DM;
      //   • same person triggering this rule via a DIFFERENT comment →
      //     partial-unique (rule, igsid) conflict → one DM per person per
      //     rule, ever (race-proof at the SQL layer).
      const claimed = await claimTriggerDelivery(db, {
        kind: 'comment_rule',
        triggerId: String(rule.id),
        eventId: value.id,
        igsid: senderId,
      });
      if (!claimed) {
        break; // already handled (or store refused: fail-closed) — never re-send
      }

      // Outbound cap (reserve-before-send; never refunded).
      const reserved = await reserveAutoSend(db, {
        accountId: accountId ?? 'default',
        igsid: senderId,
        kind: 'comment_rule',
        caps: autoDm.caps,
      });
      if (!reserved.ok) {
        break;
      }

      // Apply delay if configured
      if (rule.delay_seconds > 0) {
        await new Promise((resolve) => setTimeout(resolve, rule.delay_seconds * 1000));
      }

      // Reply to the comment itself
      try {
        const replyText = (rule as any).reply_text
          ? (rule as any).reply_text.replace('{{username}}', value.from.username)
          : `@${value.from.username} コメントありがとう！📩 DMを送りました！`;
        await igClient.replyToComment(value.id, replyText);
      } catch (err) {
        console.error('Comment reply failed:', err);
      }

      // DM to the commenter — as a PRIVATE REPLY (recipient:{comment_id}),
      // the only policy-sanctioned DM from a comment trigger (verified
      // 2026-07-22 against Meta docs: one per comment, ≤7 days, TEXT is the
      // documented payload). recipient:{id} here was the policy violation
      // that puts the connected account at risk of Meta enforcement.
      // Non-text response bodies have no documented private-reply shape →
      // the DM is SKIPPED (fail-closed), never downgraded to recipient:{id}.
      const expandedBody = rule.response_body
        .replace(/\{\{igsid\}\}/g, senderId)
        .replace(/\{\{username\}\}/g, value.from.username)
        .replace(/\{\{follower_id\}\}/g, String(follower.id));
      const responseBody = JSON.parse(expandedBody) as Record<string, unknown>;
      const dmText = typeof responseBody.text === 'string' ? responseBody.text : null;
      if (dmText) {
        await igClient.sendPrivateReply(value.id, dmText);
        // Log outgoing message
        await db
          .prepare(
            `INSERT INTO messages_log (follower_id, direction, message_type, body, trigger_source)
             VALUES (?, 'out', 'text', ?, 'comment_rule')`,
          )
          .bind(follower.id, JSON.stringify({ text: dmText }))
          .run();
      } else {
        console.warn(
          `[comment-rule] rule=${rule.id} response_type=${rule.response_type} has no text — ` +
          'no policy-compliant Private Reply shape, DM skipped',
        );
      }

      break; // Only send first matching rule
    }
  }

  // Check comment-triggered scenarios — skip if a gate fired.
  // Enrollment only (no send here). The steps themselves are delivered by the
  // cron path, which enforces the 24h standard window + caps — a comment-
  // enrolled follower who never DMs is never pushed a DM (policy).
  if (gateFired) return;
  const scenarios = await getScenarios(db, { accountId });
  for (const scenario of scenarios) {
    if (scenario.trigger_type === 'comment' && scenario.is_active) {
      const keywordMatch = !scenario.trigger_keyword || commentText.toLowerCase().includes(scenario.trigger_keyword.toLowerCase());
      if (keywordMatch) {
        // Webhook-redelivery dedup (same comment id → single enrollment path).
        const claimed = await claimTriggerDelivery(db, {
          kind: 'scenario',
          triggerId: String(scenario.id),
          eventId: value.id,
          igsid: senderId,
        });
        if (!claimed) continue;
        const existing = await db
          .prepare(`SELECT id FROM follower_scenarios WHERE follower_id = ? AND scenario_id = ?`)
          .bind(follower.id, scenario.id)
          .first<{ id: string }>();
        if (!existing) {
          await enrollFriendInScenario(db, follower.id, scenario.id);
        }
      }
    }
  }

}

/**
 * Send an IG response based on message type.
 */
async function sendIgResponse(
  igClient: InstagramClient,
  recipientId: string,
  responseType: string,
  body: Record<string, unknown>,
): Promise<void> {
  switch (responseType) {
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

// ── Story/Post Mention Handler ──
// ⚠️ AUTO-DM GATED OFF (policy, 2026-07-22): a `mentions` change event is a
// mention in a comment/caption on SOMEONE ELSE'S media. That gives us
// neither an open 24h messaging window (it is not an inbound message) nor
// Private-Reply eligibility (the comment is not on OUR media) — there is NO
// documented compliant way to DM the mentioner from this webhook. The old
// behavior here (recipient:{id} thank-you DM / story_mention gate CTA) was
// exactly the unsolicited-DM class that triggers Meta enforcement against
// the connected account. We now only
// record the mentioner as a follower (CRM), and send NOTHING. A compliant
// story_mention flow must instead hang off the MESSAGING webhook
// (story_mention attachment = inbound message = open window).
async function handleMentionEvent(
  db: D1Database,
  _igClient: InstagramClient,
  value: { media_id?: string; comment_id?: string; mentioned_user_id?: string },
  _igAccount?: IgAccountRef,
  accountId?: string,
): Promise<void> {
  const mentionerId = (value as any).from?.id ?? (value as any).mentioned_user_id;
  if (!mentionerId) return;

  const mentionerUsername = (value as any).from?.username ?? 'friend';

  // Upsert follower (CRM only — no outbound send from this event, see above)
  await upsertFriend(db, {
    igsid: mentionerId,
    username: mentionerUsername,
    displayName: null,
    pictureUrl: null,
    accountId,
  });
}

export { webhook };
