import "jsr:@supabase/functions-js/edge-runtime.d.ts";
import { createClient } from "npm:@supabase/supabase-js@2";

const corsHeaders = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Methods": "GET, POST, OPTIONS",
  "Access-Control-Allow-Headers": "Content-Type, Authorization, X-Client-Info, Apikey",
};

function getSaudacao(hour: number): string {
  if (hour < 12) return "Bom dia";
  if (hour < 18) return "Boa tarde";
  return "Boa noite";
}

function renderTemplate(content: string, variables: Record<string, string>): string {
  return content.replace(/\{(\w+)\}/g, (_, key) => variables[key] ?? `{${key}}`);
}

Deno.serve(async (req: Request) => {
  if (req.method === "OPTIONS") {
    return new Response(null, { status: 200, headers: corsHeaders });
  }

  try {
    const supabase = createClient(
      Deno.env.get("SUPABASE_URL")!,
      Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!
    );

    let forceScheduleId: string | null = null;
    if (req.method === "POST") {
      try {
        const body = await req.json();
        forceScheduleId = body?.force_schedule_id ?? null;
      } catch {
        // no body
      }
    }

    const { data: settingsRows, error: settingsErr } = await supabase
      .from("app_settings")
      .select("key, value");

    if (settingsErr) throw new Error(`Settings fetch error: ${settingsErr.message}`);

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
        { status: 400, headers: { ...corsHeaders, "Content-Type": "application/json" } }
      );
    }

    const now = new Date();
    const brazilOffset = -3;
    const utcMs = now.getTime() + now.getTimezoneOffset() * 60000;
    const brazilNow = new Date(utcMs + brazilOffset * 3600000);

    const currentHour = brazilNow.getHours();
    const currentMinute = brazilNow.getMinutes();
    const currentDay = brazilNow.getDay();
    const currentTime = `${String(currentHour).padStart(2, "0")}:${String(currentMinute).padStart(2, "0")}`;

    let schedulesQuery = supabase
      .from("schedules")
      .select("*, message_templates(*)");

    if (forceScheduleId) {
      schedulesQuery = schedulesQuery.eq("id", forceScheduleId);
    } else {
      schedulesQuery = schedulesQuery.eq("active", true).eq("send_once", false);
    }

    const { data: schedules, error: schedErr } = await schedulesQuery;
    if (schedErr) throw new Error(`Schedules fetch error: ${schedErr.message}`);

    const dueSchedules = forceScheduleId
      ? (schedules ?? [])
      : (schedules ?? []).filter((s) => {
          return s.send_time === currentTime && s.days_of_week.includes(currentDay);
        });

    if (dueSchedules.length === 0) {
      return new Response(
        JSON.stringify({ message: "No schedules due", time: currentTime, day: currentDay }),
        { headers: { ...corsHeaders, "Content-Type": "application/json" } }
      );
    }

    const results: { schedule: string; contact: string; status: string; error?: string }[] = [];

    for (const schedule of dueSchedules) {
      const template = schedule.message_templates;
      if (!template) continue;

      let contactsQuery = supabase.from("contacts").select("*").eq("active", true);

      if (schedule.contact_ids && schedule.contact_ids.length > 0) {
        contactsQuery = contactsQuery.in("id", schedule.contact_ids);
      }

      const { data: contacts, error: contactsErr } = await contactsQuery;
      if (contactsErr) throw new Error(`Contacts fetch error: ${contactsErr.message}`);

      const activeContacts = contacts ?? [];

      for (const contact of activeContacts) {
        const phone = contact.phone.replace(/\D/g, "");

        const variables: Record<string, string> = {
          nome: contact.name,
          saudacao: getSaudacao(currentHour),
          setor: contact.department ?? "",
          data: brazilNow.toLocaleDateString("pt-BR"),
          hora: currentTime,
        };

        const message = renderTemplate(template.content, variables);

        let status = "sent";
        let errorMessage: string | null = null;

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
                number: phone,
                text: message,
              }),
            }
          );

          if (!sendRes.ok) {
            const body = await sendRes.text();
            throw new Error(`HTTP ${sendRes.status}: ${body}`);
          }
        } catch (e) {
          status = "error";
          errorMessage = e instanceof Error ? e.message : String(e);
        }

        await supabase.from("send_logs").insert({
          contact_id: contact.id,
          contact_name: contact.name,
          contact_phone: contact.phone,
          template_id: template.id,
          template_name: template.name,
          message_content: message,
          status,
          error_message: errorMessage,
          sent_at: new Date().toISOString(),
        });

        results.push({ schedule: schedule.name, contact: contact.name, status, error: errorMessage ?? undefined });
      }
    }

    return new Response(
      JSON.stringify({ processed: results.length, results }),
      { headers: { ...corsHeaders, "Content-Type": "application/json" } }
    );
  } catch (err) {
    return new Response(
      JSON.stringify({ error: err instanceof Error ? err.message : String(err) }),
      { status: 500, headers: { ...corsHeaders, "Content-Type": "application/json" } }
    );
  }
});
