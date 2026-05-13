import "jsr:@supabase/functions-js/edge-runtime.d.ts";
import { createClient } from "npm:@supabase/supabase-js@2";

const corsHeaders = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Methods": "GET, POST, PUT, DELETE, OPTIONS",
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

    const body = await req.json();
    const taskId = body?.task_id as string | undefined;
    if (!taskId) {
      return new Response(
        JSON.stringify({ error: "task_id is required" }),
        { status: 400, headers: { ...corsHeaders, "Content-Type": "application/json" } }
      );
    }

    const { data: task, error: taskErr } = await supabase
      .from("tasks")
      .select("*")
      .eq("id", taskId)
      .maybeSingle();

    if (taskErr || !task) {
      return new Response(
        JSON.stringify({ error: "Task not found" }),
        { status: 404, headers: { ...corsHeaders, "Content-Type": "application/json" } }
      );
    }

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
      return new Response(
        JSON.stringify({ error: "Evolution API not configured" }),
        { status: 400, headers: { ...corsHeaders, "Content-Type": "application/json" } }
      );
    }

    const due = task.due_date ? new Date(task.due_date) : null;
    let dueLabel = "sem prazo";
    if (due) {
      const diffDays = Math.ceil((due.getTime() - Date.now()) / (1000 * 60 * 60 * 24));
      if (diffDays < 0) dueLabel = `${Math.abs(diffDays)} dia(s) atrasada`;
      else if (diffDays === 0) dueLabel = "vence hoje";
      else if (diffDays === 1) dueLabel = "vence amanhã";
      else dueLabel = `vence em ${diffDays} dia(s)`;
    }

    const fallbackMessage =
      `Olá ${task.assignee_name}! Aqui é a GIA, Executive Advisor do Sr. Marco Abdo. ` +
      `Passando para conferir o status da tarefa *"${task.title}"* (${dueLabel}).\n\n` +
      `Responda apenas com o número correspondente:\n` +
      `1 - Concluída\n` +
      `2 - Em execução\n` +
      `3 - Bloqueada\n\n` +
      `Ref: ${task.task_code ?? "—"}`;

    let message = fallbackMessage;
    if (openaiKey) {
      try {
        const userBrief =
          `Gere a mensagem de cobrança da seguinte tarefa para envio no WhatsApp.\n` +
          `Responsável: ${task.assignee_name}\n` +
          `Tarefa: ${task.title}\n` +
          `Descrição: ${task.description ?? "—"}\n` +
          `Prazo: ${dueLabel}\n` +
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

    let status: "sent" | "error" = "sent";
    let errorMessage: string | null = null;

    try {
      const sendRes = await fetch(`${apiUrl}/message/sendText/${instanceName}`, {
        method: "POST",
        headers: { "Content-Type": "application/json", apikey: apiKey },
        body: JSON.stringify({ number, text: message }),
      });
      if (!sendRes.ok) {
        const body = await sendRes.text();
        throw new Error(`HTTP ${sendRes.status}: ${body}`);
      }
    } catch (e) {
      status = "error";
      errorMessage = e instanceof Error ? e.message : String(e);
    }

    const now = new Date().toISOString();

    await supabase.from("send_logs").insert({
      contact_name: task.assignee_name,
      contact_phone: task.assignee_phone,
      template_name: "Cobrança IA",
      message_content: message,
      status,
      error_message: errorMessage,
      sent_at: now,
    });

    if (status === "sent") {
      await supabase
        .from("tasks")
        .update({
          ai_interventions: (task.ai_interventions ?? 0) + 1,
          last_ai_nudge: now,
          status: task.status === "completed" ? "completed" : "awaiting_response",
        })
        .eq("id", taskId);
    }

    return new Response(
      JSON.stringify({ status, error: errorMessage, message }),
      { status: status === "sent" ? 200 : 502, headers: { ...corsHeaders, "Content-Type": "application/json" } }
    );
  } catch (err) {
    return new Response(
      JSON.stringify({ error: err instanceof Error ? err.message : String(err) }),
      { status: 500, headers: { ...corsHeaders, "Content-Type": "application/json" } }
    );
  }
});
