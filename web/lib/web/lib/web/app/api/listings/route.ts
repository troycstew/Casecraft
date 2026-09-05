import { NextResponse } from "next/server";
import { supabaseAdmin } from "@/lib/supabaseAdmin";
import { requireUser } from "@/lib/auth";
import { findProhibitedTerm } from "@/lib/prohibitedTerms";

export const runtime = "nodejs";

type CreateListingBody = {
  title?: string;
  description?: string;
  category?: string;
  price?: string;
  price_cents?: number;
  disclaimer_accepted?: boolean;
};

// POST /api/listings — create a marketplace listing. Requires the UPL
// micro-disclaimer checkbox to have been confirmed, and rejects titles
// that imply legal representation before they ever reach the database.
export async function POST(request: Request) {
  const auth = await requireUser(request);
  if (auth instanceof NextResponse) return auth;
  const { userId } = auth;

  let body: CreateListingBody;
  try {
    body = await request.json();
  } catch {
    return NextResponse.json({ error: "Invalid JSON body." }, { status: 400 });
  }

  const { title, description, category, price, price_cents, disclaimer_accepted } = body;

  if (!title || !description || !category || !price) {
    return NextResponse.json(
      { error: "title, description, category, and price are all required." },
      { status: 400 }
    );
  }

  if (disclaimer_accepted !== true) {
    return NextResponse.json(
      { error: "You must confirm the UPL disclaimer before creating a listing." },
      { status: 422 }
    );
  }

  const badTerm = findProhibitedTerm(title);
  if (badTerm) {
    return NextResponse.json(
      {
        error: `Listing titles can't include "${badTerm}" — that language implies legal representation, which this marketplace doesn't offer. Rephrase the title to describe administrative or procedural help instead.`,
      },
      { status: 422 }
    );
  }

  if (price_cents !== undefined && price_cents !== null) {
    if (typeof price_cents !== "number" || price_cents <= 0) {
      return NextResponse.json(
        { error: "price_cents must be a positive number when provided." },
        { status: 400 }
      );
    }
  }

  const { data, error } = await supabaseAdmin
    .from("marketplace_items")
    .insert({
      seller_id: userId,
      title,
      description,
      category,
      price,
      price_cents: price_cents ?? null,
      disclaimer_accepted_at: new Date().toISOString(),
    })
    .select()
    .single();

  if (error) {
    console.error("[listings] failed to create listing:", error.message);
    // The database's own check constraint is the backstop if the regex
    // above ever drifts from the one in the migration.
    if (error.message.includes("marketplace_items_prohibited_terms")) {
      return NextResponse.json(
        { error: "That title isn't allowed — it implies legal representation." },
        { status: 422 }
      );
    }
    return NextResponse.json({ error: "Could not create listing." }, { status: 500 });
  }

  return NextResponse.json({ listing: data }, { status: 201 });
}
