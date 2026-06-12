import "jsr:@supabase/functions-js/edge-runtime.d.ts";
import { createClient } from "npm:@supabase/supabase-js@2";

const corsHeaders = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Methods": "GET, POST, OPTIONS",
  "Access-Control-Allow-Headers": "Content-Type, Authorization, X-Client-Info, Apikey",
};

function fmtDate(iso: string): string {
  const d = new Date(iso);
  const br = new Date(d.getTime() - 3 * 60 * 60 * 1000);
  const dd = String(br.getUTCDate()).padStart(2, "0");
  const mm = String(br.getUTCMonth() + 1).padStart(2, "0");
  const hh = String(br.getUTCHours()).padStart(2, "0");
  const mi = String(br.getUTCMinutes()).padStart(2, "0");
  return `${dd}/${mm} ${hh}:${mi}`;
}

function timeDiff(dueIso: string, nowMs: number): string {
  const dueMs = new Date(dueIso).getTime();
  const diffMs = dueMs - nowMs;
  const absDiff = Math.abs(diffMs);
  const hours = Math.floor(absDiff / (1000 * 60 * 60));
  const minutes = Math.floor((absDiff % (1000 * 60 * 60)) / (1000 * 60));

  if (hours >= 24) {
    const days = Math.floor(hours / 24);
    const remH = hours % 24;
    return diffMs > 0 ? `faltam ${days}d ${remH}h` : `vencida ha ${days}d ${remH}h`;
  }
  if (hours > 0) {
    return diffMs > 0 ? `faltam ${hours}h${minutes > 0 ? `${minutes}m` : ""}` : `vencida ha ${hours}h${minutes > 0 ? `${minutes}m` : ""}`;
  }
  return diffMs > 0 ? `faltam ${minutes}m` : `vencida ha ${minutes}m`;
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

    const { data: settingsRows } = await supabase.from("app_settings").select("key, value");
    const settings: Record<string, string> = {};
    for (const row of settingsRows ?? []) settings[row.key] = row.value;

    const apiUrl = settings["evolution_api_url"]?.replace(/\/$/, "");
    const apiKey = settings["evolution_api_key"];
    const instanceName = settings["evolution_instance_name"];
    const reportPhone = settings["gia_report_phone"] || settings["owner_phone"];
    const openaiKey = settings["openai_api_key"] ?? "";
    const openaiModel = settings["openai_model"] || "gpt-4o-mini";

    if (!apiUrl || !apiKey || !instanceName) {
      return new Response(
        JSON.stringify({ error: "Evolution API not configured" }),
        { status: 400, headers: { ...corsHeaders, "Content-Type": "application/json" } }
      );
    }

    if (!reportPhone) {
      return new Response(
        JSON.stringify({ error: "gia_report_phone not configured in app_settings" }),
        { status: 400, headers: { ...corsHeaders, "Content-Type": "application/json" } }
      );
    }

    const now = Date.now();
    const nowIso = new Date(now).toISOString();

    // Today's range in BRT (UTC-3)
    const brNow = new Date(now - 3 * 60 * 60 * 1000);
    const todayStart = new Date(Date.UTC(
      brNow.getUTCFullYear(), brNow.getUTCMonth(), brNow.getUTCDate(), 3, 0, 0
    )).toISOString();

    // Completed today
    const { data: completedTasks } = await supabase
      .from("tasks")
      .select("*")
      .eq("status", "completed")
      .gte("completed_at", todayStart)
      .order("completed_at", { ascending: false });

    // Pending tasks (not completed)
    const { data: pendingTasks } = await supabase
      .from("tasks")
      .select("*")
      .neq("status", "completed")
      .order("due_date", { ascending: true, nullsFirst: false });

    const completed = completedTasks ?? [];
    const pending = pendingTasks ?? [];

    const isRecurring = (t: any) => t.recurrence && t.recurrence !== "none";
    const overdue = pending.filter((t) => t.due_date && new Date(t.due_date).getTime() < now && !isRecurring(t));
    const recurring = pending.filter((t) => isRecurring(t));
    const upcoming = pending.filter((t) => t.due_date && new Date(t.due_date).getTime() >= now && !isRecurring(t));
    const noDue = pending.filter((t) => !t.due_date && !isRecurring(t));

    // Build structured data for ChatGPT
    const completedSummary = completed.map((t) => ({
      titulo: t.title,
      descricao: t.description || "",
      responsavel: t.assignee_name || "Sem responsavel",
      concluida_em: t.completed_at ? fmtDate(t.completed_at) : "hoje",
      codigo: t.task_code || null,
    }));

    const overdueSummary = overdue.map((t) => ({
      titulo: t.title,
      descricao: t.description || "",
      responsavel: t.assignee_name || "Sem responsavel",
      prazo: t.due_date ? fmtDate(t.due_date) : null,
      atraso: t.due_date ? timeDiff(t.due_date, now) : null,
      status: t.status === "in_progress" ? "em execucao" : t.status === "blocked" ? "bloqueada" : "pendente",
      codigo: t.task_code || null,
      prioridade: t.priority || "medium",
    }));

    const upcomingSummary = upcoming.map((t) => ({
      titulo: t.title,
      descricao: t.description || "",
      responsavel: t.assignee_name || "Sem responsavel",
      prazo: t.due_date ? fmtDate(t.due_date) : null,
      tempo_restante: t.due_date ? timeDiff(t.due_date, now) : null,
      status: t.status === "in_progress" ? "em execucao" : "pendente",
      codigo: t.task_code || null,
      prioridade: t.priority || "medium",
    }));

    const noDueSummary = noDue.map((t) => ({
      titulo: t.title,
      descricao: t.description || "",
      responsavel: t.assignee_name || "Sem responsavel",
      status: t.status === "in_progress" ? "em execucao" : "pendente",
      codigo: t.task_code || null,
    }));

    const recurringSummary = recurring.map((t) => {
      const recLabel = t.recurrence === "daily" ? "diaria" : t.recurrence === "weekdays" ? "dias uteis" : t.recurrence === "weekly" ? "semanal" : t.recurrence === "monthly" ? "mensal" : t.recurrence;
      return {
        titulo: t.title,
        descricao: t.description || "",
        responsavel: t.assignee_name || "Sem responsavel",
        frequencia: recLabel,
        codigo: t.task_code || null,
        ativa: t.nudge_active ?? false,
      };
    });

    const dataPayload = JSON.stringify({
      data_relatorio: fmtDate(nowIso),
      concluidas_hoje: completedSummary,
      vencidas: overdueSummary,
      recorrentes: recurringSummary,
      pendentes_com_prazo: upcomingSummary,
      sem_prazo: noDueSummary,
      totais: {
        concluidas: completed.length,
        vencidas: overdue.length,
        recorrentes: recurring.length,
        pendentes: upcoming.length,
        sem_prazo: noDue.length,
      },
    });

    let message: string;

    if (openaiKey) {
      const gptRes = await fetch("https://api.openai.com/v1/chat/completions", {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          Authorization: `Bearer ${openaiKey}`,
        },
        body: JSON.stringify({
          model: openaiModel,
          temperature: 0.7,
          max_tokens: 2000,
          messages: [
            {
              role: "system",
              content: `Voce e a GIA, assistente de gestao de tarefas via WhatsApp. Escreva um relatorio diario COMPLETO e DETALHADO para o gestor.

REGRAS:
- Use emojis adequados para cada secao e status
- Use formatacao WhatsApp: *negrito*, _italico_
- Seja detalhista: explique o que e cada tarefa, quem e responsavel, prazo exato, quanto tempo venceu ou falta
- Para tarefas vencidas, destaque a gravidade com emojis de alerta
- Para concluidas, celebre com emojis positivos
- Inclua um resumo executivo no inicio
- Inclua uma frase motivacional ou insight no final
- Organize por secoes claras com separadores visuais
- Formato: texto corrido formatado para WhatsApp (nao use markdown de tabela)
- Nao use crase tripla ou blocos de codigo
- Escreva em portugues brasileiro informal-profissional
- Se nao houver tarefas em alguma categoria, mencione brevemente
- Tarefas RECORRENTES (diarias, semanais, etc) devem aparecer em secao propria "Recorrentes", NAO na secao de vencidas. Elas nao estao atrasadas - sao envios automaticos programados.
- Maximo 2000 caracteres`,
            },
            {
              role: "user",
              content: `Gere o relatorio diario com base nestes dados:\n\n${dataPayload}`,
            },
          ],
        }),
      });

      if (gptRes.ok) {
        const gptData = await gptRes.json();
        message = gptData.choices?.[0]?.message?.content?.trim() ?? "";
      } else {
        message = "";
      }
    } else {
      message = "";
    }

    // Fallback if no OpenAI key or GPT failed
    if (!message) {
      const lines: string[] = [];
      lines.push(`📊 *RELATÓRIO DIÁRIO - GIA*`);
      lines.push(`📅 ${fmtDate(nowIso)}`);
      lines.push(``);

      if (completed.length > 0) {
        lines.push(`✅ *CONCLUÍDAS HOJE (${completed.length})*`);
        lines.push(``);
        for (const t of completed) {
          const who = t.assignee_name || "Sem responsável";
          const code = t.task_code ? ` [${t.task_code}]` : "";
          const at = t.completed_at ? fmtDate(t.completed_at) : "";
          lines.push(`  ✔️ *${t.title}*${code}`);
          if (t.description) lines.push(`     ${t.description.slice(0, 80)}`);
          lines.push(`     👤 ${who} às ${at}`);
          lines.push(``);
        }
      } else {
        lines.push(`✅ *CONCLUÍDAS HOJE:* nenhuma`);
        lines.push(``);
      }

      lines.push(`━━━━━━━━━━━━━━━━━━`);
      lines.push(``);

      if (overdue.length > 0) {
        lines.push(`🚨 *VENCIDAS (${overdue.length})*`);
        lines.push(``);
        for (const t of overdue) {
          const who = t.assignee_name || "Sem responsável";
          const code = t.task_code ? ` [${t.task_code}]` : "";
          const diff = timeDiff(t.due_date, now);
          lines.push(`  ⚠️ *${t.title}*${code}`);
          if (t.description) lines.push(`     ${t.description.slice(0, 80)}`);
          lines.push(`     👤 ${who} | ⏰ ${fmtDate(t.due_date)} (${diff})`);
          lines.push(``);
        }
      }

      if (upcoming.length > 0) {
        lines.push(`⏳ *PENDENTES COM PRAZO (${upcoming.length})*`);
        lines.push(``);
        for (const t of upcoming) {
          const who = t.assignee_name || "Sem responsável";
          const code = t.task_code ? ` [${t.task_code}]` : "";
          const diff = timeDiff(t.due_date, now);
          lines.push(`  📌 *${t.title}*${code}`);
          if (t.description) lines.push(`     ${t.description.slice(0, 80)}`);
          lines.push(`     👤 ${who} | ⏰ ${fmtDate(t.due_date)} (${diff})`);
          lines.push(``);
        }
      }

      if (recurring.length > 0) {
        lines.push(`🔄 *RECORRENTES (${recurring.length})*`);
        lines.push(``);
        for (const t of recurring) {
          const who = t.assignee_name || "Sem responsável";
          const code = t.task_code ? ` [${t.task_code}]` : "";
          const freq = t.recurrence === "daily" ? "Diária" : t.recurrence === "weekdays" ? "Dias úteis" : t.recurrence === "weekly" ? "Semanal" : t.recurrence === "monthly" ? "Mensal" : t.recurrence;
          lines.push(`  🔁 *${t.title}*${code}`);
          lines.push(`     👤 ${who} | ${freq} | ${t.nudge_active ? "Ativa" : "Pausada"}`);
          lines.push(``);
        }
        lines.push(`━━━━━━━━━━━━━━━━━━`);
        lines.push(``);
      }

      if (noDue.length > 0) {
        lines.push(`📋 *SEM PRAZO (${noDue.length})*`);
        lines.push(``);
        for (const t of noDue) {
          const who = t.assignee_name || "Sem responsável";
          const code = t.task_code ? ` [${t.task_code}]` : "";
          lines.push(`  📌 *${t.title}*${code}`);
          lines.push(`     👤 ${who}`);
          lines.push(``);
        }
      }

      lines.push(`━━━━━━━━━━━━━━━━━━`);
      lines.push(`📈 *Resumo:* ${completed.length} concluída(s), ${overdue.length} vencida(s), ${recurring.length} recorrente(s), ${upcoming.length + noDue.length} pendente(s)`);
      lines.push(``);
      lines.push(`_Relatório gerado automaticamente pela GIA_ 🤖`);

      message = lines.join("\n");
    }

    const number = String(reportPhone).replace(/\D/g, "");

    const sendRes = await fetch(`${apiUrl}/message/sendText/${instanceName}`, {
      method: "POST",
      headers: { "Content-Type": "application/json", apikey: apiKey },
      body: JSON.stringify({ number, text: message }),
    });

    const sendOk = sendRes.ok;
    const sendErr = sendOk ? null : await sendRes.text();

    await supabase.from("send_logs").insert({
      contact_name: "GIA Admin",
      contact_phone: reportPhone,
      template_name: "Relatorio diario",
      message_content: message,
      status: sendOk ? "sent" : "error",
      error_message: sendErr,
      sent_at: nowIso,
    });

    return new Response(
      JSON.stringify({
        sent: sendOk,
        completed_count: completed.length,
        overdue_count: overdue.length,
        pending_count: upcoming.length + noDue.length,
        error: sendErr,
      }),
      { headers: { ...corsHeaders, "Content-Type": "application/json" } }
    );
  } catch (err) {
    return new Response(
      JSON.stringify({ error: err instanceof Error ? err.message : String(err) }),
      { status: 500, headers: { ...corsHeaders, "Content-Type": "application/json" } }
    );
  }
});
