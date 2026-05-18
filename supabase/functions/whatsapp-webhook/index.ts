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
  // Match: ATOM-XXXX + status keyword
  if (/atom-\d{3,6}\s+.*/i.test(t)) {
    if (/\b(conclu[ií]d[oa]?|finalizado|feito|pronto|done|terminado)\b/.test(t)) return "completed";
    if (/\b(andamento|fazendo|executando|trabalhando|em\s+execu[cç][aã]o)\b/.test(t)) return "in_progress";
    if (/\b(bloquead[oa]?|travad[oa]?|impedid[oa]?|problema)\b/.test(t)) return "blocked";
  }
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

function replyFor(intent: Intent, name: string, title: string, taskCode?: string): string {
  const firstName = (name ?? "").split(" ")[0] || "tudo bem";
  const code = taskCode ?? "";
  switch (intent) {
    case "completed":
      return `Perfeito, ${firstName}! Registrei "${title}" como concluída. Obrigado pela atualização.`;
    case "in_progress":
      return `Valeu, ${firstName}! Marquei "${title}" como em execução. Me avisa quando concluir.`;
    case "blocked":
      return `Entendido, ${firstName}. Anotei um bloqueio em "${title}". Pode me contar rapidamente o que está impedindo para eu escalar se necessário?`;
    default:
      return `Recebi sua mensagem, ${firstName}. Ao concluir, responda: *${code} concluído*`;
  }
}

interface Candidate {
  remote_jid: string;
  name: string;
  phone: string;
  is_group: boolean;
}

async function searchWhatsAppChats(settings: Record<string, string>, query: string): Promise<Candidate[]> {
  const apiUrl = settings["evolution_api_url"]?.replace(/\/$/, "");
  const apiKey = settings["evolution_api_key"];
  const instance = settings["evolution_instance_name"];
  if (!apiUrl || !apiKey || !instance) return [];

  const headers = { apikey: apiKey, "Content-Type": "application/json" };
  const queryLower = query.toLowerCase();

  let chats: Array<{ remoteJid?: string; id?: string; pushName?: string; name?: string; subject?: string }> = [];
  const chatEndpoints = [
    `${apiUrl}/chat/findChats/${instance}`,
    `${apiUrl}/chat/fetchChats/${instance}`,
  ];
  for (const ep of chatEndpoints) {
    try {
      const r = await fetch(ep, { method: "POST", headers, body: JSON.stringify({}) });
      if (r.ok) {
        const j = await r.json();
        chats = Array.isArray(j) ? j : (j.chats ?? j.data ?? []);
        if (chats.length) break;
      }
    } catch { /* try next */ }
  }

  let contacts: Array<{ remoteJid?: string; id?: string; pushName?: string; name?: string; notify?: string }> = [];
  const contactEndpoints = [
    `${apiUrl}/chat/findContacts/${instance}`,
    `${apiUrl}/chat/fetchContacts/${instance}`,
  ];
  for (const ep of contactEndpoints) {
    try {
      const r = await fetch(ep, { method: "POST", headers, body: JSON.stringify({}) });
      if (r.ok) {
        const j = await r.json();
        contacts = Array.isArray(j) ? j : (j.contacts ?? j.data ?? []);
        if (contacts.length) break;
      }
    } catch { /* try next */ }
  }

  const candidates: Candidate[] = [];
  const seen = new Set<string>();

  for (const c of chats) {
    const jid = c.remoteJid ?? c.id ?? "";
    if (!jid || seen.has(jid) || jid.endsWith("@broadcast")) continue;
    const isGroup = jid.endsWith("@g.us");
    const name = c.subject ?? c.name ?? c.pushName ?? "";
    if (!name) continue;
    if (name.toLowerCase().includes(queryLower)) {
      seen.add(jid);
      const phone = isGroup ? "" : jid.split("@")[0].replace(/\D/g, "");
      candidates.push({ remote_jid: jid, name, phone: isGroup ? "" : `+${phone}`, is_group: isGroup });
    }
  }

  for (const c of contacts) {
    const jid = c.remoteJid ?? c.id ?? "";
    if (!jid || seen.has(jid) || jid.endsWith("@g.us") || jid.endsWith("@broadcast")) continue;
    const name = c.pushName ?? c.name ?? c.notify ?? "";
    if (!name) continue;
    if (name.toLowerCase().includes(queryLower)) {
      seen.add(jid);
      const phone = jid.split("@")[0].replace(/\D/g, "");
      candidates.push({ remote_jid: jid, name, phone: `+${phone}`, is_group: false });
    }
  }

  return candidates.slice(0, 10);
}

async function askConfirmation(
  supabase: ReturnType<typeof createClient>,
  settings: Record<string, string>,
  ownerJid: string,
  searchTerm: string,
  candidates: Candidate[],
  taskDraft: Record<string, unknown>,
): Promise<boolean> {
  const apiUrl = settings["evolution_api_url"]?.replace(/\/$/, "");
  const apiKey = settings["evolution_api_key"];
  const instance = settings["evolution_instance_name"];
  if (!apiUrl || !apiKey || !instance || candidates.length === 0) return false;

  await supabase.from("pending_task_confirmations").insert({
    owner_jid: ownerJid,
    task_draft: taskDraft,
    candidates,
    status: "pending",
  });

  const lines = candidates.map((c, i) =>
    `${i + 1} - ${c.name}${c.is_group ? " (grupo)" : ""}${c.phone ? ` ${c.phone}` : ""}`
  );
  const msg =
    `Encontrei estes contatos/grupos para "${searchTerm}":\n\n` +
    lines.join("\n") +
    `\n\n0 - Nenhum desses (criar tarefa para mim mesmo)\n\n` +
    `Responda com o número correspondente.`;

  const number = ownerJid.endsWith("@g.us") ? ownerJid : normalizePhone(ownerJid.split("@")[0]);
  await fetch(`${apiUrl}/message/sendText/${instance}`, {
    method: "POST",
    headers: { "Content-Type": "application/json", apikey: apiKey },
    body: JSON.stringify({ number, text: msg }),
  });

  return true;
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
    // Handle pending confirmation responses (owner replying with a number)
    const confirmNum = /^\s*(\d+)\s*$/.exec(text);
    if (confirmNum && remoteJid) {
      const { data: pending } = await supabase
        .from("pending_task_confirmations")
        .select("*")
        .eq("owner_jid", remoteJid)
        .eq("status", "pending")
        .order("created_at", { ascending: false })
        .limit(1);

      if (pending && pending.length > 0) {
        const confirmation = pending[0];
        const choice = Number(confirmNum[1]);
        const candidates = confirmation.candidates as Candidate[];
        const draft = confirmation.task_draft as Record<string, unknown>;

        const { data: settingsConf } = await supabase.from("app_settings").select("key, value");
        const sConf: Record<string, string> = {};
        for (const row of settingsConf ?? []) sConf[row.key] = row.value;

        let assigneeName = sConf["owner_name"] || "Eu";
        let assigneePhone = normalizePhone(sConf["owner_phone"] ?? "");
        let groupName = "";

        if (choice >= 1 && choice <= candidates.length) {
          const chosen = candidates[choice - 1];
          assigneeName = chosen.name;
          assigneePhone = chosen.is_group ? chosen.remote_jid : normalizePhone(chosen.remote_jid.split("@")[0]);
          groupName = chosen.is_group ? chosen.name : "";

          // Import contact if not already in contacts table
          const { data: existing } = await supabase
            .from("contacts")
            .select("id")
            .eq("remote_jid", chosen.remote_jid)
            .maybeSingle();
          if (!existing) {
            await supabase.from("contacts").insert({
              name: chosen.name,
              phone: chosen.is_group ? chosen.remote_jid : (chosen.phone || ""),
              country_code: "+55",
              department: chosen.is_group ? "Grupo" : "",
              is_group: chosen.is_group,
              remote_jid: chosen.remote_jid,
              active: true,
            });
          }
        }

        await supabase
          .from("pending_task_confirmations")
          .update({ status: "confirmed", resolved_at: new Date().toISOString() })
          .eq("id", confirmation.id);

        const apiUrlConf = sConf["evolution_api_url"]?.replace(/\/$/, "");
        const apiKeyConf = sConf["evolution_api_key"];
        const instanceConf = sConf["evolution_instance_name"];

        // If this is a NL command with proposed_message, go to approval flow
        if (draft.is_nl_command && draft.proposed_message && assigneeName !== (sConf["owner_name"] || "Eu")) {
          const taskDraftForApproval = { ...draft, group_name: groupName };
          await supabase.from("pending_message_approvals").insert({
            owner_jid: remoteJid,
            task_draft: taskDraftForApproval,
            proposed_message: String(draft.proposed_message),
            assignee_name: assigneeName,
            assignee_phone: assigneePhone,
            status: "pending",
          });

          if (apiUrlConf && apiKeyConf && instanceConf) {
            const numberConf = remoteJid.endsWith("@g.us") ? remoteJid : normalizePhone(remoteJid.split("@")[0]);
            const shouldNudge = draft.nudge_active ?? false;
            const approvalMsg =
              `Contato confirmado: *${assigneeName}*\n\nVou enviar:\n---\n${draft.proposed_message}\n---\n\n` +
              (shouldNudge ? `Cobranca ativa: vou acompanhar e cobrar respostas.\n` : `Sem cobranca: apenas envio sem cobrar resposta.\n`) +
              `\nPosso mandar? Responda *ok* para aprovar ou *nao* para cancelar.`;
            await fetch(`${apiUrlConf}/message/sendText/${instanceConf}`, {
              method: "POST",
              headers: { "Content-Type": "application/json", apikey: apiKeyConf },
              body: JSON.stringify({ number: numberConf, text: approvalMsg }),
            });
          }

          await logEvent("confirmation-to-approval", `choice=${choice} assignee=${assigneeName}`);
          return new Response(
            JSON.stringify({ confirmed: true, awaiting_approval: true, assignee: assigneeName }),
            { headers: { ...corsHeaders, "Content-Type": "application/json" } }
          );
        }

        // Standard flow: create task directly
        const { data: created } = await supabase
          .from("tasks")
          .insert({
            title: draft.title ?? "Tarefa sem título",
            description: draft.description ?? "",
            assignee_name: assigneeName,
            assignee_phone: assigneePhone,
            group_name: groupName,
            status: "pending",
            priority: draft.priority ?? "medium",
            due_date: draft.due_date ?? null,
            recurrence: draft.recurrence ?? "none",
            recurrence_interval: draft.recurrence_interval ?? 1,
            first_nudge_at: draft.first_nudge_at ?? null,
            nudge_repeat_hours: draft.nudge_repeat_hours ?? 0,
            nudge_active: draft.nudge_active ?? false,
            gia_instruction: draft.gia_instruction ?? "",
          })
          .select()
          .maybeSingle();

        if (apiUrlConf && apiKeyConf && instanceConf) {
          const numberConf = remoteJid.endsWith("@g.us") ? remoteJid : normalizePhone(remoteJid.split("@")[0]);
          const code = created?.task_code ? ` ${created.task_code}` : "";
          const replyMsg = choice === 0
            ? `Ok! Tarefa criada${code} e atribuída a você mesmo.`
            : `Perfeito! Tarefa criada${code} para *${assigneeName}*${groupName ? " (grupo)" : ""}.`;
          await fetch(`${apiUrlConf}/message/sendText/${instanceConf}`, {
            method: "POST",
            headers: { "Content-Type": "application/json", apikey: apiKeyConf },
            body: JSON.stringify({ number: numberConf, text: replyMsg }),
          });
        }

        await logEvent("confirmation-resolved", `choice=${choice} task=${created?.id ?? ""}`);
        return new Response(
          JSON.stringify({ confirmed: true, choice, task_id: created?.id }),
          { headers: { ...corsHeaders, "Content-Type": "application/json" } }
        );
      }
    }

    // Skip messages that are GIA's own responses (sent by the bot itself via Evolution API)
    const isGiaOwnMessage = /Posso mandar\? Responda|Entendi!? Vou enviar|Mensagem enviada para|Cancelado\. Mensagem nao|Nao entendi a correcao|Encontrei estes contatos|Agendado\s*ATOM-|Aqui (é|e) a GIA|Pronto!? .*enviada|Reagendado\s*ATOM-|Cobran.a enviada|Executive Advisor do Sr\./i.test(text);
    if (isGiaOwnMessage && fromMe) {
      await logEvent("ignored-gia-own-message", text.slice(0, 60));
      return new Response(JSON.stringify({ ignored: true, reason: "gia_own_message" }), {
        headers: { ...corsHeaders, "Content-Type": "application/json" },
      });
    }

    // Handle pending message approval responses (owner replying "ok"/"sim"/"manda"/"nao"/"cancela")
    if (text && remoteJid) {
      const approvalText = text.trim().toLowerCase();
      const isApprove = /^(ok|sim|manda|envia|aprovo|pode|pode mandar|vai|manda ver|show|beleza|perfeito|bora|blz|s)\s*$/i.test(approvalText);
      const isReject = /^(n[aã]o|cancela|nao|nope|n|nao manda|cancela|para|deixa|esquece)\s*$/i.test(approvalText);
      if (isApprove || isReject) {
        const { data: pendingApproval } = await supabase
          .from("pending_message_approvals")
          .select("*")
          .eq("owner_jid", remoteJid)
          .eq("status", "pending")
          .order("created_at", { ascending: false })
          .limit(1);

        if (pendingApproval && pendingApproval.length > 0) {
          const approval = pendingApproval[0];
          const { data: settingsAppr } = await supabase.from("app_settings").select("key, value");
          const sAppr: Record<string, string> = {};
          for (const row of settingsAppr ?? []) sAppr[row.key] = row.value;
          const apiUrlAppr = sAppr["evolution_api_url"]?.replace(/\/$/, "");
          const apiKeyAppr = sAppr["evolution_api_key"];
          const instanceAppr = sAppr["evolution_instance_name"];

          if (isReject) {
            await supabase
              .from("pending_message_approvals")
              .update({ status: "rejected", resolved_at: new Date().toISOString() })
              .eq("id", approval.id);
            if (apiUrlAppr && apiKeyAppr && instanceAppr) {
              const numberAppr = remoteJid.endsWith("@g.us") ? remoteJid : normalizePhone(remoteJid.split("@")[0]);
              await fetch(`${apiUrlAppr}/message/sendText/${instanceAppr}`, {
                method: "POST",
                headers: { "Content-Type": "application/json", apikey: apiKeyAppr },
                body: JSON.stringify({ number: numberAppr, text: "Cancelado. Mensagem nao enviada." }),
              });
            }
            await logEvent("message-approval-rejected", `approval=${approval.id}`);
            return new Response(
              JSON.stringify({ approval_rejected: true, id: approval.id }),
              { headers: { ...corsHeaders, "Content-Type": "application/json" } }
            );
          }

          // Approved - create the task and send (or schedule) the message
          const draft = approval.task_draft as Record<string, unknown>;
          const dueDate = draft.due_date ? String(draft.due_date) : null;
          const scheduledSend = draft.scheduled_send ? String(draft.scheduled_send) : null;
          const draftSendNow = draft.send_now === true || draft.send_now === "true";
          // Schedule for later if there's a scheduled_send time in the future
          const isScheduledForLater = scheduledSend && new Date(scheduledSend).getTime() > Date.now() + 60000;

          // If scheduled for the future, store the exact message in gia_instruction for send-task-nudge to use
          // Format: ENVIAR_MENSAGEM_EXATA:[PRAZO:iso|NUDGE_HOURS:n|INSTRUCTION:text] message
          const giaInstructionForTask = isScheduledForLater
            ? `ENVIAR_MENSAGEM_EXATA:${hasDeadlineSeparateFromSend ? `[PRAZO:${dueDate}|NUDGE_HOURS:${draft.nudge_repeat_hours ?? 4}|INSTRUCTION:${String(draft.gia_instruction ?? "")}]` : ""} ${approval.proposed_message}`
            : String(draft.gia_instruction ?? "");

          const { data: createdTask } = await supabase
            .from("tasks")
            .insert({
              title: draft.title ?? "Tarefa sem título",
              description: draft.description ?? "",
              assignee_name: approval.assignee_name,
              assignee_phone: approval.assignee_phone,
              group_name: draft.group_name ?? "",
              status: "pending",
              priority: draft.priority ?? "medium",
              due_date: isScheduledForLater ? scheduledSend : (dueDate ?? null),
              recurrence: draft.recurrence ?? "none",
              recurrence_interval: draft.recurrence_interval ?? 1,
              first_nudge_at: isScheduledForLater ? scheduledSend : (dueDate ?? (draft.first_nudge_at ?? null)),
              nudge_repeat_hours: draft.nudge_repeat_hours ?? 0,
              nudge_active: isScheduledForLater ? true : (dueDate ? true : (draft.nudge_active ?? false)),
              gia_instruction: giaInstructionForTask,
            })
            .select()
            .maybeSingle();

          // After task created, if there's a separate deadline, store it for post-send update
          const hasDeadlineSeparateFromSend = isScheduledForLater && dueDate && dueDate !== scheduledSend;

          if (isScheduledForLater) {
            // DON'T send now - it's scheduled for later
            await supabase
              .from("pending_message_approvals")
              .update({ status: "approved", resolved_at: new Date().toISOString(), task_id: createdTask?.id ?? null })
              .eq("id", approval.id);

            if (apiUrlAppr && apiKeyAppr && instanceAppr) {
              const numberAppr = remoteJid.endsWith("@g.us") ? remoteJid : normalizePhone(remoteJid.split("@")[0]);
              const code = createdTask?.task_code ? ` ${createdTask.task_code}` : "";
              const fmtSched = (iso: string) => {
                const dt = new Date(iso);
                const br = new Date(dt.getTime() - 3 * 60 * 60 * 1000);
                const dd = String(br.getUTCDate()).padStart(2, "0");
                const mm = String(br.getUTCMonth() + 1).padStart(2, "0");
                const hh = String(br.getUTCHours()).padStart(2, "0");
                const mi = String(br.getUTCMinutes()).padStart(2, "0");
                const days = ["dom", "seg", "ter", "qua", "qui", "sex", "sab"];
                return `${days[br.getUTCDay()]} ${dd}/${mm} as ${hh}:${mi}`;
              };
              let scheduleMsg = `Agendado${code}! Vou enviar para *${approval.assignee_name}* em ${fmtSched(scheduledSend)}.`;
              if (hasDeadlineSeparateFromSend) {
                scheduleMsg += `\nPrazo final da tarefa: ${fmtSched(dueDate)}.`;
                scheduleMsg += `\nCobranca ativa apos o prazo.`;
              }
              scheduleMsg += ` Pode ficar tranquilo.`;
              await fetch(`${apiUrlAppr}/message/sendText/${instanceAppr}`, {
                method: "POST",
                headers: { "Content-Type": "application/json", apikey: apiKeyAppr },
                body: JSON.stringify({ number: numberAppr, text: scheduleMsg }),
              });
            }

            await logEvent("message-approval-scheduled", `approval=${approval.id} task=${createdTask?.id ?? ""} send=${scheduledSend} due=${dueDate}`);
            return new Response(
              JSON.stringify({ approved: true, scheduled: true, task_id: createdTask?.id, due_date: dueDate }),
              { headers: { ...corsHeaders, "Content-Type": "application/json" } }
            );
          }

          // Send the proposed message NOW to the contact
          if (apiUrlAppr && apiKeyAppr && instanceAppr && approval.proposed_message) {
            const realCode = createdTask?.task_code ?? "";
            // Replace ATOM-XXXX placeholder with real task code
            let finalMessage = String(approval.proposed_message);
            if (realCode) {
              finalMessage = finalMessage.replace(/ATOM-XXXX/g, realCode);
            }
            const isGroupAppr = String(approval.assignee_phone).includes("@g.us");
            let numberDest = isGroupAppr ? approval.assignee_phone : normalizePhone(approval.assignee_phone);
            if (!isGroupAppr && numberDest.length <= 11) numberDest = "55" + numberDest;
            await fetch(`${apiUrlAppr}/message/sendText/${instanceAppr}`, {
              method: "POST",
              headers: { "Content-Type": "application/json", apikey: apiKeyAppr },
              body: JSON.stringify({ number: numberDest, text: finalMessage }),
            });
            await supabase.from("send_logs").insert({
              contact_name: approval.assignee_name,
              contact_phone: approval.assignee_phone,
              template_name: "Mensagem aprovada (GIA NL)",
              message_content: finalMessage,
              status: "sent",
              sent_at: new Date().toISOString(),
            });
          }

          await supabase
            .from("pending_message_approvals")
            .update({ status: "approved", resolved_at: new Date().toISOString(), task_id: createdTask?.id ?? null })
            .eq("id", approval.id);

          // Notify the owner
          if (apiUrlAppr && apiKeyAppr && instanceAppr) {
            const numberAppr = remoteJid.endsWith("@g.us") ? remoteJid : normalizePhone(remoteJid.split("@")[0]);
            const code = createdTask?.task_code ? ` ${createdTask.task_code}` : "";
            const confirmMsg = `Mensagem enviada para *${approval.assignee_name}*${code}. Estou acompanhando.`;
            await fetch(`${apiUrlAppr}/message/sendText/${instanceAppr}`, {
              method: "POST",
              headers: { "Content-Type": "application/json", apikey: apiKeyAppr },
              body: JSON.stringify({ number: numberAppr, text: confirmMsg }),
            });
          }

          await logEvent("message-approval-sent", `approval=${approval.id} task=${createdTask?.id ?? ""}`);
          return new Response(
            JSON.stringify({ approved: true, task_id: createdTask?.id }),
            { headers: { ...corsHeaders, "Content-Type": "application/json" } }
          );
        }
      }
    }

    // Handle pending approval EDIT/CORRECTION: owner sends a non-trivial message while approval is pending
    // This catches cases like "Nao, envia assim: [new message]" or any conversational correction
    if (text && remoteJid && text.trim().length > 3) {
      const { data: pendingApprovalEdit } = await supabase
        .from("pending_message_approvals")
        .select("*")
        .eq("owner_jid", remoteJid)
        .eq("status", "pending")
        .order("created_at", { ascending: false })
        .limit(1);

      if (pendingApprovalEdit && pendingApprovalEdit.length > 0) {
        const approval = pendingApprovalEdit[0];
        const { data: settingsEdit } = await supabase.from("app_settings").select("key, value");
        const sEdit: Record<string, string> = {};
        for (const row of settingsEdit ?? []) sEdit[row.key] = row.value;
        const apiUrlEdit = sEdit["evolution_api_url"]?.replace(/\/$/, "");
        const apiKeyEdit = sEdit["evolution_api_key"];
        const instanceEdit = sEdit["evolution_instance_name"];
        const openaiKeyEdit = sEdit["openai_api_key"] ?? "";
        const openaiModelEdit = sEdit["openai_model"] || "gpt-4o-mini";

        // Use GPT to understand what the owner wants
        let newMessage = "";
        let ownerIntent: "edit" | "cancel" | "approve" | "new_instruction" = "edit";

        if (openaiKeyEdit) {
          try {
            const editPrompt = `Voce e a GIA, assistente executiva. O gestor tinha pedido para enviar esta mensagem para ${approval.assignee_name}:

MENSAGEM ORIGINAL:
"${approval.proposed_message}"

O gestor respondeu com:
"${text}"

Analise a resposta do gestor e responda APENAS com JSON valido:
{
  "intent": "edit" ou "cancel" ou "approve" ou "new_instruction",
  "new_message": "a nova mensagem corrigida para enviar (se intent=edit). Se o gestor forneceu o texto exato, use EXATAMENTE o que ele escreveu. Se ele deu instrucoes de como mudar, aplique as mudancas na mensagem original.",
  "explanation": "explicacao curta do que o gestor quer"
}

REGRAS:
- Se o gestor fornece uma versao corrigida da mensagem (ex: "Nao, envia assim: ..."), intent=edit e new_message = o texto corrigido que ele forneceu
- Se o gestor diz pra cancelar/nao enviar, intent=cancel
- Se o gestor aprova de alguma forma, intent=approve
- Se o gestor da uma instrucao generica de mudanca (ex: "seja mais firme", "tira a parte do seguro"), intent=edit e voce deve aplicar a mudanca na mensagem original
- IMPORTANTE: Se o gestor escreve a mensagem inteira de volta com correcoes, use EXATAMENTE o texto dele, nao invente nada
- A new_message deve manter o tom profissional da GIA como assistente do gestor`;

            const editRes = await fetch("https://api.openai.com/v1/chat/completions", {
              method: "POST",
              headers: { "Content-Type": "application/json", Authorization: `Bearer ${openaiKeyEdit}` },
              body: JSON.stringify({
                model: openaiModelEdit,
                temperature: 0.2,
                messages: [
                  { role: "system", content: "Voce interpreta correcoes/instrucoes do gestor para mensagens. Responda SOMENTE com JSON valido." },
                  { role: "user", content: editPrompt },
                ],
              }),
            });

            if (editRes.ok) {
              const editData = await editRes.json();
              const rawEdit = String(editData?.choices?.[0]?.message?.content ?? "").trim();
              const jsonEdit = rawEdit.replace(/^```(?:json)?\s*/i, "").replace(/\s*```$/, "");
              const parsed = JSON.parse(jsonEdit);
              ownerIntent = parsed.intent || "edit";
              newMessage = String(parsed.new_message || "").trim();
            }
          } catch { /* fallback: treat as literal replacement */ }
        }

        // Fallback: if GPT failed or no key, try to extract the message directly
        if (!newMessage && ownerIntent === "edit") {
          const directMsg = text.replace(/^[Nn][aã]o[,.]?\s*(envia|manda|fala|escreve)\s*(assim|isso|isso aqui)?[:\s]*/i, "").trim();
          if (directMsg.length > 10) {
            newMessage = directMsg;
          }
        }

        if (ownerIntent === "cancel") {
          await supabase
            .from("pending_message_approvals")
            .update({ status: "rejected", resolved_at: new Date().toISOString() })
            .eq("id", approval.id);
          if (apiUrlEdit && apiKeyEdit && instanceEdit) {
            const numberEdit = remoteJid.endsWith("@g.us") ? remoteJid : normalizePhone(remoteJid.split("@")[0]);
            await fetch(`${apiUrlEdit}/message/sendText/${instanceEdit}`, {
              method: "POST",
              headers: { "Content-Type": "application/json", apikey: apiKeyEdit },
              body: JSON.stringify({ number: numberEdit, text: "Cancelado. Mensagem nao enviada." }),
            });
          }
          await logEvent("approval-edit-cancelled", `approval=${approval.id}`);
          return new Response(
            JSON.stringify({ approval_cancelled: true, id: approval.id }),
            { headers: { ...corsHeaders, "Content-Type": "application/json" } }
          );
        }

        if (ownerIntent === "approve") {
          // Treat as approval - reuse the existing approval logic
          const draft = approval.task_draft as Record<string, unknown>;
          const { data: createdTask } = await supabase
            .from("tasks")
            .insert({
              title: draft.title ?? "Tarefa sem título",
              description: draft.description ?? "",
              assignee_name: approval.assignee_name,
              assignee_phone: approval.assignee_phone,
              group_name: draft.group_name ?? "",
              status: "pending",
              priority: draft.priority ?? "medium",
              due_date: draft.due_date ?? null,
              recurrence: draft.recurrence ?? "none",
              recurrence_interval: draft.recurrence_interval ?? 1,
              first_nudge_at: draft.first_nudge_at ?? null,
              nudge_repeat_hours: draft.nudge_repeat_hours ?? 0,
              nudge_active: draft.nudge_active ?? false,
              gia_instruction: draft.gia_instruction ?? "",
            })
            .select()
            .maybeSingle();

          if (apiUrlEdit && apiKeyEdit && instanceEdit && approval.proposed_message) {
            const isGroupEdit = String(approval.assignee_phone).includes("@g.us");
            let numberDest = isGroupEdit ? approval.assignee_phone : normalizePhone(approval.assignee_phone);
            if (!isGroupEdit && numberDest.length <= 11) numberDest = "55" + numberDest;
            await fetch(`${apiUrlEdit}/message/sendText/${instanceEdit}`, {
              method: "POST",
              headers: { "Content-Type": "application/json", apikey: apiKeyEdit },
              body: JSON.stringify({ number: numberDest, text: approval.proposed_message }),
            });
            await supabase.from("send_logs").insert({
              contact_name: approval.assignee_name,
              contact_phone: approval.assignee_phone,
              template_name: "Mensagem aprovada (GIA NL)",
              message_content: approval.proposed_message,
              status: "sent",
              sent_at: new Date().toISOString(),
            });
          }

          await supabase
            .from("pending_message_approvals")
            .update({ status: "approved", resolved_at: new Date().toISOString(), task_id: createdTask?.id ?? null })
            .eq("id", approval.id);

          if (apiUrlEdit && apiKeyEdit && instanceEdit) {
            const numberEdit = remoteJid.endsWith("@g.us") ? remoteJid : normalizePhone(remoteJid.split("@")[0]);
            const code = createdTask?.task_code ? ` ${createdTask.task_code}` : "";
            await fetch(`${apiUrlEdit}/message/sendText/${instanceEdit}`, {
              method: "POST",
              headers: { "Content-Type": "application/json", apikey: apiKeyEdit },
              body: JSON.stringify({ number: numberEdit, text: `Mensagem enviada para *${approval.assignee_name}*${code}. Estou acompanhando.` }),
            });
          }

          await logEvent("approval-edit-approved", `approval=${approval.id}`);
          return new Response(
            JSON.stringify({ approved: true, task_id: createdTask?.id }),
            { headers: { ...corsHeaders, "Content-Type": "application/json" } }
          );
        }

        // ownerIntent === "edit" or "new_instruction" - update the message and re-ask
        if (newMessage) {
          await supabase
            .from("pending_message_approvals")
            .update({ proposed_message: newMessage })
            .eq("id", approval.id);

          if (apiUrlEdit && apiKeyEdit && instanceEdit) {
            const numberEdit = remoteJid.endsWith("@g.us") ? remoteJid : normalizePhone(remoteJid.split("@")[0]);
            const draft = approval.task_draft as Record<string, unknown>;
            const shouldNudge = draft.nudge_active ?? false;
            const reAskMsg =
              `Entendi! Vou enviar para *${approval.assignee_name}*:\n\n` +
              `---\n${newMessage}\n---\n\n` +
              (shouldNudge ? `Cobranca ativa: vou acompanhar e cobrar respostas.\n` : `Sem cobranca: apenas envio sem cobrar resposta.\n`) +
              `\nPosso mandar? Responda *ok* para aprovar ou *nao* para cancelar.`;
            await fetch(`${apiUrlEdit}/message/sendText/${instanceEdit}`, {
              method: "POST",
              headers: { "Content-Type": "application/json", apikey: apiKeyEdit },
              body: JSON.stringify({ number: numberEdit, text: reAskMsg }),
            });
          }

          await logEvent("approval-message-edited", `approval=${approval.id}`);
          return new Response(
            JSON.stringify({ edited: true, id: approval.id, new_message: newMessage }),
            { headers: { ...corsHeaders, "Content-Type": "application/json" } }
          );
        }

        // If we couldn't parse the edit, ask for clarification
        if (apiUrlEdit && apiKeyEdit && instanceEdit) {
          const numberEdit = remoteJid.endsWith("@g.us") ? remoteJid : normalizePhone(remoteJid.split("@")[0]);
          await fetch(`${apiUrlEdit}/message/sendText/${instanceEdit}`, {
            method: "POST",
            headers: { "Content-Type": "application/json", apikey: apiKeyEdit },
            body: JSON.stringify({
              number: numberEdit,
              text: `Nao entendi a correcao. Voce pode:\n- Enviar a mensagem corrigida por completo\n- Responder *ok* para aprovar como esta\n- Responder *nao* para cancelar`,
            }),
          });
        }

        await logEvent("approval-edit-unclear", `approval=${approval.id}`);
        return new Response(
          JSON.stringify({ unclear_edit: true, id: approval.id }),
          { headers: { ...corsHeaders, "Content-Type": "application/json" } }
        );
      }
    }

    // Command: "GIA relatorio" / "GIA me de o relatorio" triggers daily report
    const reportMatch = /^\s*GIA\s*[\s:,]+.*(relat[oó]rio|report|resumo\s+di[aá]rio)/i.test(text);
    if (reportMatch && remoteJid) {
      const { data: settingsRowsRpt } = await supabase.from("app_settings").select("key, value");
      const sRpt: Record<string, string> = {};
      for (const row of settingsRowsRpt ?? []) sRpt[row.key] = row.value;
      const ownerPhoneRpt = sRpt["owner_phone"] ?? "";
      const incomingRpt = remoteJid.split("@")[0];
      const isOwnerRpt = ownerPhoneRpt && phonesMatch(ownerPhoneRpt, incomingRpt);

      if (isOwnerRpt) {
        const reportUrl = `${Deno.env.get("SUPABASE_URL")}/functions/v1/report-overdue-tasks`;
        await fetch(reportUrl, {
          method: "POST",
          headers: {
            "Content-Type": "application/json",
            Authorization: `Bearer ${Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")}`,
          },
          body: JSON.stringify({}),
        });
        await logEvent("report-triggered", "Owner requested daily report via command");
        return new Response(
          JSON.stringify({ action: "report-triggered" }),
          { headers: { ...corsHeaders, "Content-Type": "application/json" } }
        );
      }
    }

    const giaMatch = /^\s*GIA\s*:\s*([\s\S]+)$/i.exec(text);
    if (giaMatch && remoteJid) {
      const { data: settingsRowsGia } = await supabase.from("app_settings").select("key, value");
      const settingsGia: Record<string, string> = {};
      for (const row of settingsRowsGia ?? []) settingsGia[row.key] = row.value;
      const ownerPhone = settingsGia["owner_phone"] ?? "";
      const incoming = remoteJid.split("@")[0];
      const isOwner = ownerPhone && phonesMatch(ownerPhone, incoming);

      if (isOwner) {
        const body = giaMatch[1].trim();
        const fields: Record<string, string> = {};
        const fieldAliases: Record<string, string> = {
          titulo: "title", título: "title", title: "title", tarefa: "title",
          descricao: "description", descrição: "description", desc: "description", description: "description",
          para: "assignee", destinatario: "assignee", destinatário: "assignee", responsavel: "assignee", responsável: "assignee", assignee: "assignee", quem: "assignee",
          prioridade: "priority", priority: "priority",
          prazo: "due", vencimento: "due", due: "due", quando: "due", data: "due",
          recorrencia: "recurrence", recorrência: "recurrence", recurrence: "recurrence",
          cobranca: "nudge", cobrança: "nudge", nudge: "nudge",
          repetir: "repeat", repeat: "repeat", intervalo: "repeat",
          instrucao: "instruction", instrução: "instruction", instruction: "instruction", modo: "instruction",
        };
        const lines = body.split(/\n+/).map((l) => l.trim()).filter(Boolean);
        const knownKeyRegex = /^([A-Za-zÀ-ú\s]+?)\s*:\s*(.+)$/;
        const titleParts: string[] = [];
        for (const line of lines) {
          const m = knownKeyRegex.exec(line);
          if (m) {
            const key = m[1].trim().toLowerCase().replace(/\s+/g, "");
            const mapped = fieldAliases[key];
            if (mapped) {
              fields[mapped] = (fields[mapped] ? fields[mapped] + " " : "") + m[2].trim();
              continue;
            }
          }
          titleParts.push(line);
        }
        if (!fields.title && titleParts.length) {
          fields.title = titleParts.shift() ?? "";
          if (titleParts.length && !fields.description) fields.description = titleParts.join("\n");
        } else if (titleParts.length && !fields.description) {
          fields.description = titleParts.join("\n");
        }

        const title = (fields.title ?? "").trim().slice(0, 200) || "Tarefa sem título";
        const description = (fields.description ?? "").trim();
        const giaInstruction = (fields.instruction ?? "").trim();

        const priorityRaw = (fields.priority ?? "").toLowerCase();
        const priority =
          /alta|high|urgente/.test(priorityRaw) ? "high" :
          /baixa|low/.test(priorityRaw) ? "low" : "medium";

        const recurrenceRaw = (fields.recurrence ?? "").toLowerCase();
        let recurrence: "none" | "daily" | "weekdays" | "weekly" | "monthly" = "none";
        let recurrenceInterval = 1;
        if (/diari|daily|todo dia|todos os dias/.test(recurrenceRaw)) recurrence = "daily";
        else if (/util|úteis|weekdays|dias [úu]te/.test(recurrenceRaw)) recurrence = "weekdays";
        else if (/seman|weekly/.test(recurrenceRaw)) recurrence = "weekly";
        else if (/mens|month/.test(recurrenceRaw)) recurrence = "monthly";
        const intervalMatch = /(?:x|cada|a cada|every)\s*(\d+)/i.exec(recurrenceRaw);
        if (intervalMatch) recurrenceInterval = Math.max(1, Number(intervalMatch[1]));

        function parseDate(input: string): string | null {
          if (!input) return null;
          const s = input.trim();
          const tzOffsetMs = -3 * 60 * 60 * 1000;
          const now = new Date();
          const localNow = new Date(now.getTime() + tzOffsetMs);
          const hhmm = /(\d{1,2})[:hH](\d{2})/.exec(s);
          let hour = 9, minute = 0;
          if (hhmm) { hour = Number(hhmm[1]); minute = Number(hhmm[2]); }
          let y = localNow.getUTCFullYear(), mo = localNow.getUTCMonth(), d = localNow.getUTCDate();
          let matched = false;
          const iso = /(\d{4})-(\d{2})-(\d{2})/.exec(s);
          const dmy = /(\d{1,2})\/(\d{1,2})(?:\/(\d{2,4}))?/.exec(s);
          if (iso) {
            y = Number(iso[1]); mo = Number(iso[2]) - 1; d = Number(iso[3]); matched = true;
          } else if (dmy) {
            d = Number(dmy[1]); mo = Number(dmy[2]) - 1;
            if (dmy[3]) { const yr = Number(dmy[3]); y = yr < 100 ? 2000 + yr : yr; }
            matched = true;
          } else if (/hoje/i.test(s)) {
            matched = true;
          } else if (/amanh[ãa]/i.test(s)) {
            const t = new Date(Date.UTC(y, mo, d + 1)); y = t.getUTCFullYear(); mo = t.getUTCMonth(); d = t.getUTCDate(); matched = true;
          }
          if (!matched && !hhmm) return null;
          const utcMs = Date.UTC(y, mo, d, hour, minute) - tzOffsetMs;
          return new Date(utcMs).toISOString();
        }

        const due_date = parseDate(fields.due ?? "");
        let first_nudge_at = parseDate(fields.nudge ?? "") ?? due_date;

        const defaultNudgeHours = Number(settingsGia["default_nudge_hours"] || "1") || 1;
        const defaultRepeatHours = Number(settingsGia["default_repeat_hours"] || "4") || 4;

        const repeatRaw = (fields.repeat ?? "").toLowerCase();
        let nudge_repeat_hours = 0;
        const repH = /(\d+)\s*h/.exec(repeatRaw);
        const repMin = /(\d+)\s*m/.exec(repeatRaw);
        const repD = /(\d+)\s*d/.exec(repeatRaw);
        if (repH) nudge_repeat_hours = Number(repH[1]);
        else if (repMin) nudge_repeat_hours = Math.max(1, Math.round(Number(repMin[1]) / 60));
        else if (repD) nudge_repeat_hours = Number(repD[1]) * 24;
        else nudge_repeat_hours = defaultRepeatHours;

        let nudge_active = Boolean(first_nudge_at);
        if (!first_nudge_at && due_date) {
          const dueMs = new Date(due_date).getTime();
          const autoNudge = new Date(dueMs + defaultNudgeHours * 60 * 60 * 1000).toISOString();
          first_nudge_at = autoNudge;
          nudge_active = true;
        }

        let assigneeName = settingsGia["owner_name"] || "Eu";
        let assigneePhone = normalizePhone(ownerPhone);
        let groupName = "";
        let resolveNote = "";
        const assigneeRaw = (fields.assignee ?? "").trim();
        if (assigneeRaw) {
          const onlyDigits = normalizePhone(assigneeRaw);
          const looksLikePhone = onlyDigits.length >= 10 && /^[0-9+\s\-\(\)]+$/.test(assigneeRaw);
          if (looksLikePhone) {
            const { data: byPhone } = await supabase
              .from("contacts")
              .select("id, name, phone, country_code, is_group, remote_jid")
              .eq("active", true);
            const found = (byPhone ?? []).find((c) =>
              phonesMatch(`${c.country_code ?? ""}${c.phone ?? ""}`, onlyDigits) ||
              phonesMatch(String(c.phone ?? ""), onlyDigits)
            );
            if (found) {
              assigneeName = found.name;
              if (found.remote_jid) {
                assigneePhone = found.is_group ? String(found.remote_jid) : normalizePhone(String(found.remote_jid).split("@")[0]);
              } else {
                assigneePhone = normalizePhone(String(found.phone ?? ""));
              }
              if (found.is_group) groupName = found.name;
            } else {
              assigneeName = assigneeRaw;
              assigneePhone = onlyDigits;
              resolveNote = " (contato novo, criado pelo número)";
            }
          } else {
            const { data: byName } = await supabase
              .from("contacts")
              .select("id, name, phone, country_code, is_group, remote_jid")
              .eq("active", true)
              .ilike("name", `%${assigneeRaw}%`)
              .limit(5);
            if (byName && byName.length === 1) {
              const c = byName[0];
              assigneeName = c.name;
              if (c.remote_jid) {
                assigneePhone = c.is_group ? String(c.remote_jid) : normalizePhone(String(c.remote_jid).split("@")[0]);
              } else {
                assigneePhone = normalizePhone(String(c.phone ?? ""));
              }
              if (c.is_group) groupName = c.name;
            } else if (byName && byName.length > 1) {
              const exact = byName.find((c) => c.name.toLowerCase() === assigneeRaw.toLowerCase());
              if (exact) {
                assigneeName = exact.name;
                if (exact.remote_jid) {
                  assigneePhone = exact.is_group ? String(exact.remote_jid) : normalizePhone(String(exact.remote_jid).split("@")[0]);
                } else {
                  assigneePhone = normalizePhone(String(exact.phone ?? ""));
                }
                if (exact.is_group) groupName = exact.name;
              } else {
                const candidates = byName.map((c) => ({
                  remote_jid: c.remote_jid ?? "",
                  name: c.name,
                  phone: c.phone ?? "",
                  is_group: c.is_group ?? false,
                }));
                const confirmationNeeded = await askConfirmation(
                  supabase, settingsGia, remoteJid, assigneeRaw, candidates,
                  { title, description, priority, due_date, recurrence, recurrence_interval: recurrenceInterval, first_nudge_at: first_nudge_at, nudge_repeat_hours, nudge_active, gia_instruction: giaInstruction }
                );
                if (confirmationNeeded) {
                  await logEvent("gia-awaiting-confirmation", `assignee="${assigneeRaw}" candidates=${candidates.length}`);
                  return new Response(
                    JSON.stringify({ awaiting_confirmation: true, assignee: assigneeRaw }),
                    { headers: { ...corsHeaders, "Content-Type": "application/json" } }
                  );
                }
                resolveNote = ` (atribuído a você porque havia múltiplos contatos com "${assigneeRaw}": ${byName.map((c) => c.name).join(", ")})`;
              }
            } else {
              const whatsappCandidates = await searchWhatsAppChats(settingsGia, assigneeRaw);
              if (whatsappCandidates.length > 0) {
                const confirmationNeeded = await askConfirmation(
                  supabase, settingsGia, remoteJid, assigneeRaw, whatsappCandidates,
                  { title, description, priority, due_date, recurrence, recurrence_interval: recurrenceInterval, first_nudge_at: first_nudge_at, nudge_repeat_hours, nudge_active, gia_instruction: giaInstruction }
                );
                if (confirmationNeeded) {
                  await logEvent("gia-awaiting-confirmation", `assignee="${assigneeRaw}" candidates=${whatsappCandidates.length}`);
                  return new Response(
                    JSON.stringify({ awaiting_confirmation: true, assignee: assigneeRaw }),
                    { headers: { ...corsHeaders, "Content-Type": "application/json" } }
                  );
                }
              }
              resolveNote = ` (contato "${assigneeRaw}" não encontrado, atribuído a você)`;
            }
          }
        }

        const { data: created } = await supabase
          .from("tasks")
          .insert({
            title,
            description,
            assignee_name: assigneeName,
            assignee_phone: assigneePhone,
            group_name: groupName,
            status: "pending",
            priority,
            due_date,
            recurrence,
            recurrence_interval: recurrenceInterval,
            first_nudge_at,
            nudge_repeat_hours,
            nudge_active,
            gia_instruction: giaInstruction,
          })
          .select()
          .maybeSingle();

        const apiUrlGia = settingsGia["evolution_api_url"]?.replace(/\/$/, "");
        const apiKeyGia = settingsGia["evolution_api_key"];
        const instanceGia = settingsGia["evolution_instance_name"];
        const autoReplyGia = settingsGia["ai_auto_reply"] !== "false";
        if (autoReplyGia && apiUrlGia && apiKeyGia && instanceGia) {
          const numberGia = remoteJid.endsWith("@g.us") ? remoteJid : normalizePhone(remoteJid.split("@")[0]);
          const code = created?.task_code ? ` ${created.task_code}` : "";
          const fmtDate = (iso: string | null) => {
            if (!iso) return "—";
            const dt = new Date(iso);
            const br = new Date(dt.getTime() - 3 * 60 * 60 * 1000);
            const dd = String(br.getUTCDate()).padStart(2, "0");
            const mm = String(br.getUTCMonth() + 1).padStart(2, "0");
            const hh = String(br.getUTCHours()).padStart(2, "0");
            const mi = String(br.getUTCMinutes()).padStart(2, "0");
            return `${dd}/${mm} ${hh}:${mi}`;
          };
          const summary =
            `Tarefa criada${code}\n` +
            `Título: ${title}\n` +
            `Para: ${assigneeName}${resolveNote}\n` +
            `Prioridade: ${priority === "high" ? "alta" : priority === "low" ? "baixa" : "média"}\n` +
            `Prazo: ${fmtDate(due_date)}\n` +
            `Recorrência: ${recurrence === "none" ? "nenhuma" : recurrence}${recurrence !== "none" && recurrenceInterval > 1 ? ` x${recurrenceInterval}` : ""}\n` +
            `Cobrança: ${fmtDate(first_nudge_at)}${nudge_repeat_hours > 0 ? ` (repete a cada ${nudge_repeat_hours}h)` : ""}` +
            (giaInstruction ? `\nInstrução: ${giaInstruction}` : "");
          await fetch(`${apiUrlGia}/message/sendText/${instanceGia}`, {
            method: "POST",
            headers: { "Content-Type": "application/json", apikey: apiKeyGia },
            body: JSON.stringify({ number: numberGia, text: summary }),
          });
        }

        await logEvent("gia-task-created", String(created?.id ?? ""));
        return new Response(
          JSON.stringify({ created: true, task_id: created?.id, title, assignee: assigneeName }),
          { headers: { ...corsHeaders, "Content-Type": "application/json" } }
        );
      }
    }

    // Natural language GIA command: "GIA, envia para fulano..." or "GIA envia..." (no structured fields)
    const giaNLMatch = /^\s*GIA\s*[,\s]+(.+)$/is.exec(text);
    const isStructuredGIA = /^\s*GIA\s*:/i.test(text);
    if (giaNLMatch && !isStructuredGIA && remoteJid && fromMe) {
      const { data: settingsNL } = await supabase.from("app_settings").select("key, value");
      const sNL: Record<string, string> = {};
      for (const row of settingsNL ?? []) sNL[row.key] = row.value;
      const ownerPhoneNL = sNL["owner_phone"] ?? "";
      const incomingNL = remoteJid.split("@")[0];
      const isOwnerNL = ownerPhoneNL && phonesMatch(ownerPhoneNL, incomingNL);

      if (isOwnerNL) {
        const openaiKeyNL = sNL["openai_api_key"] ?? "";
        const openaiModelNL = sNL["openai_model"] || "gpt-4o-mini";

        if (openaiKeyNL) {
          const freeText = giaNLMatch[1].trim();
          const nowBR = new Date(Date.now() - 3 * 60 * 60 * 1000);
          const todayISO = nowBR.toISOString().slice(0, 10);
          const dayNames = ["domingo", "segunda-feira", "terca-feira", "quarta-feira", "quinta-feira", "sexta-feira", "sabado"];
          const todayDayName = dayNames[nowBR.getUTCDay()];
          const rawOwnerName = sNL["owner_name"] ?? "";
          const ownerName = (rawOwnerName && rawOwnerName.toLowerCase() !== "eu") ? rawOwnerName : "Marco Abdo";

          const parsePrompt = `Voce e a GIA, assistente executiva. O gestor enviou este comando por WhatsApp em linguagem natural. Extraia as informacoes estruturadas.

HOJE: ${todayISO} (${todayDayName})
NOME DO GESTOR: ${ownerName}

COMANDO: "${freeText}"

Responda APENAS com JSON valido (sem markdown, sem crase), com estes campos:
{
  "title": "titulo curto da tarefa/acao (max 80 chars)",
  "description": "descricao completa do que fazer",
  "assignee": "nome da PESSOA ou GRUPO destinatario da mensagem (ONDE a mensagem sera enviada)",
  "assignees": ["lista de nomes se houver MULTIPLOS destinatarios, senao array vazio"],
  "is_group": false,
  "priority": "high/medium/low",
  "scheduled_send_iso": "data e hora de QUANDO A MENSAGEM deve ser ENVIADA, em ISO 8601. Se 'envia amanha 08:30' -> amanha 08:30. Se 'envia agora' ou nao especifica -> vazio (envio imediato).",
  "due_date_iso": "data e hora do PRAZO FINAL da tarefa (quando a pessoa deve ter CONCLUIDO). Pode ser diferente do scheduled_send_iso. Se nao ha prazo, vazio.",
  "recurrence": "none/daily/weekly/monthly/weekdays",
  "recurrence_interval": 1,
  "nudge": true,
  "instruction": "instrucao de COMO a GIA deve agir - ex: 'seja firme', 'apenas envie sem pedir resposta', 'cobre normalmente'",
  "proposed_message": "a mensagem EXATA que a GIA deve enviar para o destinatario, escrita de forma natural como se fosse a assistente do gestor falando com a pessoa/grupo. SEMPRE inclua no final da mensagem a instrucao de conclusao no formato: 'Ao concluir, responda: ATOM-XXXX concluido'. Use ATOM-XXXX como placeholder (sera substituido pelo codigo real). A menos que o gestor diga explicitamente para NAO pedir resposta."
}

REGRAS CRITICAS - DESTINO (PARA ONDE ENVIAR):
- O campo "assignee" e o DESTINO da mensagem: para ONDE a mensagem sera enviada
- Se o gestor diz "envia NO GRUPO X" ou "manda no grupo X" -> assignee = nome do grupo, is_group = true
- Se o gestor diz "envia pro fulano" ou "manda pra fulano" -> assignee = nome da pessoa, is_group = false
- MUITO IMPORTANTE: Diferencie o DESTINO (onde enviar) do ASSUNTO (sobre quem/o que e a mensagem)
- Exemplo: "envia no grupo Financeiro o lembrete de pix para Ronaldo" -> assignee = "Financeiro" (destino), is_group = true (a mensagem FALA sobre Ronaldo mas o DESTINO e o grupo)
- Exemplo: "envia pro Ronaldo pedindo o pix" -> assignee = "Ronaldo" (destino), is_group = false

REGRAS CRITICAS - HORARIO DE ENVIO vs PRAZO FINAL:
- "scheduled_send_iso" = QUANDO a mensagem sera DISPARADA (horario do envio)
- "due_date_iso" = PRAZO FINAL para a tarefa ser concluida (para cobranca)
- ESSES DOIS CAMPOS SAO INDEPENDENTES. Podem ter valores diferentes!
- Exemplo: "envia amanha 08:30, prazo final 15hrs" -> scheduled_send_iso=amanha 08:30, due_date_iso=amanha 15:00
- Exemplo: "envia agora pedindo pro Diego, prazo amanha 14h" -> scheduled_send_iso=vazio (agora), due_date_iso=amanha 14:00
- Exemplo: "envia segunda as 9h" (sem prazo) -> scheduled_send_iso=segunda 09:00, due_date_iso=vazio
- Se o gestor diz "envia amanha as X" SEM mencionar prazo separado, entao scheduled_send_iso=amanha X e due_date_iso=vazio (pois nao mencionou prazo)
- Se o gestor menciona APENAS "prazo amanha 15h" sem horario de envio -> scheduled_send_iso=vazio (enviar agora), due_date_iso=amanha 15:00
- nudge=true significa que APOS o prazo (due_date_iso), a GIA vai cobrar resposta de 4 em 4 horas

REGRAS GERAIS:
- Se o gestor quer ENVIAR uma mensagem (perguntar algo, pedir algo, avisar), o proposed_message deve ser essa mensagem escrita de forma profissional e cordial
- Se o gestor quer COBRAR algo, nudge=true e a instrucao deve refletir o tom (firme, educado, etc)
- O proposed_message deve ser escrito na primeira pessoa como a GIA (Ex: "Ola! Aqui e a GIA, Executive Advisor do Sr. ${ownerName}. Ele gostaria de saber...")
- SEMPRE inclua no final da proposed_message a instrucao: "Ao concluir, responda: ATOM-XXXX concluido" (o placeholder ATOM-XXXX sera substituido pelo codigo real automaticamente). A menos que o gestor explicitamente diga para nao pedir resposta/status
- Se nao ha destinatario claro, deixe assignee vazio
- Se o gestor menciona dia da semana (ex: "na segunda-feira"), calcule a data ISO correta a partir de hoje ${todayISO}
- Se o gestor menciona horario (ex: "08:30hr"), inclua no campo correto (scheduled_send_iso ou due_date_iso conforme contexto)
- Se o gestor quer enviar para VARIOS contatos/pessoas, liste em "assignees"
- Se e uma tarefa recorrente (ex: "toda segunda", "todo dia"), defina recurrence adequadamente
- Se o gestor da instrucoes especificas de como enviar, coloque em instruction`;

          try {
            const parseRes = await fetch("https://api.openai.com/v1/chat/completions", {
              method: "POST",
              headers: { "Content-Type": "application/json", Authorization: `Bearer ${openaiKeyNL}` },
              body: JSON.stringify({
                model: openaiModelNL,
                temperature: 0.3,
                messages: [
                  { role: "system", content: `Voce extrai informacoes de comandos em linguagem natural. Responda SOMENTE com JSON valido.\n\n${sNL["ai_system_prompt"] ? "INSTRUCOES DE ESTILO PARA proposed_message (siga ao escrever a mensagem):\n" + sNL["ai_system_prompt"] : ""}` },
                  { role: "user", content: parsePrompt },
                ],
              }),
            });

            if (parseRes.ok) {
              const parseData = await parseRes.json();
              const rawContent = String(parseData?.choices?.[0]?.message?.content ?? "").trim();
              const jsonStr = rawContent.replace(/^```(?:json)?\s*/i, "").replace(/\s*```$/, "");
              const parsed = JSON.parse(jsonStr);

              const title = String(parsed.title || "").slice(0, 200) || "Tarefa sem título";
              const description = String(parsed.description || "");
              const assigneeRaw = String(parsed.assignee || "").trim();
              const assigneesRaw: string[] = Array.isArray(parsed.assignees) ? parsed.assignees.filter((a: unknown) => typeof a === "string" && a.trim()) : [];
              const targetIsGroup = parsed.is_group === true || parsed.is_group === "true";
              const priority = /alta|high|urgente/.test(String(parsed.priority || "")) ? "high" : /baixa|low/.test(String(parsed.priority || "")) ? "low" : "medium";
              const instruction = String(parsed.instruction || "");
              const proposedMessage = String(parsed.proposed_message || "");
              const shouldNudge = parsed.nudge !== false && parsed.nudge !== "false";
              const recurrenceRaw = String(parsed.recurrence || "none").toLowerCase();
              const recurrence = /daily|diari/.test(recurrenceRaw) ? "daily" : /weekly|seman/.test(recurrenceRaw) ? "weekly" : /monthly|mens/.test(recurrenceRaw) ? "monthly" : /weekdays|[uú]te/.test(recurrenceRaw) ? "weekdays" : "none";
              const recurrenceInterval = Math.max(1, Number(parsed.recurrence_interval) || 1);

              // Parse scheduled_send_iso (when to SEND the message)
              let scheduledSendNL: string | null = null;
              const scheduledSendIso = String(parsed.scheduled_send_iso || "").trim();
              if (scheduledSendIso) {
                try {
                  const d = new Date(scheduledSendIso);
                  if (!isNaN(d.getTime())) {
                    const utcMs = d.getTime() + 3 * 60 * 60 * 1000;
                    scheduledSendNL = new Date(utcMs).toISOString();
                  }
                } catch { /* ignore bad dates */ }
              }
              const sendNowNL = !scheduledSendNL;

              // Parse due_date from ISO output (DEADLINE for the task)
              let dueDateNL: string | null = null;
              const dueDateIso = String(parsed.due_date_iso || "").trim();
              if (dueDateIso) {
                try {
                  const d = new Date(dueDateIso);
                  if (!isNaN(d.getTime())) {
                    const utcMs = d.getTime() + 3 * 60 * 60 * 1000;
                    dueDateNL = new Date(utcMs).toISOString();
                  }
                } catch { /* ignore bad dates */ }
              }

              // Calculate first_nudge_at based on due_date (nudge starts after deadline)
              let firstNudgeNL: string | null = dueDateNL;
              const defaultRepeatHoursNL = Number(sNL["default_repeat_hours"] || "4") || 4;
              if (!firstNudgeNL && shouldNudge) {
                firstNudgeNL = new Date(Date.now() + 60 * 60 * 1000).toISOString();
              }

              // Resolve assignee
              let assigneeName = sNL["owner_name"] || "Eu";
              let assigneePhone = normalizePhone(ownerPhoneNL);
              let groupName = "";

              if (assigneeRaw) {
                // Search in contacts - filter by is_group when GPT identified a group target
                let contactQuery = supabase
                  .from("contacts")
                  .select("id, name, phone, country_code, is_group, remote_jid")
                  .eq("active", true)
                  .ilike("name", `%${assigneeRaw}%`);
                if (targetIsGroup) contactQuery = contactQuery.eq("is_group", true);
                const { data: byName } = await contactQuery.limit(10);

                // If targeting a group and found groups, filter to only groups
                let filteredResults = byName ?? [];
                if (targetIsGroup && filteredResults.length === 0) {
                  // No groups found in contacts with that name, search WhatsApp directly for groups
                  const whatsappCandidates = await searchWhatsAppChats(sNL, assigneeRaw);
                  const groupCandidates = whatsappCandidates.filter(c => c.is_group);
                  if (groupCandidates.length === 1) {
                    const chosen = groupCandidates[0];
                    assigneeName = chosen.name;
                    assigneePhone = chosen.remote_jid;
                    groupName = chosen.name;

                    const { data: existing } = await supabase
                      .from("contacts")
                      .select("id")
                      .eq("remote_jid", chosen.remote_jid)
                      .maybeSingle();
                    if (!existing) {
                      await supabase.from("contacts").insert({
                        name: chosen.name, phone: chosen.remote_jid,
                        country_code: "+55", department: "Grupo",
                        is_group: true, remote_jid: chosen.remote_jid, active: true,
                      });
                    }
                  } else if (groupCandidates.length > 1) {
                    const confirmationNeeded = await askConfirmation(
                      supabase, sNL, remoteJid, assigneeRaw, groupCandidates,
                      { title, description, priority, due_date: dueDateNL, recurrence, recurrence_interval: recurrenceInterval, first_nudge_at: firstNudgeNL, nudge_repeat_hours: shouldNudge ? defaultRepeatHoursNL : 0, nudge_active: shouldNudge, gia_instruction: instruction, proposed_message: proposedMessage, group_name: groupName, is_nl_command: true, send_now: sendNowNL, scheduled_send: scheduledSendNL }
                    );
                    if (confirmationNeeded) {
                      await logEvent("gia-nl-awaiting-confirmation", `group="${assigneeRaw}"`);
                      return new Response(
                        JSON.stringify({ awaiting_confirmation: true, assignee: assigneeRaw }),
                        { headers: { ...corsHeaders, "Content-Type": "application/json" } }
                      );
                    }
                  } else {
                    // No groups found at all, try full WhatsApp search
                    const allCandidates = whatsappCandidates.length > 0 ? whatsappCandidates : await searchWhatsAppChats(sNL, assigneeRaw);
                    if (allCandidates.length > 0) {
                      const confirmationNeeded = await askConfirmation(
                        supabase, sNL, remoteJid, assigneeRaw, allCandidates,
                        { title, description, priority, due_date: dueDateNL, recurrence, recurrence_interval: recurrenceInterval, first_nudge_at: firstNudgeNL, nudge_repeat_hours: shouldNudge ? defaultRepeatHoursNL : 0, nudge_active: shouldNudge, gia_instruction: instruction, proposed_message: proposedMessage, group_name: groupName, is_nl_command: true, send_now: sendNowNL, scheduled_send: scheduledSendNL }
                      );
                      if (confirmationNeeded) {
                        await logEvent("gia-nl-awaiting-confirmation", `group="${assigneeRaw}" whatsapp`);
                        return new Response(
                          JSON.stringify({ awaiting_confirmation: true, assignee: assigneeRaw }),
                          { headers: { ...corsHeaders, "Content-Type": "application/json" } }
                        );
                      }
                    } else {
                      const apiUrlNotFound = sNL["evolution_api_url"]?.replace(/\/$/, "");
                      const apiKeyNotFound = sNL["evolution_api_key"];
                      const instanceNotFound = sNL["evolution_instance_name"];
                      if (apiUrlNotFound && apiKeyNotFound && instanceNotFound) {
                        const numberOwner = remoteJid.endsWith("@g.us") ? remoteJid : normalizePhone(remoteJid.split("@")[0]);
                        await fetch(`${apiUrlNotFound}/message/sendText/${instanceNotFound}`, {
                          method: "POST",
                          headers: { "Content-Type": "application/json", apikey: apiKeyNotFound },
                          body: JSON.stringify({ number: numberOwner, text: `Nao encontrei o grupo "${assigneeRaw}" nos seus contatos nem no WhatsApp.` }),
                        });
                      }
                      await logEvent("gia-nl-group-not-found", `group="${assigneeRaw}"`);
                      return new Response(
                        JSON.stringify({ error: "group_not_found", assignee: assigneeRaw }),
                        { headers: { ...corsHeaders, "Content-Type": "application/json" } }
                      );
                    }
                  }
                } else if (filteredResults.length === 1) {
                  const c = filteredResults[0];
                  assigneeName = c.name;
                  assigneePhone = c.remote_jid ? (c.is_group ? String(c.remote_jid) : normalizePhone(String(c.remote_jid).split("@")[0])) : normalizePhone(String(c.phone ?? ""));
                  if (c.is_group) groupName = c.name;
                } else if (filteredResults.length > 1) {
                  const exact = filteredResults.find((c) => c.name.toLowerCase() === assigneeRaw.toLowerCase());
                  if (exact) {
                    assigneeName = exact.name;
                    assigneePhone = exact.remote_jid ? (exact.is_group ? String(exact.remote_jid) : normalizePhone(String(exact.remote_jid).split("@")[0])) : normalizePhone(String(exact.phone ?? ""));
                    if (exact.is_group) groupName = exact.name;
                  } else {
                    // Multiple candidates - ask confirmation
                    const candidates = filteredResults.map((c) => ({
                      remote_jid: c.remote_jid ?? "",
                      name: c.name,
                      phone: c.phone ?? "",
                      is_group: c.is_group ?? false,
                    }));
                    const confirmationNeeded = await askConfirmation(
                      supabase, sNL, remoteJid, assigneeRaw, candidates,
                      { title, description, priority, due_date: dueDateNL, recurrence, recurrence_interval: recurrenceInterval, first_nudge_at: firstNudgeNL, nudge_repeat_hours: shouldNudge ? defaultRepeatHoursNL : 0, nudge_active: shouldNudge, gia_instruction: instruction, proposed_message: proposedMessage, group_name: groupName, is_nl_command: true, send_now: sendNowNL, scheduled_send: scheduledSendNL }
                    );
                    if (confirmationNeeded) {
                      await logEvent("gia-nl-awaiting-confirmation", `assignee="${assigneeRaw}"`);
                      return new Response(
                        JSON.stringify({ awaiting_confirmation: true, assignee: assigneeRaw }),
                        { headers: { ...corsHeaders, "Content-Type": "application/json" } }
                      );
                    }
                  }
                } else {
                  // Not found in contacts - search WhatsApp
                  const whatsappCandidates = await searchWhatsAppChats(sNL, assigneeRaw);
                  if (whatsappCandidates.length > 0) {
                    const confirmationNeeded = await askConfirmation(
                      supabase, sNL, remoteJid, assigneeRaw, whatsappCandidates,
                      { title, description, priority, due_date: dueDateNL, recurrence, recurrence_interval: recurrenceInterval, first_nudge_at: firstNudgeNL, nudge_repeat_hours: shouldNudge ? defaultRepeatHoursNL : 0, nudge_active: shouldNudge, gia_instruction: instruction, proposed_message: proposedMessage, group_name: groupName, is_nl_command: true, send_now: sendNowNL, scheduled_send: scheduledSendNL }
                    );
                    if (confirmationNeeded) {
                      await logEvent("gia-nl-awaiting-confirmation", `assignee="${assigneeRaw}" whatsapp`);
                      return new Response(
                        JSON.stringify({ awaiting_confirmation: true, assignee: assigneeRaw }),
                        { headers: { ...corsHeaders, "Content-Type": "application/json" } }
                      );
                    }
                  } else {
                    // Nobody found
                    const apiUrlNotFound = sNL["evolution_api_url"]?.replace(/\/$/, "");
                    const apiKeyNotFound = sNL["evolution_api_key"];
                    const instanceNotFound = sNL["evolution_instance_name"];
                    if (apiUrlNotFound && apiKeyNotFound && instanceNotFound) {
                      const numberOwner = remoteJid.endsWith("@g.us") ? remoteJid : normalizePhone(remoteJid.split("@")[0]);
                      await fetch(`${apiUrlNotFound}/message/sendText/${instanceNotFound}`, {
                        method: "POST",
                        headers: { "Content-Type": "application/json", apikey: apiKeyNotFound },
                        body: JSON.stringify({ number: numberOwner, text: `Nao encontrei o contato "${assigneeRaw}" nos seus contatos nem no WhatsApp. Tente com o nome exato ou numero.` }),
                      });
                    }
                    await logEvent("gia-nl-contact-not-found", `assignee="${assigneeRaw}"`);
                    return new Response(
                      JSON.stringify({ error: "contact_not_found", assignee: assigneeRaw }),
                      { headers: { ...corsHeaders, "Content-Type": "application/json" } }
                    );
                  }
                }
              }

              // If we got here, assignee is resolved. Create approval request.
              if (proposedMessage && assigneeName !== (sNL["owner_name"] || "Eu")) {
                const taskDraft = {
                  title, description, priority, recurrence, recurrence_interval: recurrenceInterval,
                  due_date: dueDateNL, first_nudge_at: firstNudgeNL,
                  nudge_repeat_hours: shouldNudge ? defaultRepeatHoursNL : 0,
                  nudge_active: shouldNudge,
                  gia_instruction: instruction,
                  group_name: groupName,
                  send_now: sendNowNL,
                  scheduled_send: scheduledSendNL,
                };

                await supabase.from("pending_message_approvals").insert({
                  owner_jid: remoteJid,
                  task_draft: taskDraft,
                  proposed_message: proposedMessage,
                  assignee_name: assigneeName,
                  assignee_phone: assigneePhone,
                  status: "pending",
                });

                // Ask owner for approval
                const apiUrlNL = sNL["evolution_api_url"]?.replace(/\/$/, "");
                const apiKeyNL = sNL["evolution_api_key"];
                const instanceNL = sNL["evolution_instance_name"];
                if (apiUrlNL && apiKeyNL && instanceNL) {
                  const numberOwner = remoteJid.endsWith("@g.us") ? remoteJid : normalizePhone(remoteJid.split("@")[0]);
                  const fmtDateNL = (iso: string | null) => {
                    if (!iso) return "";
                    const dt = new Date(iso);
                    const br = new Date(dt.getTime() - 3 * 60 * 60 * 1000);
                    const dd = String(br.getUTCDate()).padStart(2, "0");
                    const mm = String(br.getUTCMonth() + 1).padStart(2, "0");
                    const hh = String(br.getUTCHours()).padStart(2, "0");
                    const mi = String(br.getUTCMinutes()).padStart(2, "0");
                    const days = ["dom", "seg", "ter", "qua", "qui", "sex", "sab"];
                    return `${days[br.getUTCDay()]} ${dd}/${mm} ${hh}:${mi}`;
                  };
                  const sendTimeInfo = sendNowNL ? `\nEnvio: AGORA` : `\nEnvio agendado: ${fmtDateNL(scheduledSendNL)}`;
                  const deadlineInfo = dueDateNL ? `\nPrazo final: ${fmtDateNL(dueDateNL)}` : "";
                  const nudgeInfo = shouldNudge && dueDateNL ? `\nCobranca apos prazo: a cada ${defaultRepeatHoursNL}h` : "";
                  const recurrenceInfo = recurrence !== "none" ? `\nRecorrencia: ${recurrence}${recurrenceInterval > 1 ? ` x${recurrenceInterval}` : ""}` : "";
                  const approvalMsg =
                    `Entendi! Vou enviar para *${assigneeName}*:\n\n` +
                    `---\n${proposedMessage}\n---\n\n` +
                    (shouldNudge ? `Cobranca ativa: vou acompanhar e cobrar respostas.\n` : `Sem cobranca: apenas envio sem cobrar resposta.\n`) +
                    sendTimeInfo + deadlineInfo + nudgeInfo + recurrenceInfo +
                    `\n\nPosso mandar? Responda *ok* para aprovar ou *nao* para cancelar.`;
                  await fetch(`${apiUrlNL}/message/sendText/${instanceNL}`, {
                    method: "POST",
                    headers: { "Content-Type": "application/json", apikey: apiKeyNL },
                    body: JSON.stringify({ number: numberOwner, text: approvalMsg }),
                  });
                }

                await logEvent("gia-nl-awaiting-approval", `to=${assigneeName}`);
                return new Response(
                  JSON.stringify({ awaiting_approval: true, assignee: assigneeName }),
                  { headers: { ...corsHeaders, "Content-Type": "application/json" } }
                );
              }
            }
          } catch (e) {
            await logEvent("gia-nl-parse-error", e instanceof Error ? e.message : String(e));
          }
        }
      }
    }

    // Conversational fallback: owner sends a message that didn't match any specific handler
    if (fromMe && remoteJid && text && eventName !== "send.message") {
      const { data: settingsChat } = await supabase.from("app_settings").select("key, value");
      const sChat: Record<string, string> = {};
      for (const row of settingsChat ?? []) sChat[row.key] = row.value;
      const ownerPhoneChat = sChat["owner_phone"] ?? "";
      const incomingChat = remoteJid.split("@")[0];
      const isOwnerChat = ownerPhoneChat && phonesMatch(ownerPhoneChat, incomingChat);

      if (isOwnerChat) {
        const openaiKeyChat = sChat["openai_api_key"] ?? "";
        const openaiModelChat = sChat["openai_model"] || "gpt-4o-mini";
        const apiUrlChat = sChat["evolution_api_url"]?.replace(/\/$/, "");
        const apiKeyChat = sChat["evolution_api_key"];
        const instanceChat = sChat["evolution_instance_name"];
        const systemPromptChat = sChat["ai_system_prompt"] ?? "";
        const rawOwnerChat = sChat["owner_name"] ?? "";
        const ownerNameChat = (rawOwnerChat && rawOwnerChat.toLowerCase() !== "eu") ? rawOwnerChat : "Marco Abdo";

        if (openaiKeyChat && apiUrlChat && apiKeyChat && instanceChat) {
          // Get recent tasks for context
          const { data: recentTasks } = await supabase
            .from("tasks")
            .select("id, task_code, title, assignee_name, status, due_date, gia_instruction")
            .order("created_at", { ascending: false })
            .limit(20);

          // Get pending approvals for context
          const { data: pendingApprovals } = await supabase
            .from("pending_message_approvals")
            .select("id, assignee_name, proposed_message, status, created_at")
            .eq("status", "pending")
            .order("created_at", { ascending: false })
            .limit(5);

          const nowBRChat = new Date(Date.now() - 3 * 60 * 60 * 1000);
          const todayISOChat = nowBRChat.toISOString().slice(0, 10);
          const dayNamesChat = ["domingo", "segunda-feira", "terca-feira", "quarta-feira", "quinta-feira", "sexta-feira", "sabado"];
          const todayDayNameChat = dayNamesChat[nowBRChat.getUTCDay()];

          const tasksContext = (recentTasks ?? []).map(t =>
            `- [${t.task_code ?? "?"}] "${t.title}" → ${t.assignee_name} | status: ${t.status} | prazo: ${t.due_date ?? "sem"} | instrucao: ${t.gia_instruction ?? ""}`
          ).join("\n");

          const pendingContext = (pendingApprovals ?? []).length > 0
            ? "\n\nAPROVACOES PENDENTES:\n" + pendingApprovals!.map(a => `- Para ${a.assignee_name}: "${(a.proposed_message ?? "").slice(0, 60)}..."`).join("\n")
            : "";

          const chatPrompt = `${systemPromptChat}

Voce e a GIA, Executive Advisor do Sr. ${ownerNameChat}. O gestor (${ownerNameChat}) esta falando DIRETAMENTE com voce via WhatsApp. Responda de forma natural, inteligente e util.

HOJE: ${todayISOChat} (${todayDayNameChat})
HORA ATUAL (Brasilia): ${nowBRChat.toISOString().slice(11, 16)}

TAREFAS RECENTES:
${tasksContext || "(nenhuma tarefa)"}${pendingContext}

CAPACIDADES:
- Voce gerencia tarefas, agendamentos e cobranças
- Se o gestor pedir para alterar algo (ex: "ATOM-1017 altere o envio para AGORA"), voce deve confirmar e executar
- Se o gestor perguntar algo, responda com base no contexto das tarefas
- Seja sempre concisa e direta, sem enrolacao
- SIGA RIGOROSAMENTE as instrucoes do system prompt acima (emojis, tom, formato, etc)
- Se voce nao pode executar uma acao diretamente, explique o que vai fazer

ACAO ESPECIAL - ALTERAR AGENDAMENTO:
Se o gestor pedir para alterar o horario de envio de uma tarefa (ex: "ATOM-1017 envie agora", "mude o prazo da ATOM-X para amanha"):
- Responda com JSON no formato: {"action": "reschedule", "task_code": "ATOM-XXXX", "new_due_date": "ISO8601", "send_now": true/false}
- Se "agora"/"imediatamente" → send_now=true
- APOS o JSON, adicione a mensagem de confirmacao separada por |||

Se nao e uma acao especial, apenas responda normalmente como assistente.`;

          try {
            const aiResChat = await fetch("https://api.openai.com/v1/chat/completions", {
              method: "POST",
              headers: { "Content-Type": "application/json", Authorization: `Bearer ${openaiKeyChat}` },
              body: JSON.stringify({
                model: openaiModelChat,
                temperature: 0.5,
                messages: [
                  { role: "system", content: chatPrompt },
                  { role: "user", content: text },
                ],
              }),
            });

            if (aiResChat.ok) {
              const jChat = await aiResChat.json();
              let reply = String(jChat?.choices?.[0]?.message?.content ?? "").trim();

              // Check if the response contains a reschedule action
              const jsonActionMatch = /^\s*\{[\s\S]*?"action"\s*:\s*"reschedule"[\s\S]*?\}/.exec(reply);
              if (jsonActionMatch) {
                try {
                  const actionData = JSON.parse(jsonActionMatch[0]);
                  const taskCode = actionData.task_code;
                  const sendNow = actionData.send_now === true;

                  // Find the task
                  const { data: targetTask } = await supabase
                    .from("tasks")
                    .select("*")
                    .eq("task_code", taskCode)
                    .maybeSingle();

                  if (targetTask) {
                    if (sendNow) {
                      // Check if there's an exact message stored
                      const exactMatch = /^ENVIAR_MENSAGEM_EXATA:\s*([\s\S]+)$/i.exec(targetTask.gia_instruction ?? "");
                      if (exactMatch) {
                        const msgToSend = exactMatch[1].trim();
                        const isGroupSend = String(targetTask.assignee_phone).includes("@g.us");
                        let numberSend = isGroupSend ? targetTask.assignee_phone : normalizePhone(String(targetTask.assignee_phone));
                        if (!isGroupSend && numberSend.length <= 11) numberSend = "55" + numberSend;

                        await fetch(`${apiUrlChat}/message/sendText/${instanceChat}`, {
                          method: "POST",
                          headers: { "Content-Type": "application/json", apikey: apiKeyChat },
                          body: JSON.stringify({ number: numberSend, text: msgToSend }),
                        });

                        await supabase.from("send_logs").insert({
                          task_id: targetTask.id,
                          contact_name: targetTask.assignee_name,
                          contact_phone: targetTask.assignee_phone,
                          template_name: "Mensagem antecipada (GIA NL)",
                          message_content: msgToSend,
                          status: "sent",
                          sent_at: new Date().toISOString(),
                        });

                        // Update task: clear the scheduled instruction, update nudge
                        await supabase.from("tasks").update({
                          due_date: new Date().toISOString(),
                          first_nudge_at: null,
                          nudge_active: false,
                          gia_instruction: "",
                          last_ai_nudge: new Date().toISOString(),
                          ai_interventions: (targetTask.ai_interventions ?? 0) + 1,
                        }).eq("id", targetTask.id);

                        reply = reply.includes("|||") ? reply.split("|||").pop()!.trim() : `Pronto! Mensagem enviada agora para *${targetTask.assignee_name}* (${taskCode}).`;
                      } else {
                        // No exact message, trigger the nudge function
                        const supabaseUrl = Deno.env.get("SUPABASE_URL")!;
                        const serviceKey = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!;
                        await fetch(`${supabaseUrl}/functions/v1/send-task-nudge`, {
                          method: "POST",
                          headers: { "Content-Type": "application/json", Authorization: `Bearer ${serviceKey}` },
                          body: JSON.stringify({ task_id: targetTask.id }),
                        });

                        await supabase.from("tasks").update({
                          due_date: new Date().toISOString(),
                          first_nudge_at: null,
                          nudge_active: false,
                        }).eq("id", targetTask.id);

                        reply = reply.includes("|||") ? reply.split("|||").pop()!.trim() : `Pronto! Cobranca enviada agora para *${targetTask.assignee_name}* (${taskCode}).`;
                      }
                    } else {
                      // Reschedule to a new date
                      const newDue = actionData.new_due_date;
                      await supabase.from("tasks").update({
                        due_date: newDue,
                        first_nudge_at: newDue,
                      }).eq("id", targetTask.id);
                      reply = reply.includes("|||") ? reply.split("|||").pop()!.trim() : `Reagendado ${taskCode} para ${newDue}.`;
                    }
                  } else {
                    reply = reply.includes("|||") ? reply.split("|||").pop()!.trim() : `Nao encontrei a tarefa ${taskCode}. Verifique o codigo.`;
                  }
                } catch { /* JSON parse failed, just send the reply as-is */ }
              }

              if (reply) {
                const numberReply = remoteJid.endsWith("@g.us") ? remoteJid : normalizePhone(remoteJid.split("@")[0]);
                await fetch(`${apiUrlChat}/message/sendText/${instanceChat}`, {
                  method: "POST",
                  headers: { "Content-Type": "application/json", apikey: apiKeyChat },
                  body: JSON.stringify({ number: numberReply, text: reply }),
                });
                // Anti-loop: record timestamp so the webhook ignores the echo
                await supabase.from("app_settings").upsert({ key: "_gia_last_chat_reply_ts", value: String(Date.now()) }, { onConflict: "key" });
              }
            }

            await logEvent("gia-chat-reply", text.slice(0, 60));
            return new Response(
              JSON.stringify({ chat_reply: true }),
              { headers: { ...corsHeaders, "Content-Type": "application/json" } }
            );
          } catch (e) {
            await logEvent("gia-chat-error", e instanceof Error ? e.message : String(e));
          }
        }
      }
    }

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

    // Only process if: (1) message is exactly 1/2/3, (2) has task code, or (3) has gia_instruction and was nudged recently
    const giaInstr = String(match.gia_instruction ?? "").trim();
    let intent: Intent = classify(text);
    const lastNudge = match.last_ai_nudge ? new Date(String(match.last_ai_nudge)).getTime() : 0;
    const nudgedRecently = Date.now() - lastNudge < 48 * 60 * 60 * 1000; // 48h window

    // If intent is unknown and no task code was explicitly referenced, ignore (don't interfere with casual chat)
    if (intent === "unknown" && !code && !giaInstr) {
      await logEvent("ignored-casual-chat", `from=${match.assignee_name} text="${text.slice(0, 40)}"`);
      return new Response(JSON.stringify({ matched: false, reason: "casual_chat" }), {
        headers: { ...corsHeaders, "Content-Type": "application/json" },
      });
    }

    // If intent is unknown, no task code, has gia_instruction but wasn't nudged recently, also ignore
    if (intent === "unknown" && !code && !nudgedRecently) {
      await logEvent("ignored-no-recent-nudge", `from=${match.assignee_name}`);
      return new Response(JSON.stringify({ matched: false, reason: "no_recent_nudge" }), {
        headers: { ...corsHeaders, "Content-Type": "application/json" },
      });
    }

    const updates: Record<string, unknown> = {};
    const recurrence = String(match.recurrence ?? "none");
    const recurrenceInterval = Number(match.recurrence_interval ?? 1);
    let recurred = false;
    let aiInterpretation = "";

    // If gia_instruction exists and classify returns unknown, use GPT to interpret
    if (giaInstr && intent === "unknown" && nudgedRecently) {
      const openaiKeyInt = settings["openai_api_key"] ?? "";
      const openaiModelInt = settings["openai_model"] || "gpt-4o-mini";
      if (openaiKeyInt) {
        try {
          const interpretPrompt =
            `Voce e a GIA, assistente executiva. Uma tarefa foi enviada com a seguinte instrucao especial:\n` +
            `INSTRUCAO: "${giaInstr}"\n\n` +
            `TAREFA: "${match.title}"\n` +
            `DESCRICAO: "${match.description || ""}"\n` +
            `DESTINATARIO: "${match.assignee_name}"\n\n` +
            `O destinatario respondeu:\n"${text}"\n\n` +
            `Com base na instrucao e na resposta, responda APENAS com JSON:\n` +
            `{\n` +
            `  "status": "completed" ou "in_progress" ou "pending" ou "unknown",\n` +
            `  "reason": "explicacao curta do porque voce decidiu esse status",\n` +
            `  "reply_to_contact": "mensagem de resposta para enviar ao contato (curta, cordial)",\n` +
            `  "notify_owner": "resumo para enviar ao gestor sobre o que aconteceu"\n` +
            `}\n\n` +
            `REGRAS:\n` +
            `- Se a pessoa enviou informacao solicitada (PIX, dados, arquivo, etc) = completed\n` +
            `- Se a pessoa disse que vai fazer depois/amanha/mais tarde = in_progress\n` +
            `- Se a pessoa simplesmente respondeu/confirmou algo que era so envio = completed\n` +
            `- Se a resposta e ambigua e voce nao tem certeza = unknown\n` +
            `- reply_to_contact deve ser natural e breve\n` +
            `- notify_owner deve ser um resumo util pro gestor`;
          const intRes = await fetch("https://api.openai.com/v1/chat/completions", {
            method: "POST",
            headers: { "Content-Type": "application/json", Authorization: `Bearer ${openaiKeyInt}` },
            body: JSON.stringify({
              model: openaiModelInt,
              temperature: 0.3,
              messages: [
                { role: "system", content: "Voce interpreta respostas de WhatsApp no contexto de tarefas. Responda SOMENTE com JSON valido." },
                { role: "user", content: interpretPrompt },
              ],
            }),
          });
          if (intRes.ok) {
            const intData = await intRes.json();
            const rawInt = String(intData?.choices?.[0]?.message?.content ?? "").trim();
            const jsonInt = rawInt.replace(/^```(?:json)?\s*/i, "").replace(/\s*```$/, "");
            const parsed = JSON.parse(jsonInt);
            const aiStatus = String(parsed.status || "unknown").toLowerCase();
            if (aiStatus === "completed") intent = "completed";
            else if (aiStatus === "in_progress") intent = "in_progress";
            else if (aiStatus === "pending") intent = "blocked";
            aiInterpretation = JSON.stringify(parsed);

            // Notify owner about the response
            if (parsed.notify_owner) {
              const apiUrlNotify = settings["evolution_api_url"]?.replace(/\/$/, "");
              const apiKeyNotify = settings["evolution_api_key"];
              const instanceNotify = settings["evolution_instance_name"];
              const ownerPhoneNotify = settings["owner_phone"] ?? "";
              if (apiUrlNotify && apiKeyNotify && instanceNotify && ownerPhoneNotify) {
                const ownerNumber = normalizePhone(ownerPhoneNotify);
                const code = match.task_code ? ` [${match.task_code}]` : "";
                const ownerMsg = `*Atualização${code}*\n${match.assignee_name} respondeu sobre "${match.title}":\n\n${parsed.notify_owner}`;
                await fetch(`${apiUrlNotify}/message/sendText/${instanceNotify}`, {
                  method: "POST",
                  headers: { "Content-Type": "application/json", apikey: apiKeyNotify },
                  body: JSON.stringify({ number: ownerNumber, text: ownerMsg }),
                });
              }
            }
          }
        } catch { /* fallback to simple classify */ }
      }
    }

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
        if (giaInstr) updates.nudge_active = false;
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
    if (autoReply && (intent !== "unknown" || giaInstr)) {
      const apiUrl = settings["evolution_api_url"]?.replace(/\/$/, "");
      const apiKey = settings["evolution_api_key"];
      const instanceName = settings["evolution_instance_name"];
      const openaiKey = settings["openai_api_key"] ?? "";
      const openaiModel = settings["openai_model"] || "gpt-4o-mini";
      const systemPrompt = settings["ai_system_prompt"] ?? "";
      if (apiUrl && apiKey && instanceName) {
        let replyText = replyFor(intent, String(match.assignee_name ?? ""), String(match.title ?? ""), String(match.task_code ?? ""));

        // If GPT already produced a reply from interpretation, use it
        if (aiInterpretation) {
          try {
            const aiParsed = JSON.parse(aiInterpretation);
            if (aiParsed.reply_to_contact) replyText = aiParsed.reply_to_contact;
          } catch { /* use fallback */ }
        }

        if (recurred) {
          const firstName = String(match.assignee_name ?? "").split(" ")[0] || "tudo bem";
          replyText = `Perfeito, ${firstName}! Registrei "${match.title}" como concluída. Como é uma tarefa recorrente, já reagendei para o próximo ciclo.`;
        }
        if (!aiInterpretation && openaiKey) {
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
