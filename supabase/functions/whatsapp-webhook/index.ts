import "jsr:@supabase/functions-js/edge-runtime.d.ts";
import { createClient } from "npm:@supabase/supabase-js@2";

const corsHeaders = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Methods": "GET, POST, OPTIONS",
  "Access-Control-Allow-Headers": "Content-Type, Authorization, X-Client-Info, Apikey",
};

type Intent = "completed" | "in_progress" | "blocked" | "unknown";

function classify(text: string): Intent {
  const t = text.trim().toLowerCase();
  if (/^1\b|\b1\s*[\-\.\)]/.test(t)) return "completed";
  if (/^2\b|\b2\s*[\-\.\)]/.test(t)) return "in_progress";
  if (/^3\b|\b3\s*[\-\.\)]/.test(t)) return "blocked";
  if (/\b(sim|feito|pronto|conclu[ií]d|finaliz|entregu|done|completed|ok\s*feito)\b/.test(t)) return "completed";
  if (/\b(fazendo|em andamento|trabalhando|tocando|come[cç]ando|iniciei|estou nisso)\b/.test(t)) return "in_progress";
  if (/\b(bloqueado|travad|impedid|problema|atras|n[aã]o consigo|bloqueio)\b/.test(t)) return "blocked";
  return "unknown";
}

function extractTaskCode(text: string): string | null {
  const m = /\bATOM-(\d{3,6})\b/i.exec(text);
  if (m) return `ATOM-${m[1]}`.toUpperCase();
  const legacy = /#([0-9a-f]{8})\b/i.exec(text);
  return legacy ? legacy[1].toLowerCase() : null;
}

function nextDueDate(current: string | null, recurrence: string, interval: number): string | null {
  const base = current ? new Date(current) : new Date();
  const n = Math.max(1, interval || 1);
  const d = new Date(base);
  switch (recurrence) {
    case "daily":
      d.setUTCDate(d.getUTCDate() + n);
      return d.toISOString();
    case "weekdays": {
      d.setUTCDate(d.getUTCDate() + 1);
      while (d.getUTCDay() === 0 || d.getUTCDay() === 6) {
        d.setUTCDate(d.getUTCDate() + 1);
      }
      return d.toISOString();
    }
    case "weekly":
      d.setUTCDate(d.getUTCDate() + 7 * n);
      return d.toISOString();
    case "monthly":
      d.setUTCMonth(d.getUTCMonth() + n);
      return d.toISOString();
    default:
      return null;
  }
}

function normalizePhone(p: string): string {
  return String(p).replace(/\D/g, "");
}

function brazilVariants(p: string): string[] {
  const digits = normalizePhone(p);
  const variants = new Set<string>([digits]);
  if (digits.startsWith("55") && digits.length === 13) {
    const ddd = digits.slice(2, 4);
    const rest = digits.slice(4);
    if (rest.startsWith("9") && rest.length === 9) {
      variants.add("55" + ddd + rest.slice(1));
    }
  }
  if (digits.startsWith("55") && digits.length === 12) {
    const ddd = digits.slice(2, 4);
    const rest = digits.slice(4);
    if (rest.length === 8) {
      variants.add("55" + ddd + "9" + rest);
    }
  }
  return [...variants];
}

function phonesMatch(a: string, b: string): boolean {
  const av = brazilVariants(a);
  const bv = brazilVariants(b);
  for (const x of av) for (const y of bv) {
    if (x === y) return true;
    const xs = x.slice(-10), ys = y.slice(-10);
    if (xs.length === 10 && ys.length === 10 && xs === ys) return true;
    const xs8 = x.slice(-8), ys8 = y.slice(-8);
    if (xs8.length === 8 && ys8.length === 8 && xs8 === ys8) return true;
  }
  return false;
}

function replyFor(intent: Intent, name: string, title: string): string {
  const firstName = (name ?? "").split(" ")[0] || "tudo bem";
  switch (intent) {
    case "completed":
      return `Perfeito, ${firstName}! Registrei "${title}" como concluída. Obrigado pela atualização.`;
    case "in_progress":
      return `Valeu, ${firstName}! Marquei "${title}" como em execução. Me avisa quando concluir ou se travar em algo.`;
    case "blocked":
      return `Entendido, ${firstName}. Anotei um bloqueio em "${title}". Pode me contar rapidamente o que está impedindo para eu escalar se necessário?`;
    default:
      return `Recebi sua mensagem sobre "${title}", ${firstName}. Pode confirmar se está: 1) concluída, 2) em andamento, ou 3) bloqueada?`;
  }
}

Deno.serve(async (req: Request) => {
  if (req.method === "OPTIONS") {
    return new Response(null, { status: 200, headers: corsHeaders });
  }

  if (req.method === "GET") {
    return new Response(JSON.stringify({ ok: true, msg: "whatsapp-webhook is up" }), {
      headers: { ...corsHeaders, "Content-Type": "application/json" },
    });
  }

  const supabase = createClient(
    Deno.env.get("SUPABASE_URL")!,
    Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!
  );

  let payload: any = {};
  try {
    const raw = await req.text();
    payload = raw ? JSON.parse(raw) : {};
  } catch {
    payload = {};
  }

  const eventName: string = String(payload?.event ?? payload?.type ?? "");
  const data = payload?.data ?? payload?.body ?? payload;
  const remoteJid: string =
    data?.key?.remoteJid ??
    data?.message?.key?.remoteJid ??
    data?.from ??
    payload?.remoteJid ??
    "";
  const fromMe: boolean = Boolean(data?.key?.fromMe ?? data?.message?.key?.fromMe ?? payload?.fromMe);
  const msg = data?.message ?? data?.messages?.[0]?.message ?? data ?? {};
  const buttonId: string =
    msg?.buttonsResponseMessage?.selectedButtonId ??
    msg?.templateButtonReplyMessage?.selectedId ??
    msg?.interactiveResponseMessage?.body?.text ??
    msg?.listResponseMessage?.singleSelectReply?.selectedRowId ??
    "";
  const text: string =
    msg?.conversation ??
    msg?.extendedTextMessage?.text ??
    msg?.buttonsResponseMessage?.selectedDisplayText ??
    msg?.templateButtonReplyMessage?.selectedDisplayText ??
    msg?.imageMessage?.caption ??
    msg?.videoMessage?.caption ??
    msg?.text ??
    "";

  async function logEvent(outcome: string, notes = "") {
    try {
      await supabase.from("webhook_events").insert({
        event: eventName.slice(0, 80),
        from_me: fromMe,
        remote_jid: String(remoteJid).slice(0, 200),
        text: String(text || buttonId).slice(0, 500),
        payload,
        outcome: outcome.slice(0, 60),
        notes: notes.slice(0, 500),
      });
    } catch { /* swallow */ }
  }

  try {
    if (fromMe || !remoteJid || (!text && !buttonId)) {
      await logEvent("ignored", `fromMe=${fromMe} jid=${!!remoteJid} text=${!!text} btn=${!!buttonId}`);
      return new Response(JSON.stringify({ ignored: true }), {
        headers: { ...corsHeaders, "Content-Type": "application/json" },
      });
    }

    const buttonMatch = /^task:([0-9a-f-]{36}):(completed|in_progress|blocked)$/i.exec(buttonId);
    if (buttonMatch) {
      const [, taskId, action] = buttonMatch;
      const updates: Record<string, unknown> = {};
      if (action === "completed") {
        updates.status = "completed";
        updates.completed_at = new Date().toISOString();
      } else if (action === "in_progress") {
        updates.status = "in_progress";
      } else {
        updates.status = "pending";
      }
      const { data: updated } = await supabase
        .from("tasks")
        .update(updates)
        .eq("id", taskId)
        .select()
        .maybeSingle();

      const { data: settingsRowsBtn } = await supabase.from("app_settings").select("key, value");
      const settingsBtn: Record<string, string> = {};
      for (const row of settingsRowsBtn ?? []) settingsBtn[row.key] = row.value;
      const autoReplyBtn = settingsBtn["ai_auto_reply"] !== "false";
      const apiUrlBtn = settingsBtn["evolution_api_url"]?.replace(/\/$/, "");
      const apiKeyBtn = settingsBtn["evolution_api_key"];
      const instanceBtn = settingsBtn["evolution_instance_name"];

      await supabase.from("send_logs").insert({
        contact_name: updated?.assignee_name ?? "",
        contact_phone: updated?.assignee_phone ?? remoteJid,
        template_name: "Botão clicado",
        message_content: `${text || action} (${buttonId})`,
        status: "sent",
        sent_at: new Date().toISOString(),
      });

      if (autoReplyBtn && apiUrlBtn && apiKeyBtn && instanceBtn) {
        const firstName = String(updated?.assignee_name ?? "").split(" ")[0] || "time";
        const title = String(updated?.title ?? "tarefa");
        const replyText =
          action === "completed"
            ? `Perfeito, ${firstName}! "${title}" marcada como concluída.`
            : action === "in_progress"
            ? `Ok, ${firstName}! "${title}" agora está em execução.`
            : `Entendido, ${firstName}. "${title}" marcada como bloqueada — me conte rapidamente o que travou.`;
        const isGroupBtn = remoteJid.endsWith("@g.us");
        const numberBtn = isGroupBtn ? remoteJid : normalizePhone(remoteJid.split("@")[0]);
        await fetch(`${apiUrlBtn}/message/sendText/${instanceBtn}`, {
          method: "POST",
          headers: { "Content-Type": "application/json", apikey: apiKeyBtn },
          body: JSON.stringify({ number: numberBtn, text: replyText }),
        });
      }

      return new Response(
        JSON.stringify({ matched: true, via: "button", task_id: taskId, updated: updates }),
        { headers: { ...corsHeaders, "Content-Type": "application/json" } }
      );
    }

    const { data: settingsRows } = await supabase.from("app_settings").select("key, value");
    const settings: Record<string, string> = {};
    for (const row of settingsRows ?? []) settings[row.key] = row.value;

    const autoRead = settings["ai_auto_read_groups"] !== "false";
    const autoReply = settings["ai_auto_reply"] !== "false";
    const isGroup = remoteJid.endsWith("@g.us");

    if (!autoRead && isGroup) {
      await logEvent("ignored-group", "ai_auto_read_groups disabled");
      return new Response(JSON.stringify({ ignored: "group auto-read disabled" }), {
        headers: { ...corsHeaders, "Content-Type": "application/json" },
      });
    }

    let match: Record<string, unknown> | null = null;

    const quotedText: string =
      msg?.extendedTextMessage?.contextInfo?.quotedMessage?.conversation ??
      msg?.extendedTextMessage?.contextInfo?.quotedMessage?.extendedTextMessage?.text ??
      "";
    const code = extractTaskCode(text) ?? extractTaskCode(quotedText);
    if (code) {
      if (code.startsWith("ATOM-")) {
        const { data: byCode } = await supabase
          .from("tasks")
          .select("*")
          .eq("task_code", code)
          .limit(1);
        if (byCode && byCode[0]) match = byCode[0];
      } else {
        const { data: byCode } = await supabase
          .from("tasks")
          .select("*")
          .ilike("id", `${code}%`)
          .limit(1);
        if (byCode && byCode[0]) match = byCode[0];
      }
    }

    if (!match) {
      if (isGroup) {
        const { data: tasks } = await supabase
          .from("tasks")
          .select("*")
          .neq("status", "completed")
          .eq("assignee_phone", remoteJid)
          .order("last_ai_nudge", { ascending: false, nullsFirst: false })
          .limit(1);
        match = tasks?.[0] ?? null;
      } else {
        const incoming = remoteJid.split("@")[0];
        const { data: tasks } = await supabase
          .from("tasks")
          .select("*")
          .neq("status", "completed")
          .order("last_ai_nudge", { ascending: false, nullsFirst: false });
        match = (tasks ?? []).find(
          (t) => phonesMatch(String(t.assignee_phone), incoming)
        ) ?? null;
      }
    }

    if (!match) {
      await logEvent("no-match", `remoteJid=${remoteJid} text="${text}"`);
      return new Response(JSON.stringify({ matched: false, remoteJid }), {
        headers: { ...corsHeaders, "Content-Type": "application/json" },
      });
    }

    const intent = classify(text);
    const updates: Record<string, unknown> = {};
    const recurrence = String(match.recurrence ?? "none");
    const recurrenceInterval = Number(match.recurrence_interval ?? 1);
    let recurred = false;

    if (intent === "completed") {
      if (recurrence && recurrence !== "none") {
        updates.status = "pending";
        updates.completed_at = null;
        updates.ai_interventions = 0;
        updates.last_ai_nudge = null;
        const next = nextDueDate(match.due_date as string | null, recurrence, recurrenceInterval);
        if (next) updates.due_date = next;
        recurred = true;
      } else {
        updates.status = "completed";
        updates.completed_at = new Date().toISOString();
      }
    } else if (intent === "in_progress") {
      updates.status = "in_progress";
    } else if (intent === "blocked") {
      updates.status = "pending";
    }

    if (Object.keys(updates).length > 0) {
      await supabase.from("tasks").update(updates).eq("id", match.id as string);
    }

    await supabase.from("send_logs").insert({
      contact_name: match.assignee_name,
      contact_phone: match.assignee_phone,
      template_name: "Resposta recebida",
      message_content: text,
      status: "sent",
      sent_at: new Date().toISOString(),
    });

    let replied = false;
    if (autoReply && intent !== "unknown") {
      const apiUrl = settings["evolution_api_url"]?.replace(/\/$/, "");
      const apiKey = settings["evolution_api_key"];
      const instanceName = settings["evolution_instance_name"];
      const openaiKey = settings["openai_api_key"] ?? "";
      const openaiModel = settings["openai_model"] || "gpt-4o-mini";
      const systemPrompt = settings["ai_system_prompt"] ?? "";
      if (apiUrl && apiKey && instanceName) {
        let replyText = replyFor(intent, String(match.assignee_name ?? ""), String(match.title ?? ""));
        if (recurred) {
          const firstName = String(match.assignee_name ?? "").split(" ")[0] || "tudo bem";
          replyText = `Perfeito, ${firstName}! Registrei "${match.title}" como concluída. Como é uma tarefa recorrente, já reagendei para o próximo ciclo.`;
        }
        if (openaiKey) {
          try {
            const intentLabel =
              intent === "completed"
                ? recurred
                  ? "concluída (com recorrência reagendada para o próximo ciclo)"
                  : "concluída"
                : intent === "in_progress"
                ? "em execução"
                : "bloqueada";
            const userBrief =
              `O responsável "${match.assignee_name}" acabou de responder no WhatsApp confirmando o status da tarefa "${match.title}" como ${intentLabel}. ` +
              (intent === "blocked"
                ? `Confirme o registro do bloqueio e peça brevemente o que está impedindo o avanço para que possa escalar se necessário. `
                : `Confirme o registro de forma curta e cordial. `) +
              `Não inclua a referência da tarefa nesta mensagem. Não inclua as opções 1/2/3. Máximo 3 linhas.`;
            const aiRes = await fetch("https://api.openai.com/v1/chat/completions", {
              method: "POST",
              headers: { "Content-Type": "application/json", Authorization: `Bearer ${openaiKey}` },
              body: JSON.stringify({
                model: openaiModel,
                temperature: 0.5,
                messages: [
                  { role: "system", content: systemPrompt },
                  { role: "user", content: userBrief },
                ],
              }),
            });
            if (aiRes.ok) {
              const j = await aiRes.json();
              const content = String(j?.choices?.[0]?.message?.content ?? "").trim();
              if (content) replyText = content;
            }
          } catch { /* fallback */ }
        }
        const number = isGroup ? remoteJid : normalizePhone(remoteJid.split("@")[0]);
        try {
          const r = await fetch(`${apiUrl}/message/sendText/${instanceName}`, {
            method: "POST",
            headers: { "Content-Type": "application/json", apikey: apiKey },
            body: JSON.stringify({ number, text: replyText }),
          });
          replied = r.ok;
          await supabase.from("send_logs").insert({
            contact_name: match.assignee_name,
            contact_phone: match.assignee_phone,
            template_name: "Resposta automática IA",
            message_content: replyText,
            status: r.ok ? "sent" : "error",
            error_message: r.ok ? null : await r.text(),
            sent_at: new Date().toISOString(),
          });
        } catch (e) {
          await supabase.from("send_logs").insert({
            contact_name: match.assignee_name,
            contact_phone: match.assignee_phone,
            template_name: "Resposta automática IA",
            message_content: replyText,
            status: "error",
            error_message: e instanceof Error ? e.message : String(e),
            sent_at: new Date().toISOString(),
          });
        }
      }
    }

    await logEvent(intent === "unknown" ? "matched-unknown-intent" : `matched-${intent}`, String(match.task_code ?? match.id));
    return new Response(
      JSON.stringify({ matched: true, task_id: match.id, intent, updated: updates, replied }),
      { headers: { ...corsHeaders, "Content-Type": "application/json" } }
    );
  } catch (err) {
    await logEvent("error", err instanceof Error ? err.message : String(err));
    return new Response(
      JSON.stringify({ error: err instanceof Error ? err.message : String(err) }),
      { status: 500, headers: { ...corsHeaders, "Content-Type": "application/json" } }
    );
  }
});
