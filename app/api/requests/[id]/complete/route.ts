import { NextResponse } from "next/server";
import { supabaseAdmin } from "@/lib/supabaseAdmin";
import { requireUser } from "@/lib/auth";

export const runtime = "nodejs";

// PATCH /api/requests/[id]/complete — the provider marks an accepted
// request complete, which opens the buyer's 48-hour review window.
export async function PATCH(request: Request, { params }: { params: { id: string } }) {
  const auth = await requireUser(request);
  if (auth instanceof NextResponse) return auth;
  const { userId } = auth;

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
      { error: "Only the provider on this request can mark it complete." },
      { status: 403 }
    );
  }
  if (existing.status !== "accepted") {
    return NextResponse.json(
      { error: `Only an accepted request can be marked complete (this one is "${existing.status}").` },
      { status: 409 }
    );
  }

  // status and completed_at are set together in this one write — the
  // 48-hour buyer review window (see the RLS policy in
  // supabase/migrations/0003_expiry_disclaimers_terms.sql) is measured
  // from completed_at, so it must never be set separately from the
  // status flip. See that migration's chunk 4 comment for why.
  const { data, error } = await supabaseAdmin
    .from("requests")
    .update({ status: "completed", completed_at: new Date().toISOString() })
    .eq("id", params.id)
    .eq("status", "accepted")
    .select()
    .single();

  if (error || !data) {
    console.error("[requests/complete] failed:", error?.message);
    return NextResponse.json({ error: "Could not mark this request complete." }, { status: 409 });
  }

  return NextResponse.json({ request: data });
}
