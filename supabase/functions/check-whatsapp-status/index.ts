import "jsr:@supabase/functions-js/edge-runtime.d.ts";
import { createClient } from "npm:@supabase/supabase-js@2";

const corsHeaders = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Methods": "GET, POST, OPTIONS",
  "Access-Control-Allow-Headers": "Content-Type, Authorization, X-Client-Info, Apikey",
};

Deno.serve(async (req: Request) => {
  if (req.method === "OPTIONS") {
    return new Response(null, { status: 200, headers: corsHeaders });
  }

  try {
    const supabase = createClient(
      Deno.env.get("SUPABASE_URL")!,
      Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!
    );

    const { data: rows } = await supabase.from("app_settings").select("key, value");
    const s: Record<string, string> = {};
    for (const r of rows ?? []) s[r.key] = r.value;

    const apiUrl = s["evolution_api_url"]?.replace(/\/$/, "");
    const apiKey = s["evolution_api_key"];
    const instanceName = s["evolution_instance_name"];

    if (!apiUrl || !apiKey || !instanceName) {
      return new Response(
        JSON.stringify({ connected: false, reason: "not_configured" }),
        { headers: { ...corsHeaders, "Content-Type": "application/json" } }
      );
    }

    try {
      const res = await fetch(
        `${apiUrl}/instance/connectionState/${instanceName}`,
        { headers: { apikey: apiKey }, signal: AbortSignal.timeout(8000) }
      );
      if (!res.ok) {
        return new Response(
          JSON.stringify({ connected: false, reason: "http_error", status: res.status }),
          { headers: { ...corsHeaders, "Content-Type": "application/json" } }
        );
      }
      const data = await res.json();
      const state = data?.instance?.state ?? data?.state ?? data?.status;
      const connected = state === "open" || state === "connected";
      return new Response(
        JSON.stringify({ connected, state, instance: instanceName }),
        { headers: { ...corsHeaders, "Content-Type": "application/json" } }
      );
    } catch (e) {
      return new Response(
        JSON.stringify({
          connected: false,
          reason: "network_error",
          error: e instanceof Error ? e.message : String(e),
        }),
        { headers: { ...corsHeaders, "Content-Type": "application/json" } }
      );
    }
  } catch (err) {
    return new Response(
      JSON.stringify({ error: err instanceof Error ? err.message : String(err) }),
      { status: 500, headers: { ...corsHeaders, "Content-Type": "application/json" } }
    );
  }
});
