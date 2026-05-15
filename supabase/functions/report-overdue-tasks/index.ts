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
    const reportPhone = settings["gia_report_phone"];

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

    const nowIso = new Date().toISOString();

    const { data: overdueTasks } = await supabase
      .from("tasks")
      .select("*")
      .neq("status", "completed")
      .not("due_date", "is", null)
      .lte("due_date", nowIso);

    if (!overdueTasks || overdueTasks.length === 0) {
      return new Response(
        JSON.stringify({ message: "No overdue tasks", sent: false }),
        { headers: { ...corsHeaders, "Content-Type": "application/json" } }
      );
    }

    const pad = (n: number) => String(n).padStart(2, "0");
    const formatDate = (iso: string) => {
      const d = new Date(iso);
      return `${pad(d.getDate())}/${pad(d.getMonth() + 1)} ${pad(d.getHours())}:${pad(d.getMinutes())}`;
    };

    const lines: string[] = [
      `*RELATORIO DE TAREFAS VENCIDAS*`,
      `Data: ${formatDate(nowIso)}`,
      `Total: ${overdueTasks.length} tarefa(s) pendente(s)`,
      ``,
      `---`,
    ];

    for (const t of overdueTasks) {
      const assignee = t.assignee_name || "Sem responsavel";
      const phone = t.assignee_phone || "—";
      const dueStr = t.due_date ? formatDate(t.due_date) : "—";
      const code = t.task_code || "—";
      const statusLabel =
        t.status === "awaiting_response" ? "Aguardando resposta" :
        t.status === "in_progress" ? "Em execucao" :
        t.status === "blocked" ? "Bloqueada" : "Pendente";

      lines.push(``);
      lines.push(`*${t.title}*`);
      lines.push(`Ref: ${code}`);
      lines.push(`Responsavel: ${assignee} (${phone})`);
      lines.push(`Prazo: ${dueStr}`);
      lines.push(`Status: ${statusLabel}`);
    }

    lines.push(``);
    lines.push(`---`);
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
      template_name: "Relatorio tarefas vencidas",
      message_content: message,
      status: sendOk ? "sent" : "error",
      error_message: sendErr,
      sent_at: nowIso,
    });

    return new Response(
      JSON.stringify({ sent: sendOk, overdue_count: overdueTasks.length, error: sendErr }),
      { headers: { ...corsHeaders, "Content-Type": "application/json" } }
    );
  } catch (err) {
    return new Response(
      JSON.stringify({ error: err instanceof Error ? err.message : String(err) }),
      { status: 500, headers: { ...corsHeaders, "Content-Type": "application/json" } }
    );
  }
});
