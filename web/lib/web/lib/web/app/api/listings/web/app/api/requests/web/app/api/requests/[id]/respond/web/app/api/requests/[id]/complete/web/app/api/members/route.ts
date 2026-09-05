import { NextResponse } from "next/server";
import { supabaseAdmin } from "@/lib/supabaseAdmin";

export const runtime = "nodejs";

const VALID_ROLES = [
  "Former Pro Se Litigant",
  "Current Litigant",
  "Paralegal",
  "Lay Advocate",
  "Scholar or Student",
  "Justice-Access Enthusiast",
] as const;

const PAGE_SIZE = 25;

// GET /api/members?state=NJ&role=Paralegal&page=1 — the public
// "Membership Roll" directory. No auth required: public_profiles never
// selects phone/email, and the underlying RLS policy already allows
// anyone to read it, so this is safe to leave open.
export async function GET(request: Request) {
  const { searchParams } = new URL(request.url);
  const state = searchParams.get("state");
  const role = searchParams.get("role");
  const page = Math.max(1, parseInt(searchParams.get("page") || "1", 10) || 1);

  if (role && !VALID_ROLES.includes(role as (typeof VALID_ROLES)[number])) {
    return NextResponse.json(
      { error: `role must be one of: ${VALID_ROLES.join(", ")}` },
      { status: 400 }
    );
  }

  let query = supabaseAdmin
    .from("public_profiles")
    .select("id, name, alias, state_abbr, formatted_username, role, bio, avatar_url, created_at", {
      count: "exact",
    })
    .order("created_at", { ascending: false })
    .range((page - 1) * PAGE_SIZE, page * PAGE_SIZE - 1);

  if (state) {
    query = query.eq("state_abbr", state.toUpperCase());
  }
  if (role) {
    query = query.eq("role", role);
  }

  const { data, error, count } = await query;

  if (error) {
    console.error("[members] query failed:", error.message);
    return NextResponse.json({ error: "Could not load the membership roll." }, { status: 500 });
  }

  return NextResponse.json({
    members: data,
    page,
    page_size: PAGE_SIZE,
    total: count ?? null,
  });
}
