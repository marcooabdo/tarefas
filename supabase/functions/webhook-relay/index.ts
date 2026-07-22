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
