import "jsr:@supabase/functions-js/edge-runtime.d.ts";
import { createClient } from "npm:@supabase/supabase-js@2.49.4";

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
    const serviceRoleKey = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!;
    const supabase = createClient(supabaseUrl, serviceRoleKey);

    const nowIso = new Date().toISOString();

    // Find approved messages whose scheduled_send_at has arrived and haven't been sent yet
    const { data: pendingSends, error: fetchErr } = await supabase
      .from("pending_message_approvals")
      .select("*")
      .eq("status", "approved")
      .eq("sent", false)
      .not("scheduled_send_at", "is", null)
      .lte("scheduled_send_at", nowIso);

    if (fetchErr) {
      console.error("Error fetching scheduled sends:", fetchErr);
      return new Response(
        JSON.stringify({ error: fetchErr.message }),
        { status: 500, headers: { ...corsHeaders, "Content-Type": "application/json" } }
      );
    }

    if (!pendingSends || pendingSends.length === 0) {
      return new Response(
        JSON.stringify({ message: "No scheduled sends due", count: 0 }),
        { headers: { ...corsHeaders, "Content-Type": "application/json" } }
      );
    }

    console.log(`Processing ${pendingSends.length} scheduled send(s)`);

    // Load Evolution API settings
    const { data: settings } = await supabase
      .from("app_settings")
      .select("key, value")
      .in("key", ["evolution_api_url", "evolution_api_key", "evolution_instance"]);

    const settingsMap: Record<string, string> = {};
    (settings ?? []).forEach((s: { key: string; value: string }) => {
      settingsMap[s.key] = s.value;
    });

    const evoUrl = settingsMap["evolution_api_url"];
    const evoKey = settingsMap["evolution_api_key"];
    const evoInstance = settingsMap["evolution_instance"];

    if (!evoUrl || !evoKey || !evoInstance) {
      console.error("Evolution API settings not configured");
      return new Response(
        JSON.stringify({ error: "Evolution API settings missing" }),
        { status: 500, headers: { ...corsHeaders, "Content-Type": "application/json" } }
      );
    }

    let sentCount = 0;

    for (const approval of pendingSends) {
      const phone = approval.assignee_phone;
      const message = approval.proposed_message;
      const taskDraft = approval.task_draft ?? {};
      const isGroup = phone.includes("@g.us");

      try {
        // Send via Evolution API
        const endpoint = isGroup ? "sendText" : "sendText";
        const sendUrl = `${evoUrl}/message/${endpoint}/${evoInstance}`;
        const body: Record<string, unknown> = {
          number: phone,
          text: message,
        };

        const evoRes = await fetch(sendUrl, {
          method: "POST",
          headers: {
            "Content-Type": "application/json",
            apikey: evoKey,
          },
          body: JSON.stringify(body),
        });

        if (!evoRes.ok) {
          const errText = await evoRes.text();
          console.error(`Failed to send to ${phone}: ${errText}`);
          continue;
        }

        // Mark as sent
        await supabase
          .from("pending_message_approvals")
          .update({ sent: true })
          .eq("id", approval.id);

        // Log to send_logs
        await supabase.from("send_logs").insert({
          contact_name: approval.assignee_name,
          contact_phone: phone,
          template_name: "Mensagem direta (GIA NL)",
          message_content: message,
          status: "sent",
          sent_at: new Date().toISOString(),
        });

        // If there's a linked task, update it
        if (approval.task_id) {
          await supabase
            .from("tasks")
            .update({
              status: "awaiting_response",
              ai_interventions: (approval.ai_interventions ?? 0) + 1,
              last_ai_nudge: new Date().toISOString(),
              nudge_active: !!taskDraft.nudge_active,
            })
            .eq("id", approval.task_id);
        } else if (!taskDraft.message_only) {
          // Create a task from the draft if needed
          const { data: newTask } = await supabase
            .from("tasks")
            .insert({
              title: taskDraft.title || "Tarefa sem título",
              description: taskDraft.description || "",
              assignee_name: approval.assignee_name || "",
              assignee_phone: phone,
              group_name: taskDraft.group_name || "",
              status: "awaiting_response",
              priority: taskDraft.priority || "medium",
              due_date: taskDraft.due_date || null,
              recurrence: taskDraft.recurrence || "none",
              recurrence_interval: taskDraft.recurrence_interval || 1,
              first_nudge_at: taskDraft.first_nudge_at || null,
              nudge_repeat_hours: taskDraft.nudge_repeat_hours || 0,
              nudge_active: !!taskDraft.nudge_active,
              gia_instruction: taskDraft.gia_instruction || "",
              ai_interventions: 1,
              last_ai_nudge: new Date().toISOString(),
            })
            .select("id")
            .maybeSingle();

          if (newTask) {
            await supabase
              .from("pending_message_approvals")
              .update({ task_id: newTask.id })
              .eq("id", approval.id);
          }
        }

        // Notify the owner that the scheduled message was sent
        const ownerJid = approval.owner_jid;
        if (ownerJid) {
          const ownerPhone = ownerJid.replace("@s.whatsapp.net", "");
          const notifyMsg = `Mensagem agendada enviada para ${approval.assignee_name}. (${taskDraft.title || ""})`;
          await fetch(`${evoUrl}/message/sendText/${evoInstance}`, {
            method: "POST",
            headers: { "Content-Type": "application/json", apikey: evoKey },
            body: JSON.stringify({ number: ownerPhone, text: notifyMsg }),
          });
        }

        sentCount++;
        console.log(`Sent scheduled message to ${approval.assignee_name} (${phone})`);
      } catch (err) {
        console.error(`Error sending to ${phone}:`, err);
      }
    }

    return new Response(
      JSON.stringify({ message: `Processed ${sentCount} scheduled send(s)`, count: sentCount }),
      { headers: { ...corsHeaders, "Content-Type": "application/json" } }
    );
  } catch (err) {
    console.error("Unexpected error:", err);
    return new Response(
      JSON.stringify({ error: (err as Error).message }),
      { status: 500, headers: { ...corsHeaders, "Content-Type": "application/json" } }
    );
  }
});
