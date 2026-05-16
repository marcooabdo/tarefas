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
    const label = diffMs > 0 ? "faltam" : "vencida ha";
    return `${label} ${days}d ${remH}h`;
  }
  if (hours > 0) {
    const label = diffMs > 0 ? "faltam" : "vencida ha";
    return `${label} ${hours}h${minutes > 0 ? `${minutes}m` : ""}`;
  }
  const label = diffMs > 0 ? "faltam" : "vencida ha";
  return `${label} ${minutes}m`;
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
    )).toISOString(); // 00:00 BRT = 03:00 UTC

    // Completed today
    const { data: completedTasks } = await supabase
      .from("tasks")
      .select("*")
      .eq("status", "completed")
      .gte("completed_at", todayStart)
      .order("completed_at", { ascending: false });

    // Pending/in_progress tasks (not completed)
    const { data: pendingTasks } = await supabase
      .from("tasks")
      .select("*")
      .neq("status", "completed")
      .order("due_date", { ascending: true, nullsFirst: false });

    const completed = completedTasks ?? [];
    const pending = pendingTasks ?? [];

    const overdue = pending.filter((t) => t.due_date && new Date(t.due_date).getTime() < now);
    const upcoming = pending.filter((t) => t.due_date && new Date(t.due_date).getTime() >= now);
    const noDue = pending.filter((t) => !t.due_date);

    const lines: string[] = [];
    lines.push(`*RELATORIO DIARIO - GIA*`);
    lines.push(`${fmtDate(nowIso)}`);
    lines.push(``);

    // --- Completed section ---
    if (completed.length > 0) {
      lines.push(`*CONCLUIDAS HOJE (${completed.length})*`);
      lines.push(``);
      for (const t of completed) {
        const who = t.assignee_name || "Sem responsavel";
        const code = t.task_code ? ` [${t.task_code}]` : "";
        const completedAt = t.completed_at ? fmtDate(t.completed_at) : "";
        lines.push(`  ${t.title}${code}`);
        lines.push(`  Por: ${who} as ${completedAt}`);
        lines.push(``);
      }
    } else {
      lines.push(`*CONCLUIDAS HOJE: nenhuma*`);
      lines.push(``);
    }

    lines.push(`---`);
    lines.push(``);

    // --- Overdue section ---
    if (overdue.length > 0) {
      lines.push(`*VENCIDAS (${overdue.length})*`);
      lines.push(``);
      for (const t of overdue) {
        const who = t.assignee_name || "Sem responsavel";
        const code = t.task_code ? ` [${t.task_code}]` : "";
        const diff = timeDiff(t.due_date, now);
        const statusLabel = t.status === "in_progress" ? " (em execucao)" : t.status === "blocked" ? " (bloqueada)" : "";
        lines.push(`  ${t.title}${code}${statusLabel}`);
        lines.push(`  Para: ${who} | Prazo: ${fmtDate(t.due_date)} (${diff})`);
        lines.push(``);
      }
    }

    // --- Upcoming section ---
    if (upcoming.length > 0) {
      lines.push(`*PENDENTES COM PRAZO (${upcoming.length})*`);
      lines.push(``);
      for (const t of upcoming) {
        const who = t.assignee_name || "Sem responsavel";
        const code = t.task_code ? ` [${t.task_code}]` : "";
        const diff = timeDiff(t.due_date, now);
        const statusLabel = t.status === "in_progress" ? " (em execucao)" : "";
        lines.push(`  ${t.title}${code}${statusLabel}`);
        lines.push(`  Para: ${who} | Prazo: ${fmtDate(t.due_date)} (${diff})`);
        lines.push(``);
      }
    }

    // --- No due date section ---
    if (noDue.length > 0) {
      lines.push(`*SEM PRAZO (${noDue.length})*`);
      lines.push(``);
      for (const t of noDue) {
        const who = t.assignee_name || "Sem responsavel";
        const code = t.task_code ? ` [${t.task_code}]` : "";
        lines.push(`  ${t.title}${code}`);
        lines.push(`  Para: ${who}`);
        lines.push(``);
      }
    }

    if (pending.length === 0) {
      lines.push(`*PENDENTES: nenhuma*`);
      lines.push(``);
    }

    lines.push(`---`);
    lines.push(`Total: ${completed.length} concluida(s), ${overdue.length} vencida(s), ${upcoming.length + noDue.length} pendente(s)`);
    lines.push(`_Relatorio gerado automaticamente pela GIA._`);

    const message = lines.join("\n");
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
