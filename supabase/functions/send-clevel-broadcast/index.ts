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
    const supabase = createClient(
      Deno.env.get("SUPABASE_URL")!,
      Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!
    );

    const { cities, message, deadline } = await req.json();

    if (!Array.isArray(cities) || cities.length === 0) {
      return new Response(
        JSON.stringify({ error: "cities array is required" }),
        {
          status: 400,
          headers: { ...corsHeaders, "Content-Type": "application/json" },
        }
      );
    }
    if (!message || typeof message !== "string" || !message.trim()) {
      return new Response(
        JSON.stringify({ error: "message is required" }),
        {
          status: 400,
          headers: { ...corsHeaders, "Content-Type": "application/json" },
        }
      );
    }

    const { data: settingsRows, error: settingsErr } = await supabase
      .from("app_settings")
      .select("key, value");

    if (settingsErr)
      throw new Error(`Settings fetch error: ${settingsErr.message}`);

    const settings: Record<string, string> = {};
    for (const row of settingsRows ?? []) {
      settings[row.key] = row.value;
    }

    const apiUrl = settings["evolution_api_url"]?.replace(/\/$/, "");
    const apiKey = settings["evolution_api_key"];
    const instanceName = settings["evolution_instance_name"];

    if (!apiUrl || !apiKey || !instanceName) {
      return new Response(
        JSON.stringify({ error: "Evolution API not configured" }),
        {
          status: 400,
          headers: { ...corsHeaders, "Content-Type": "application/json" },
        }
      );
    }

    const { data: groupRows, error: groupErr } = await supabase
      .from("clevel_groups")
      .select("*, contacts(id, name, remote_jid)")
      .in("city", cities)
      .eq("active", true);

    if (groupErr) throw new Error(`Groups fetch error: ${groupErr.message}`);

    const groups = groupRows ?? [];
    const groupsTargeted = groups.length;

    if (groupsTargeted === 0) {
      return new Response(
        JSON.stringify({
          error: "No active C-LEVEL groups found for selected cities",
          groups_targeted: 0,
          groups_sent: 0,
        }),
        {
          status: 200,
          headers: { ...corsHeaders, "Content-Type": "application/json" },
        }
      );
    }

    let finalMessage = message.trim();
    if (deadline && typeof deadline === "string" && deadline.trim()) {
      finalMessage += `\n\n*Prazo: ${deadline.trim()}*`;
    }

    let groupsSent = 0;
    const results: Array<{
      group: string;
      city: string;
      status: string;
      error?: string;
    }> = [];

    for (const g of groups) {
      const contact = g.contacts as {
        id: string;
        name: string;
        remote_jid: string | null;
      } | null;
      if (!contact?.remote_jid) {
        results.push({
          group: contact?.name ?? "unknown",
          city: g.city,
          status: "error",
          error: "No remote_jid",
        });
        continue;
      }

      try {
        const sendRes = await fetch(
          `${apiUrl}/message/sendText/${instanceName}`,
          {
            method: "POST",
            headers: {
              "Content-Type": "application/json",
              apikey: apiKey,
            },
            body: JSON.stringify({
              number: contact.remote_jid,
              text: finalMessage,
            }),
          }
        );

        if (sendRes.ok) {
          groupsSent++;
          results.push({
            group: contact.name,
            city: g.city,
            status: "sent",
          });
        } else {
          const errText = await sendRes.text();
          results.push({
            group: contact.name,
            city: g.city,
            status: "error",
            error: `HTTP ${sendRes.status}: ${errText.slice(0, 200)}`,
          });
        }
      } catch (err: unknown) {
        results.push({
          group: contact.name,
          city: g.city,
          status: "error",
          error: err instanceof Error ? err.message : "Network error",
        });
      }
    }

    const broadcastStatus =
      groupsSent === groupsTargeted
        ? "sent"
        : groupsSent > 0
          ? "partial"
          : "error";

    await supabase.from("clevel_broadcasts").insert({
      message: finalMessage,
      cities,
      deadline: deadline?.trim() ?? "",
      groups_targeted: groupsTargeted,
      groups_sent: groupsSent,
      status: broadcastStatus,
    });

    return new Response(
      JSON.stringify({
        groups_targeted: groupsTargeted,
        groups_sent: groupsSent,
        status: broadcastStatus,
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
