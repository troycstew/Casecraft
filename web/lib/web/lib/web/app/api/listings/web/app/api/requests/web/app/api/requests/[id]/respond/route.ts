import { NextResponse } from "next/server";
import { supabaseAdmin } from "@/lib/supabaseAdmin";
import { requireUser } from "@/lib/auth";

export const runtime = "nodejs";

type RespondBody = { action?: "accept" | "decline" };

// PATCH /api/requests/[id]/respond — the provider accepts or declines a
// pending request. Accepting is what unlocks messaging/contact info on
// the client side (via get_contact_phone() + the requests RLS policy),
// once status flips to "accepted".
export async function PATCH(request: Request, { params }: { params: { id: string } }) {
  const auth = await requireUser(request);
  if (auth instanceof NextResponse) return auth;
  const { userId } = auth;

  let body: RespondBody;
  try {
    body = await request.json();
  } catch {
    return NextResponse.json({ error: "Invalid JSON body." }, { status: 400 });
  }

  if (body.action !== "accept" && body.action !== "decline") {
    return NextResponse.json({ error: 'action must be "accept" or "decline".' }, { status: 400 });
  }

  const { data: existing, error: fetchError } = await supabaseAdmin
    .from("requests")
    .select("id, provider_id, status")
    .eq("id", params.id)
    .single();

  if (fetchError || !existing) {
    return NextResponse.json({ error: "Request not found." }, { status: 404 });
  }
  if (existing.provider_id !== userId) {
    return NextResponse.json(
      { error: "Only the provider on this request can accept or decline it." },
      { status: 403 }
    );
  }
  if (existing.status !== "pending") {
    return NextResponse.json(
      { error: `This request is already "${existing.status}" and can't be responded to again.` },
      { status: 409 }
    );
  }

  const newStatus = body.action === "accept" ? "accepted" : "declined";

  // The extra .eq("status", "pending") guards against a race with the
  // 72-hour auto-expire cron job flipping this same row between the
  // fetch above and this update.
  const { data, error } = await supabaseAdmin
    .from("requests")
    .update({ status: newStatus, responded_at: new Date().toISOString() })
    .eq("id", params.id)
    .eq("status", "pending")
    .select()
    .single();

  if (error || !data) {
    console.error("[requests/respond] failed:", error?.message);
    return NextResponse.json(
      { error: "Could not update the request — it may have just expired." },
      { status: 409 }
    );
  }

  return NextResponse.json({ request: data });
}
