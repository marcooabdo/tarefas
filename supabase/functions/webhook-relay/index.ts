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
    const supabaseUrl = Deno.env.get("SUPABASE_URL")!;
    const serviceKey = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!;

    const rawBody = await req.text();

    const giaUrl = `${supabaseUrl}/functions/v1/whatsapp-webhook`;

    const supabase = createClient(supabaseUrl, serviceKey);
    const { data: extraSetting } = await supabase
      .from("app_settings")
      .select("value")
      .eq("key", "webhook_relay_urls")
      .maybeSingle();

    const extraUrls: string[] = (extraSetting?.value ?? "")
      .split(/[,\n]+/)
      .map((u: string) => u.trim())
      .filter((u: string) => u.length > 0 && u.startsWith("http"));

    const allUrls = [giaUrl, ...extraUrls];

    const results: Array<{
      url: string;
      status: number | string;
      ok: boolean;
    }> = [];

    const forwards = allUrls.map(async (url) => {
      try {
        const isLocal = url.startsWith(supabaseUrl);
        const headers: Record<string, string> = {
          "Content-Type": "application/json",
        };
        if (isLocal) {
          headers["Authorization"] = `Bearer ${serviceKey}`;
        }
        const res = await fetch(url, {
          method: "POST",
          headers,
          body: rawBody,
          signal: AbortSignal.timeout(25000),
        });
        results.push({ url, status: res.status, ok: res.ok });
      } catch (err: unknown) {
        results.push({
          url,
          status: err instanceof Error ? err.message : "error",
          ok: false,
        });
      }
    });

    await Promise.allSettled(forwards);

    // Log relay failures to webhook_events for visibility
    const failedRelays = results.filter((r) => !r.ok);
    if (failedRelays.length > 0) {
      for (const r of failedRelays) {
        console.error(`[relay] FAILED ${r.url} => ${r.status}`);
      }
      // Log to DB so we can troubleshoot
      let remoteJid = "";
      try {
        const parsed = JSON.parse(rawBody);
        const d = parsed?.data ?? parsed;
        remoteJid = d?.key?.remoteJid ?? "";
      } catch { /* ignore */ }
      await supabase.from("webhook_events").insert({
        event: "relay-forward-failure",
        outcome: "error",
        remote_jid: remoteJid,
        notes: failedRelays.map((r) => `${r.url} => ${r.status}`).join("; "),
      });
    }

    return new Response(
      JSON.stringify({
        relayed_to: results.length,
        results,
      }),
      {
        headers: { ...corsHeaders, "Content-Type": "application/json" },
      }
    );
  } catch (err: unknown) {
    return new Response(
      JSON.stringify({
        error: err instanceof Error ? err.message : "Internal error",
      }),
      {
        status: 500,
        headers: { ...corsHeaders, "Content-Type": "application/json" },
      }
    );
  }
});
