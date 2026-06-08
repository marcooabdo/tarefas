import "jsr:@supabase/functions-js/edge-runtime.d.ts";
import { createClient } from "npm:@supabase/supabase-js@2";

const corsHeaders = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Methods": "GET, POST, PUT, DELETE, OPTIONS",
  "Access-Control-Allow-Headers":
    "Content-Type, Authorization, X-Client-Info, Apikey",
};

Deno.serve(async (req: Request) => {
  if (req.method === "OPTIONS") {
    return new Response(null, { status: 200, headers: corsHeaders });
  }

  try {
    const body = await req.text();

    const supabase = createClient(
      Deno.env.get("SUPABASE_URL")!,
      Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!
    );

    const { data: rows } = await supabase
      .from("app_settings")
      .select("key, value")
      .in("key", ["relay_webhook_urls"]);
    const settings: Record<string, string> = {};
    for (const r of rows ?? []) settings[r.key] = r.value;

    const ownUrl = `${Deno.env.get("SUPABASE_URL")}/functions/v1/whatsapp-webhook`;

    const extraUrls = (settings["relay_webhook_urls"] ?? "")
      .split(",")
      .map((u: string) => u.trim())
      .filter(Boolean);

    const targets = [ownUrl, ...extraUrls];

    const results = await Promise.allSettled(
      targets.map((url) =>
        fetch(url, {
          method: "POST",
          headers: {
            "Content-Type": "application/json",
            Authorization: req.headers.get("Authorization") ?? "",
            apikey: req.headers.get("apikey") ?? "",
          },
          body,
          signal: AbortSignal.timeout(25000),
        })
          .then(async (r) => ({
            url,
            status: r.status,
            ok: r.ok,
          }))
          .catch((e) => ({ url, status: 0, ok: false, error: String(e) }))
      )
    );

    return new Response(
      JSON.stringify({
        relayed_to: targets.length,
        results: results.map((r) =>
          r.status === "fulfilled" ? r.value : { error: String(r.reason) }
        ),
      }),
      { headers: { ...corsHeaders, "Content-Type": "application/json" } }
    );
  } catch (err) {
    return new Response(
      JSON.stringify({
        error: err instanceof Error ? err.message : String(err),
      }),
      {
        status: 500,
        headers: { ...corsHeaders, "Content-Type": "application/json" },
      }
    );
  }
});
