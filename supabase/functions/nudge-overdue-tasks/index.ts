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

    const maxNudges = Number(settings["default_max_nudges"] || "0") || 0;

    const due_now = (tasks ?? []).filter((t) => {
      if (maxNudges > 0 && (t.ai_interventions ?? 0) >= maxNudges) return false;
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
        const nowDate = new Date();
        const dueDay = new Date(due.getFullYear(), due.getMonth(), due.getDate());
        const todayDay = new Date(nowDate.getFullYear(), nowDate.getMonth(), nowDate.getDate());
        const diffDays = Math.round((todayDay.getTime() - dueDay.getTime()) / (1000 * 60 * 60 * 24));
        dueLabel = diffDays <= 0 ? "vence hoje" : `está ${diffDays} dia(s) atrasada`;
      }
      const firstName = (task.assignee_name ?? "").split(" ")[0] || "time";
      const descriptionText = task.description ? `\nDetalhes: ${task.description}` : "";
      const fallbackMessage =
        `Olá ${firstName}! Aqui é a GIA, Executive Advisor do Sr. Marco Abdo.\n\n` +
        `Preciso de uma atualização sobre: *"${task.title}"*${descriptionText}\n` +
        `Prazo: ${dueLabel}.\n\n` +
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
            `Descrição completa: ${task.description || "Nenhuma descrição adicional"}\n` +
            `Status do prazo: ${dueLabel}\n` +
            `Referência: ${task.task_code ?? "—"}\n\n` +
            `INSTRUÇÕES OBRIGATÓRIAS:\n` +
            `- Explique claramente para a pessoa O QUE é a tarefa usando o título e a descrição fornecidos.\n` +
            `- Contextualize o que precisa ser feito de forma objetiva para que a pessoa entenda exatamente do que se trata.\n` +
            `- A mensagem DEVE incluir explicitamente as opções de resposta:\n` +
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
      let number = isGroup ? task.assignee_phone : String(task.assignee_phone).replace(/\D/g, "");
      if (!isGroup && number.length <= 11) number = "55" + number;

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

        const isSingle = !task.nudge_repeat_hours || task.nudge_repeat_hours <= 0;
        if (ok) {
          await supabase
            .from("tasks")
            .update({
              ai_interventions: (task.ai_interventions ?? 0) + 1,
              last_ai_nudge: new Date().toISOString(),
              status: task.status === "completed" ? "completed" : "awaiting_response",
              nudge_active: !isSingle,
            })
            .eq("id", task.id);
        } else {
          await supabase
            .from("tasks")
            .update({
              last_ai_nudge: new Date().toISOString(),
              nudge_active: !isSingle,
            })
            .eq("id", task.id);
        }

        results.push({ task_id: task.id, status: ok ? "sent" : "error", error: err ?? undefined });
      } catch (e) {
        results.push({ task_id: task.id, status: "error", error: e instanceof Error ? e.message : String(e) });
      }
    }

    // Send consolidated overdue report to GIA admin number
    const reportPhone = settings["gia_report_phone"];
    let reportSent = false;
    if (reportPhone && due_now.length > 0) {
      const pad2 = (n: number) => String(n).padStart(2, "0");
      const fmtDate = (iso: string) => {
        const d = new Date(iso);
        const br = new Date(d.getTime() - 3 * 60 * 60 * 1000);
        return `${pad2(br.getUTCDate())}/${pad2(br.getUTCMonth() + 1)} ${pad2(br.getUTCHours())}:${pad2(br.getUTCMinutes())}`;
      };
      const nowStr = fmtDate(new Date().toISOString());
      const lines: string[] = [
        `*RELATORIO DE TAREFAS VENCIDAS*`,
        `Data: ${nowStr}`,
        `Total: ${due_now.length} tarefa(s) cobrada(s) agora`,
        ``,
        `---`,
      ];
      for (const t of due_now) {
        const assignee = t.assignee_name || "Sem responsavel";
        const phone = t.assignee_phone || "—";
        const dueStr = t.due_date ? fmtDate(t.due_date) : "—";
        const code = t.task_code || "—";
        lines.push(``);
        lines.push(`*${t.title}*`);
        lines.push(`Ref: ${code}`);
        lines.push(`Responsavel: ${assignee} (${phone})`);
        lines.push(`Prazo: ${dueStr}`);
      }
      lines.push(``);
      lines.push(`---`);
      lines.push(`_Relatorio gerado automaticamente pela GIA._`);

      const reportMsg = lines.join("\n");
      const reportNumber = String(reportPhone).replace(/\D/g, "");
      try {
        const rr = await fetch(`${apiUrl}/message/sendText/${instanceName}`, {
          method: "POST",
          headers: { "Content-Type": "application/json", apikey: apiKey },
          body: JSON.stringify({ number: reportNumber, text: reportMsg }),
        });
        reportSent = rr.ok;
        await supabase.from("send_logs").insert({
          contact_name: "GIA Admin",
          contact_phone: reportPhone,
          template_name: "Relatorio tarefas vencidas",
          message_content: reportMsg,
          status: rr.ok ? "sent" : "error",
          error_message: rr.ok ? null : await rr.text(),
          sent_at: new Date().toISOString(),
        });
      } catch { /* best effort */ }
    }

    return new Response(
      JSON.stringify({ processed: results.length, results, report_sent: reportSent }),
      { headers: { ...corsHeaders, "Content-Type": "application/json" } }
    );
  } catch (err) {
    return new Response(
      JSON.stringify({ error: err instanceof Error ? err.message : String(err) }),
      { status: 500, headers: { ...corsHeaders, "Content-Type": "application/json" } }
    );
  }
});
