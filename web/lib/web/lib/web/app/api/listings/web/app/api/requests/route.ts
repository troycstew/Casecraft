import { NextResponse } from "next/server";
import { supabaseAdmin } from "@/lib/supabaseAdmin";
import { requireUser } from "@/lib/auth";

export const runtime = "nodejs";

type CreateRequestBody = {
  marketplace_item_id?: string;
  // Only used when marketplace_item_id is absent — e.g. a reply to a
  // Public Notice, which has no marketplace_items row to look up.
  provider_id?: string;
  listing_title?: string;
  source_type?: "notice";
  source_id?: string;
  disclaimer_accepted?: boolean;
};

// POST /api/requests — a buyer sending a structured service request.
// Starts life as status "pending"; a separate pg_cron job (see
// supabase/migrations/0003_expiry_disclaimers_terms.sql) flips it to
// "expired" if the provider hasn't responded within 72 hours.
export async function POST(request: Request) {
  const auth = await requireUser(request);
  if (auth instanceof NextResponse) return auth;
  const { userId: buyerId } = auth;

  let body: CreateRequestBody;
  try {
    body = await request.json();
  } catch {
    return NextResponse.json({ error: "Invalid JSON body." }, { status: 400 });
  }

  if (body.disclaimer_accepted !== true) {
    return NextResponse.json(
      { error: "You must confirm the UPL disclaimer before sending a request." },
      { status: 422 }
    );
  }

  let providerId: string;
  let listingTitle: string;
  let marketplaceItemId: string | null = null;

  if (body.marketplace_item_id) {
    const { data: item, error: itemError } = await supabaseAdmin
      .from("marketplace_items")
      .select("id, seller_id, title, status")
      .eq("id", body.marketplace_item_id)
      .single();

    if (itemError || !item) {
      return NextResponse.json({ error: "Listing not found." }, { status: 404 });
    }
    if (item.status !== "active") {
      return NextResponse.json({ error: "This listing is no longer available." }, { status: 409 });
    }

    providerId = item.seller_id;
    listingTitle = item.title;
    marketplaceItemId = item.id;
  } else {
    if (!body.provider_id || !body.listing_title) {
      return NextResponse.json(
        {
          error:
            "Provide marketplace_item_id, or both provider_id and listing_title for a notice-sourced request.",
        },
        { status: 400 }
      );
    }
    providerId = body.provider_id;
    listingTitle = body.listing_title;
  }

  if (providerId === buyerId) {
    return NextResponse.json({ error: "You can't send a request to yourself." }, { status: 403 });
  }

  const { data, error } = await supabaseAdmin
    .from("requests")
    .insert({
      marketplace_item_id: marketplaceItemId,
      listing_title: listingTitle,
      provider_id: providerId,
      buyer_id: buyerId,
      source_type: body.source_type ?? null,
      source_id: body.source_id ?? null,
      disclaimer_accepted_at: new Date().toISOString(),
    })
    .select()
    .single();

  if (error) {
    console.error("[requests] failed to create request:", error.message);
    return NextResponse.json({ error: "Could not send request." }, { status: 500 });
  }

  return NextResponse.json({ request: data }, { status: 201 });
}
