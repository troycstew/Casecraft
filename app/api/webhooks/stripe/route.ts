import { NextResponse } from "next/server";
import type Stripe from "stripe";
import { stripe } from "@/lib/stripe";
import { supabaseAdmin } from "@/lib/supabaseAdmin";

export const runtime = "nodejs";

const NOTICE_DURATION_MS = 7 * 24 * 60 * 60 * 1000;

export async function POST(request: Request) {
  const signature = request.headers.get("stripe-signature");
  const webhookSecret = process.env.STRIPE_WEBHOOK_SECRET;

  if (!webhookSecret) {
    console.error("[webhooks/stripe] STRIPE_WEBHOOK_SECRET is not set — refusing to process events.");
    return NextResponse.json({ error: "Webhook not configured." }, { status: 500 });
  }
  if (!signature) {
    console.error("[webhooks/stripe] Request had no stripe-signature header — rejecting.");
    return NextResponse.json({ error: "Missing signature." }, { status: 400 });
  }

  // Signature verification needs the exact raw request body, so this
  // reads it as text rather than parsing JSON first.
  const rawBody = await request.text();

  let event: Stripe.Event;
  try {
    event = stripe.webhooks.constructEvent(rawBody, signature, webhookSecret);
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    console.error("[webhooks/stripe] signature verification failed:", message);
    return NextResponse.json({ error: `Webhook signature verification failed: ${message}` }, { status: 400 });
  }

  try {
    if (event.type === "checkout.session.completed") {
      const session = event.data.object as Stripe.Checkout.Session;
      const metadata = session.metadata || {};

      console.log(
        `[webhooks/stripe] checkout.session.completed (${session.id}), type=${metadata.type}`
      );

      if (metadata.type === "public_notice") {
        await handlePublicNoticePaid(session, metadata);
      } else if (metadata.type === "marketplace_item") {
        await handleMarketplacePurchase(session, metadata);
      } else {
        console.warn(
          `[webhooks/stripe] checkout.session.completed with unrecognized metadata.type: ${metadata.type}`
        );
      }
    } else {
      // Not an error — Stripe sends many event types to any endpoint
      // subscribed to "all events." Only checkout.session.completed is
      // wired up so far.
      console.log(`[webhooks/stripe] ignoring unhandled event type: ${event.type}`);
    }

    // Always 200 once we've successfully parsed and (attempted to)
    // handle the event, per Stripe's guidance — a non-2xx tells Stripe
    // to retry, which we only want to happen for our own bugs, not for
    // event types we intentionally ignore.
    return NextResponse.json({ received: true });
  } catch (err) {
    // A failure *handling* a verified event (e.g. the Supabase update
    // below throws) should return a non-2xx so Stripe retries the
    // webhook automatically instead of silently losing the payment
    // update.
    console.error("[webhooks/stripe] error handling verified event:", err);
    return NextResponse.json({ error: "Webhook handler failed." }, { status: 500 });
  }
}

async function handlePublicNoticePaid(
  session: Stripe.Checkout.Session,
  metadata: Stripe.Metadata
) {
  const noticeId = metadata.notice_id;
  if (!noticeId) {
    console.error("[webhooks/stripe] public_notice event missing notice_id in metadata:", session.id);
    return;
  }

  const publishedAt = new Date();
  const expiresAt = new Date(publishedAt.getTime() + NOTICE_DURATION_MS);
  const transactionId =
    typeof session.payment_intent === "string" ? session.payment_intent : session.id;

  const { error, data } = await supabaseAdmin
    .from("public_notices")
    .update({
      payment_status: "paid",
      is_active: true,
      transaction_id: transactionId,
      published_at: publishedAt.toISOString(),
      expires_at: expiresAt.toISOString(),
    })
    .eq("id", noticeId)
    // Only ever transition a notice out of 'pending' once — if the
    // webhook fires twice for the same session (Stripe explicitly
    // recommends handling this), the second update is a no-op instead
    // of resetting a already-published notice's 7-day clock.
    .eq("payment_status", "pending")
    .select("id");

  if (error) {
    console.error(`[webhooks/stripe] failed to mark notice ${noticeId} as paid:`, error.message);
    throw error; // triggers the 500 -> Stripe retry in the caller
  }
  if (!data || data.length === 0) {
    console.warn(
      `[webhooks/stripe] notice ${noticeId} was already paid (or missing) — treating as already handled.`
    );
    return;
  }

  console.log(`[webhooks/stripe] notice ${noticeId} marked paid, expires ${expiresAt.toISOString()}`);
}

async function handleMarketplacePurchase(
  session: Stripe.Checkout.Session,
  metadata: Stripe.Metadata
) {
  const { item_id: itemId, buyer_id: buyerId, seller_id: sellerId } = metadata;
  if (!itemId || !buyerId || !sellerId) {
    console.error(
      "[webhooks/stripe] marketplace_item event missing item_id/buyer_id/seller_id in metadata:",
      session.id
    );
    return;
  }

  const { error } = await supabaseAdmin.from("purchases").insert({
    marketplace_item_id: itemId,
    buyer_id: buyerId,
    seller_id: sellerId,
    stripe_session_id: session.id,
    stripe_payment_intent_id:
      typeof session.payment_intent === "string" ? session.payment_intent : null,
    amount_cents: session.amount_total ?? 0,
  });

  if (error) {
    // stripe_session_id has a unique constraint, so a retried webhook
    // for the same session hits a duplicate-key error here — that's
    // expected and not a real failure, unlike any other insert error.
    if (error.code === "23505") {
      console.warn(`[webhooks/stripe] purchase for session ${session.id} already recorded — skipping.`);
      return;
    }
    console.error(`[webhooks/stripe] failed to record purchase for session ${session.id}:`, error.message);
    throw error;
  }

  console.log(`[webhooks/stripe] purchase recorded: item ${itemId}, buyer ${buyerId}, session ${session.id}`);
