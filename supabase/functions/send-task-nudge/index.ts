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
      const nowBR = new Date(Date.now() - 3 * 60 * 60 * 1000);
      const dueBR = new Date(due.getTime() - 3 * 60 * 60 * 1000);
      const dueDay = new Date(dueBR.getUTCFullYear(), dueBR.getUTCMonth(), dueBR.getUTCDate());
      const todayDay = new Date(nowBR.getUTCFullYear(), nowBR.getUTCMonth(), nowBR.getUTCDate());
      const diffDays = Math.round((todayDay.getTime() - dueDay.getTime()) / (1000 * 60 * 60 * 24));
      if (diffDays > 0) dueLabel = `${diffDays} dia(s) atrasada`;
      else if (diffDays === 0) dueLabel = "vence hoje";
      else if (diffDays === -1) dueLabel = "vence amanha";
      else dueLabel = `vence em ${Math.abs(diffDays)} dia(s)`;
    }

    const giaInstruction = (task.gia_instruction ?? "").trim();

    // Check if there's an exact message to send (from NL approval flow with scheduling)
    const exactMsgMatch = /^ENVIAR_MENSAGEM_EXATA:(?:\[PRAZO:([^\|]*)\|NUDGE_HOURS:([^\|]*)\|INSTRUCTION:([^\]]*)\])?\s*([\s\S]+)$/i.exec(giaInstruction);
    if (exactMsgMatch) {
      const realDeadline = exactMsgMatch[1] || null;
      const realNudgeHours = Number(exactMsgMatch[2]) || 4;
      const realInstruction = exactMsgMatch[3] || "";
      const exactMessage = exactMsgMatch[4].trim().replace(/ATOM-XXXX/g, task.task_code ?? "");
      const isGroup = String(task.assignee_phone).includes("@g.us");
      let number = isGroup ? task.assignee_phone : String(task.assignee_phone).replace(/\D/g, "");
      if (!isGroup && number.length <= 11) number = "55" + number;

      const sendRes = await fetch(`${apiUrl}/message/sendText/${instanceName}`, {
        method: "POST",
        headers: { "Content-Type": "application/json", apikey: apiKey },
        body: JSON.stringify({ number, text: exactMessage }),
      });

      await supabase.from("send_logs").insert({
        task_id: task.id,
        contact_name: task.assignee_name,
        contact_phone: task.assignee_phone,
        template_name: "Mensagem agendada (GIA NL)",
        message_content: exactMessage,
        status: sendRes.ok ? "sent" : "error",
        error_message: sendRes.ok ? null : await sendRes.text(),
        sent_at: new Date().toISOString(),
      });

      // After sending, update task: set real deadline and enable nudge for follow-up
      const taskUpdate: Record<string, unknown> = {
        last_ai_nudge: new Date().toISOString(),
        ai_interventions: (task.ai_interventions ?? 0) + 1,
        gia_instruction: realInstruction,
      };
      if (realDeadline) {
        taskUpdate.due_date = realDeadline;
        taskUpdate.first_nudge_at = realDeadline;
        taskUpdate.nudge_active = true;
        taskUpdate.nudge_repeat_hours = realNudgeHours;
      } else {
        taskUpdate.nudge_active = false;
      }
      await supabase.from("tasks").update(taskUpdate).eq("id", task.id);

      return new Response(
        JSON.stringify({ sent: true, exact_message: true, task_id: task.id }),
        { headers: { ...corsHeaders, "Content-Type": "application/json" } }
      );
    }

    const isSendOnly = giaInstruction && /\b(s[oó]\s*(envi|mand)|apenas\s*(envi|mand)|sem\s*(pedir|cobrar)|n[aã]o\s*(pe[cç]a|cobr|pedir)|marque\s*como\s*conclu)/i.test(giaInstruction);

    const descriptionText = task.description ? `\nDetalhes: ${task.description}` : "";

    let fallbackMessage: string;
    if (isSendOnly) {
      fallbackMessage =
        `Olá ${task.assignee_name}! Aqui é a GIA, assistente do Sr. Marco Abdo.\n\n` +
        `${task.title}${descriptionText ? "\n" + task.description : ""}`;
    } else {
      const taskRef = task.task_code ?? "";
      fallbackMessage =
        `Olá ${task.assignee_name}! Aqui é a GIA, Executive Advisor do Sr. Marco Abdo.\n\n` +
        `Preciso de uma atualização sobre: *"${task.title}"*${descriptionText}\n` +
        `Prazo: ${dueLabel}.\n\n` +
        `Ao concluir, responda: *${taskRef} concluído*`;
    }

    let message = fallbackMessage;
    if (openaiKey) {
      try {
        let userBrief: string;
        const ownerNameNudge = settings["owner_name"] && settings["owner_name"].toLowerCase() !== "eu" ? settings["owner_name"] : "Marco Abdo";
        if (isSendOnly) {
          userBrief =
            `Gere uma mensagem para envio no WhatsApp seguindo estas instruções do meu chefe:\n\n` +
            `INSTRUÇÃO: ${giaInstruction}\n\n` +
            `Destinatário: ${task.assignee_name}\n` +
            `Título/Assunto: ${task.title}\n` +
            `Descrição/Contexto: ${task.description || "Nenhuma descrição adicional"}\n\n` +
            `REGRAS:\n` +
            `- OBRIGATÓRIO: A mensagem DEVE começar com uma apresentação da GIA. Ex: "Olá [nome]! Aqui é a GIA, assistente do Sr. ${ownerNameNudge}."\n` +
            `- Siga EXATAMENTE a instrução acima. Não peça status, não peça resposta numerada (1, 2, 3).\n` +
            `- Seja cordial e natural como uma assistente executiva.\n` +
            `- Use emojis de forma moderada.\n` +
            `- Não inclua referência de tarefa. Seja breve e humana.`;
        } else {
          userBrief =
            `Gere a mensagem de cobrança da seguinte tarefa para envio no WhatsApp.\n` +
            `Responsável: ${task.assignee_name}\n` +
            `Tarefa: ${task.title}\n` +
            `Descrição completa: ${task.description || "Nenhuma descrição adicional"}\n` +
            `Prazo: ${dueLabel}\n` +
            `Código da tarefa: ${task.task_code ?? "—"}\n` +
            (giaInstruction ? `\nInstrução adicional do gestor: ${giaInstruction}\n` : "") +
            `\nINSTRUÇÕES OBRIGATÓRIAS:\n` +
            `- OBRIGATÓRIO: A mensagem DEVE começar com uma apresentação. Ex: "Olá [nome]! Aqui é a GIA, Executive Advisor do Sr. ${ownerNameNudge}."\n` +
            `- SIGA RIGOROSAMENTE todas as instruções do system prompt (emojis, tom, formato, apresentação)\n` +
            `- Explique claramente para a pessoa O QUE é a tarefa usando o título e a descrição fornecidos.\n` +
            `- Contextualize o que precisa ser feito de forma objetiva para que a pessoa entenda exatamente do que se trata.\n` +
            `- Informe o prazo REAL da tarefa (${dueLabel}). NÃO invente prazos.\n` +
            `- Se o prazo é futuro, a data exata é: ${task.due_date ? new Date(new Date(task.due_date).getTime() - 3*60*60*1000).toISOString().slice(0,10) : "sem prazo"}\n` +
            `- Use emojis de forma natural e moderada.\n` +
            `- ANTES da instrucao de conclusao, inclua EXATAMENTE estas opcoes de status (use emojis de numero):\n` +
            `"Por favor, confirme como esta essa tarefa:\n1️⃣ Em andamento\n2️⃣ Concluida\n3️⃣ Preciso de ajuda"\n` +
            `- A mensagem DEVE terminar com EXATAMENTE: "Ao concluir, responda: ${task.task_code ?? ""} concluido"\n\n` +
            `Nao inclua nada alem da mensagem final.`;
        }
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
      const newStatus = isSendOnly
        ? "completed"
        : task.status === "completed" ? "completed" : "awaiting_response";
      const updates: Record<string, unknown> = {
        ai_interventions: (task.ai_interventions ?? 0) + 1,
        last_ai_nudge: now,
        status: newStatus,
      };
      if (isSendOnly) updates.completed_at = now;
      await supabase.from("tasks").update(updates).eq("id", taskId);
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
