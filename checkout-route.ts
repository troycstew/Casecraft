import { NextResponse } from "next/server";
import { stripe } from "@/lib/stripe";
import { supabaseAdmin } from "@/lib/supabaseAdmin";

// Stripe's SDK needs Node's crypto/http internals — don't run this on
// the Edge runtime.
export const runtime = "nodejs";

const PUBLIC_NOTICE_FEE_CENTS = 1000; // $10.00, non-refundable, per SPEC.md Directive 4

type CreateSessionBody =
  | { type: "public_notice"; notice_id: string }
  | { type: "marketplace_item"; item_id: string };

export async function POST(request: Request) {
  // --- Identify the caller ---
  // The client must send the signed-in member's Supabase access token
  // (`Authorization: Bearer <access_token>`). We verify it server-side
  // rather than trusting a user_id in the request body, so a member
  // can never create a paid session — or a paid *notice* — on someone
  // else's behalf.
  const authHeader = request.headers.get("authorization") || "";
  const accessToken = authHeader.startsWith("Bearer ") ? authHeader.slice(7) : null;

  if (!accessToken) {
    return NextResponse.json({ error: "Missing Authorization header." }, { status: 401 });
  }

  const { data: userData, error: userError } = await supabaseAdmin.auth.getUser(accessToken);
  if (userError || !userData?.user) {
    console.error("[checkout/create-session] could not verify caller:", userError?.message);
    return NextResponse.json({ error: "Not signed in." }, { status: 401 });
  }
  const callerId = userData.user.id;

  let body: CreateSessionBody;
  try {
    body = await request.json();
  } catch {
    return NextResponse.json({ error: "Invalid JSON body." }, { status: 400 });
  }

  const siteUrl = process.env.NEXT_PUBLIC_SITE_URL || "http://localhost:3000";

  try {
    if (body.type === "public_notice") {
      const { notice_id } = body;
      if (!notice_id) {
        return NextResponse.json({ error: "notice_id is required." }, { status: 400 });
      }

      const { data: notice, error: noticeError } = await supabaseAdmin
        .from("public_notices")
        .select("id, user_id, payment_status")
        .eq("id", notice_id)
        .single();

      if (noticeError || !notice) {
        return NextResponse.json({ error: "Notice not found." }, { status: 404 });
      }
      if (notice.user_id !== callerId) {
        return NextResponse.json({ error: "You can only pay for your own notice." }, { status: 403 });
      }
      if (notice.payment_status === "paid") {
        return NextResponse.json({ error: "This notice has already been paid for." }, { status: 409 });
      }

      const session = await stripe.checkout.sessions.create({
        mode: "payment",
        payment_method_types: ["card"],
        line_items: [
          {
            price_data: {
              currency: "usd",
              unit_amount: PUBLIC_NOTICE_FEE_CENTS,
              product_data: {
                name: "Pro Se Commons — Public Notice (7-day listing)",
              },
            },
            quantity: 1,
          },
        ],
        metadata: {
          type: "public_notice",
          user_id: callerId,
          notice_id,
        },
        success_url: `${siteUrl}/notices/${notice_id}?checkout=success`,
        cancel_url: `${siteUrl}/notices/${notice_id}?checkout=cancelled`,
      });

      return NextResponse.json({ url: session.url });
    }

    if (body.type === "marketplace_item") {
      const { item_id } = body;
      if (!item_id) {
        return NextResponse.json({ error: "item_id is required." }, { status: 400 });
      }

      const { data: item, error: itemError } = await supabaseAdmin
        .from("marketplace_items")
        .select("id, seller_id, status, price_cents")
        .eq("id", item_id)
        .single();

      if (itemError || !item) {
        return NextResponse.json({ error: "Listing not found." }, { status: 404 });
      }
      if (item.status !== "active") {
        return NextResponse.json({ error: "This listing is no longer available." }, { status: 409 });
      }
      if (item.seller_id === callerId) {
        return NextResponse.json({ error: "You can't purchase your own listing." }, { status: 403 });
      }
      if (!item.price_cents) {
        // Free-text hourly-rate listings ("$20/hr") don't have a fixed
        // amount to charge through Checkout — those get settled off-
        // platform once a request is accepted, same as today. Only
        // listings with a real price_cents value are payable here.
        return NextResponse.json(
          { error: "This listing isn't set up for in-app payment yet." },
          { status: 422 }
        );
      }

      const session = await stripe.checkout.sessions.create({
        mode: "payment",
        payment_method_types: ["card"],
        line_items: [
          {
            price_data: {
              currency: "usd",
              unit_amount: item.price_cents,
              product_data: {
                name: "Pro Se Commons — marketplace purchase",
              },
            },
            quantity: 1,
          },
        ],
        metadata: {
          type: "marketplace_item",
          item_id,
          buyer_id: callerId,
          seller_id: item.seller_id,
        },
        success_url: `${siteUrl}/marketplace/${item_id}?checkout=success`,
        cancel_url: `${siteUrl}/marketplace/${item_id}?checkout=cancelled`,
      });

      return NextResponse.json({ url: session.url });
    }

    return NextResponse.json({ error: "Unknown checkout type." }, { status: 400 });
  } catch (err) {
    console.error("[checkout/create-session] failed to create Stripe session:", err);
    return NextResponse.json({ error: "Could not start checkout." }, { status: 500 });
  }
}
