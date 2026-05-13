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

    const { data: settingsRows } = await supabase.from("app_settings").select("key, value");
    const settings: Record<string, string> = {};
    for (const row of settingsRows ?? []) settings[row.key] = row.value;

    const apiUrl = settings["evolution_api_url"]?.replace(/\/$/, "");
    const apiKey = settings["evolution_api_key"];
    const instanceName = settings["evolution_instance_name"];
    const systemPrompt = settings["ai_system_prompt"] ?? "";
    const openaiKey = settings["openai_api_key"] ?? "";
    const openaiModel = settings["openai_model"] || "gpt-4o-mini";

    if (!apiUrl || !apiKey || !instanceName) {
      return new Response(JSON.stringify({ error: "Evolution API not configured" }), {
        status: 400,
        headers: { ...corsHeaders, "Content-Type": "application/json" },
      });
    }

    const now = Date.now();
    const nowIso = new Date(now).toISOString();

    const { data: tasks } = await supabase
      .from("tasks")
      .select("*")
      .neq("status", "completed")
      .eq("nudge_active", true)
      .not("first_nudge_at", "is", null)
      .lte("first_nudge_at", nowIso);

    const due_now = (tasks ?? []).filter((t) => {
      if (!t.last_ai_nudge) return true;
      if (!t.nudge_repeat_hours || t.nudge_repeat_hours <= 0) return false;
      const lastMs = new Date(t.last_ai_nudge).getTime();
      return now - lastMs >= t.nudge_repeat_hours * 60 * 60 * 1000;
    });

    const results: Array<{ task_id: string; status: string; error?: string }> = [];

    for (const task of due_now) {
      let dueLabel = "sem prazo";
      if (task.due_date) {
        const due = new Date(task.due_date);
        const diffDays = Math.ceil((Date.now() - due.getTime()) / (1000 * 60 * 60 * 24));
        dueLabel = diffDays <= 0 ? "vence hoje" : `está ${diffDays} dia(s) atrasada`;
      }
      const firstName = (task.assignee_name ?? "").split(" ")[0] || "time";
      const fallbackMessage =
        `Olá ${firstName}! Aqui é a GIA, Executive Advisor do Sr. Marco Abdo. ` +
        `A tarefa *"${task.title}"* ${dueLabel}.\n\n` +
        `Responda apenas com o número:\n` +
        `1 - Concluída\n` +
        `2 - Em execução\n` +
        `3 - Bloqueada\n\n` +
        `Ref: ${task.task_code ?? "—"}`;
      let message = fallbackMessage;
      if (openaiKey) {
        try {
          const userBrief =
            `Gere a mensagem de cobrança proativa da seguinte tarefa para envio no WhatsApp.\n` +
            `Responsável: ${task.assignee_name}\n` +
            `Tarefa: ${task.title}\n` +
            `Descrição: ${task.description ?? "—"}\n` +
            `Status do prazo: ${dueLabel}\n` +
            `Referência: ${task.task_code ?? "—"}\n\n` +
            `A mensagem DEVE incluir explicitamente, em uma única seção:\n` +
            `1 - Concluída\n2 - Em execução\n3 - Bloqueada\n\n` +
            `Termine com "Ref: ${task.task_code ?? "—"}". Não inclua nada além da mensagem final.`;
          const aiRes = await fetch("https://api.openai.com/v1/chat/completions", {
            method: "POST",
            headers: { "Content-Type": "application/json", Authorization: `Bearer ${openaiKey}` },
            body: JSON.stringify({
              model: openaiModel,
              temperature: 0.4,
              messages: [
                { role: "system", content: systemPrompt },
                { role: "user", content: userBrief },
              ],
            }),
          });
          if (aiRes.ok) {
            const j = await aiRes.json();
            const content = String(j?.choices?.[0]?.message?.content ?? "").trim();
            if (content) message = content;
          }
        } catch { /* fallback */ }
      }
      const isGroup = String(task.assignee_phone).includes("@g.us");
      const number = isGroup ? task.assignee_phone : String(task.assignee_phone).replace(/\D/g, "");

      try {
        const r = await fetch(`${apiUrl}/message/sendText/${instanceName}`, {
          method: "POST",
          headers: { "Content-Type": "application/json", apikey: apiKey },
          body: JSON.stringify({ number, text: message }),
        });
        const ok = r.ok;
        const err = ok ? null : await r.text();

        await supabase.from("send_logs").insert({
          contact_name: task.assignee_name,
          contact_phone: task.assignee_phone,
          template_name: "Cobrança proativa (atraso)",
          message_content: message,
          status: ok ? "sent" : "error",
          error_message: err,
          sent_at: new Date().toISOString(),
        });

        if (ok) {
          const isSingle = !task.nudge_repeat_hours || task.nudge_repeat_hours <= 0;
          await supabase
            .from("tasks")
            .update({
              ai_interventions: (task.ai_interventions ?? 0) + 1,
              last_ai_nudge: new Date().toISOString(),
              status: task.status === "completed" ? "completed" : "awaiting_response",
              nudge_active: !isSingle,
            })
            .eq("id", task.id);
        }

        results.push({ task_id: task.id, status: ok ? "sent" : "error", error: err ?? undefined });
      } catch (e) {
        results.push({ task_id: task.id, status: "error", error: e instanceof Error ? e.message : String(e) });
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
