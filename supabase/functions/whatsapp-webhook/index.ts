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

function replyFor(intent: Intent, name: string, title: string, taskCode?: string, newDueIso?: string): string {
  const firstName = (name ?? "").split(" ")[0] || "tudo bem";
  const code = taskCode ?? "";
  switch (intent) {
    case "completed":
      return `Perfeito, ${firstName}! Registrei "${title}" como concluída. Obrigado pela atualização! ✅`;
    case "in_progress": {
      let duePart = "";
      if (newDueIso) {
        const d = new Date(new Date(newDueIso).getTime() - 3 * 60 * 60 * 1000);
        const dd = String(d.getUTCDate()).padStart(2, "0");
        const mm = String(d.getUTCMonth() + 1).padStart(2, "0");
        const hh = String(d.getUTCHours()).padStart(2, "0");
        const mi = String(d.getUTCMinutes()).padStart(2, "0");
        duePart = ` O novo prazo ficará para *${dd}/${mm} às ${hh}:${mi}*. Contamos com você! 💪`;
      }
      return `Obrigada pelo retorno, ${firstName}! 😊 Entendido que "${title}" ainda está em andamento.${duePart}\n\nQuando finalizar, responda: *${code} concluido*`;
    }
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
  const queryWords = queryLower.split(/\s+/).filter(w => w.length >= 2);

  const nameMatches = (name: string) => {
    const nl = name.toLowerCase();
    return nl.includes(queryLower) || queryWords.every(w => nl.includes(w));
  };

  // Try dedicated group fetch endpoints first (more complete for groups)
  let groups: Array<{ id?: string; remoteJid?: string; subject?: string; name?: string }> = [];
  const groupEndpoints = [
    `${apiUrl}/group/fetchAllGroups/${instance}?getParticipants=false`,
    `${apiUrl}/group/findGroups/${instance}`,
  ];
  for (const ep of groupEndpoints) {
    try {
      const r = await fetch(ep, { method: "GET", headers });
      if (r.ok) {
        const j = await r.json();
        groups = Array.isArray(j) ? j : (j.groups ?? j.data ?? []);
        if (groups.length) break;
      }
    } catch { /* try next */ }
  }

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

  // Groups from dedicated endpoint
  for (const g of groups) {
    const jid = g.id ?? g.remoteJid ?? "";
    if (!jid || seen.has(jid)) continue;
    const name = g.subject ?? g.name ?? "";
    if (!name || !nameMatches(name)) continue;
    seen.add(jid);
    candidates.push({ remote_jid: jid, name, phone: "", is_group: true });
  }

  for (const c of chats) {
    const jid = c.remoteJid ?? c.id ?? "";
    if (!jid || seen.has(jid) || jid.endsWith("@broadcast")) continue;
    const isGroup = jid.endsWith("@g.us");
    const name = c.subject ?? c.name ?? c.pushName ?? "";
    if (!name || !nameMatches(name)) continue;
    seen.add(jid);
    const phone = isGroup ? "" : jid.split("@")[0].replace(/\D/g, "");
    candidates.push({ remote_jid: jid, name, phone: isGroup ? "" : `+${phone}`, is_group: isGroup });
  }

  for (const c of contacts) {
    const jid = c.remoteJid ?? c.id ?? "";
    if (!jid || seen.has(jid) || jid.endsWith("@g.us") || jid.endsWith("@broadcast")) continue;
    const name = c.pushName ?? c.name ?? c.notify ?? "";
    if (!name || !nameMatches(name)) continue;
    seen.add(jid);
    const phone = jid.split("@")[0].replace(/\D/g, "");
    candidates.push({ remote_jid: jid, name, phone: `+${phone}`, is_group: false });
  }

  return candidates.slice(0, 20);
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

  // Cancel any previous pending confirmations for this owner before creating a new one
  await supabase.from("pending_task_confirmations")
    .update({ status: "expired", resolved_at: new Date().toISOString() })
    .eq("owner_jid", ownerJid)
    .eq("status", "pending");

  await supabase.from("pending_task_confirmations").insert({
    owner_jid: ownerJid,
    task_draft: { ...taskDraft, assignee_name_hint: searchTerm },
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
    `Responda com o número correspondente ou envie o telefone diretamente (ex: 34 91234-5678).`;

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
  const internalReinvoke: boolean = Boolean(payload?.internal_reinvoke);
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
  const mentionedJids: string[] =
    msg?.extendedTextMessage?.contextInfo?.mentionedJid ??
    msg?.contextInfo?.mentionedJid ??
    data?.contextInfo?.mentionedJid ??
    [];

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
    // Handle pending confirmation responses (owner replying with a number or a phone)
    // Also accept free-text replies that contain a phone number (e.g. "O telefone é 34 9123-4561")
    const confirmNum = /^\s*(\d+)\s*$/.exec(text);
    const confirmPhoneMatch = !confirmNum ? text.match(/(?:^|[\s\-])(\d{2}[\s\-]?\d{4,5}[\s\-]?\d{4})(?:\s|$)/) : null;
    const confirmPhone = confirmPhoneMatch ? confirmPhoneMatch[1].replace(/[\s\-]/g, "") : null;
    if ((confirmNum || confirmPhone) && remoteJid) {
      const { data: pending } = await supabase
        .from("pending_task_confirmations")
        .select("*")
        .eq("owner_jid", remoteJid)
        .eq("status", "pending")
        .order("created_at", { ascending: false })
        .limit(1);

      if (pending && pending.length > 0) {
        const confirmation = pending[0];
        const choice = confirmNum ? Number(confirmNum[1]) : -1;
        const candidates = confirmation.candidates as Candidate[];
        const draft = confirmation.task_draft as Record<string, unknown>;

        const { data: settingsConf } = await supabase.from("app_settings").select("key, value");
        const sConf: Record<string, string> = {};
        for (const row of settingsConf ?? []) sConf[row.key] = row.value;

        let assigneeName = sConf["owner_name"] || "Eu";
        let assigneePhone = normalizePhone(sConf["owner_phone"] ?? "");
        let groupName = "";

        if (confirmPhone) {
          // User replied with a phone number directly — use it
          const normalized = confirmPhone.length <= 11 ? "55" + confirmPhone : confirmPhone;
          assigneePhone = normalized;
          // Try to find name from the draft's assignee field or contacts
          const draftAssignee = String((draft as Record<string, unknown>).assignee_name_hint ?? "");
          assigneeName = draftAssignee || candidates[0]?.name || "Contato";
          // Try to enrich name from contacts
          const { data: byPhoneConf } = await supabase
            .from("contacts")
            .select("name, phone, remote_jid")
            .or(`phone.ilike.%${confirmPhone}%,remote_jid.ilike.%${confirmPhone}%`)
            .limit(1)
            .maybeSingle();
          if (byPhoneConf) {
            assigneeName = byPhoneConf.name;
            assigneePhone = byPhoneConf.remote_jid ? normalizePhone(String(byPhoneConf.remote_jid).split("@")[0]) : normalizePhone(String(byPhoneConf.phone ?? ""));
          } else {
            // Save new contact from phone typed by user
            await supabase.from("contacts").insert({
              name: assigneeName,
              phone: normalized,
              country_code: "+55",
              department: "",
              is_group: false,
              remote_jid: `${normalized}@s.whatsapp.net`,
              active: true,
            });
          }
        } else if (choice >= 1 && choice <= candidates.length) {
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
          // Cancel stale pending approvals before creating a new one
          await supabase.from("pending_message_approvals")
            .update({ status: "expired", resolved_at: new Date().toISOString() })
            .eq("owner_jid", remoteJid)
            .eq("status", "pending");
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
    if (isGiaOwnMessage && fromMe && !internalReinvoke) {
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

          // Approved - handle re-nudge (existing task) or create new task
          const draft = approval.task_draft as Record<string, unknown>;

          // RE-NUDGE: just send the message, no new task
          if (draft.is_renudge === true) {
            if (apiUrlAppr && apiKeyAppr && instanceAppr && approval.proposed_message) {
              const isGroupRN = String(approval.assignee_phone).includes("@g.us");
              let numberDestRN = isGroupRN ? approval.assignee_phone : normalizePhone(approval.assignee_phone);
              if (!isGroupRN && numberDestRN.length <= 11) numberDestRN = "55" + numberDestRN;
              await fetch(`${apiUrlAppr}/message/sendText/${instanceAppr}`, {
                method: "POST",
                headers: { "Content-Type": "application/json", apikey: apiKeyAppr },
                body: JSON.stringify({ number: numberDestRN, text: approval.proposed_message }),
              });
              await supabase.from("send_logs").insert({
                contact_name: approval.assignee_name,
                contact_phone: approval.assignee_phone,
                template_name: "Re-cobranca (GIA)",
                message_content: approval.proposed_message,
                status: "sent",
                sent_at: new Date().toISOString(),
              });
            }
            // Update existing task nudge counter
            const existingTaskId = draft.existing_task_id ? String(draft.existing_task_id) : null;
            if (existingTaskId) {
              const { data: existingTask } = await supabase.from("tasks").select("ai_interventions").eq("id", existingTaskId).maybeSingle();
              await supabase.from("tasks").update({
                ai_interventions: ((existingTask?.ai_interventions as number) ?? 0) + 1,
                last_ai_nudge: new Date().toISOString(),
                status: "awaiting_response",
              }).eq("id", existingTaskId);
            }
            await supabase.from("pending_message_approvals").update({ status: "approved", resolved_at: new Date().toISOString(), task_id: existingTaskId }).eq("id", approval.id);
            if (apiUrlAppr && apiKeyAppr && instanceAppr) {
              const numberAppr = remoteJid.endsWith("@g.us") ? remoteJid : normalizePhone(remoteJid.split("@")[0]);
              await fetch(`${apiUrlAppr}/message/sendText/${instanceAppr}`, {
                method: "POST",
                headers: { "Content-Type": "application/json", apikey: apiKeyAppr },
                body: JSON.stringify({ number: numberAppr, text: `Cobranca enviada para *${approval.assignee_name}*. Estou acompanhando.` }),
              });
            }
            await logEvent("renudge-sent", `task=${existingTaskId} assignee="${approval.assignee_name}"`);
            return new Response(JSON.stringify({ renudge_sent: true, task_id: existingTaskId }), { headers: { ...corsHeaders, "Content-Type": "application/json" } });
          }

          const isMessageOnly = draft.message_only === true;
          const dueDate = draft.due_date ? String(draft.due_date) : null;
          const scheduledSend = draft.scheduled_send ? String(draft.scheduled_send) : null;
          // Schedule for later if there's a scheduled_send time in the future
          const isScheduledForLater = scheduledSend && new Date(scheduledSend).getTime() > Date.now() + 60000;
          // True when there is a real deadline separate from the send time
          const hasDeadlineSeparateFromSend = isScheduledForLater && dueDate && dueDate !== scheduledSend;

          // message_only: just send the message, no task creation
          if (isMessageOnly) {
            // If scheduled for later, defer to process-scheduled-sends cron
            if (isScheduledForLater) {
              await supabase.from("pending_message_approvals")
                .update({ status: "approved", resolved_at: new Date().toISOString(), scheduled_send_at: scheduledSend })
                .eq("id", approval.id);
              if (apiUrlAppr && apiKeyAppr && instanceAppr) {
                const numberAppr = remoteJid.endsWith("@g.us") ? remoteJid : normalizePhone(remoteJid.split("@")[0]);
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
                const scheduleMsg = `Agendado! Vou enviar para *${approval.assignee_name}* em ${fmtSched(scheduledSend!)}. Pode ficar tranquilo.`;
                await fetch(`${apiUrlAppr}/message/sendText/${instanceAppr}`, {
                  method: "POST",
                  headers: { "Content-Type": "application/json", apikey: apiKeyAppr },
                  body: JSON.stringify({ number: numberAppr, text: scheduleMsg }),
                });
              }
              await logEvent("message-only-scheduled", `to=${approval.assignee_name} send=${scheduledSend}`);
              return new Response(JSON.stringify({ scheduled: true, message_only: true, send_at: scheduledSend }), {
                headers: { ...corsHeaders, "Content-Type": "application/json" },
              });
            }

            // Send immediately
            if (apiUrlAppr && apiKeyAppr && instanceAppr && approval.proposed_message) {
              const isGroupMO = String(approval.assignee_phone).includes("@g.us");
              let numberMO = isGroupMO ? approval.assignee_phone : normalizePhone(approval.assignee_phone);
              if (!isGroupMO && numberMO.length <= 11) numberMO = "55" + numberMO;
              await fetch(`${apiUrlAppr}/message/sendText/${instanceAppr}`, {
                method: "POST",
                headers: { "Content-Type": "application/json", apikey: apiKeyAppr },
                body: JSON.stringify({ number: numberMO, text: approval.proposed_message }),
              });
              await supabase.from("send_logs").insert({
                contact_name: approval.assignee_name,
                contact_phone: approval.assignee_phone,
                template_name: "Mensagem direta (GIA NL)",
                message_content: approval.proposed_message,
                status: "sent",
                sent_at: new Date().toISOString(),
              });
            }
            await supabase.from("pending_message_approvals")
              .update({ status: "approved", resolved_at: new Date().toISOString() })
              .eq("id", approval.id);
            if (apiUrlAppr && apiKeyAppr && instanceAppr) {
              const numberAppr = remoteJid.endsWith("@g.us") ? remoteJid : normalizePhone(remoteJid.split("@")[0]);
              await fetch(`${apiUrlAppr}/message/sendText/${instanceAppr}`, {
                method: "POST",
                headers: { "Content-Type": "application/json", apikey: apiKeyAppr },
                body: JSON.stringify({ number: numberAppr, text: `Mensagem enviada para *${approval.assignee_name}*.` }),
              });
            }
            await logEvent("message-only-sent", `to=${approval.assignee_name}`);
            return new Response(JSON.stringify({ sent: true, message_only: true }), {
              headers: { ...corsHeaders, "Content-Type": "application/json" },
            });
          }

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
        let ownerIntent: "edit" | "cancel" | "approve" | "new_instruction" | "change_destination" | "make_message_only" = "edit";
        let newDestination = "";

        // Load contacts for destination change detection
        const { data: editContacts } = await supabase
          .from("contacts")
          .select("name, is_group, remote_jid, phone")
          .eq("active", true)
          .order("name");
        const editContactsList = (editContacts ?? []).map(c =>
          `- "${c.name}" (${c.is_group ? "GRUPO" : "PESSOA"})`
        ).join("\n");

        if (openaiKeyEdit) {
          try {
            const editPrompt = `Voce e a GIA, assistente executiva. O gestor tinha pedido para enviar esta mensagem para ${approval.assignee_name}:

MENSAGEM ORIGINAL:
"${approval.proposed_message}"

O gestor respondeu com:
"${text}"

CONTATOS E GRUPOS CADASTRADOS:
${editContactsList}

Analise a resposta do gestor e responda APENAS com JSON valido:
{
  "intent": "edit" ou "cancel" ou "approve" ou "change_destination" ou "make_message_only",
  "new_message": "a nova mensagem corrigida (se intent=edit ou make_message_only). Se o gestor forneceu o texto exato, use EXATAMENTE o que ele escreveu, SEM adicionar nada.",
  "new_destination": "nome EXATO do novo destino da lista de contatos (se intent=change_destination). Use o nome completo como aparece na lista. Se nao encontrar na lista, use o nome como o gestor escreveu.",
  "explanation": "explicacao curta do que o gestor quer"
}

REGRAS:
- Se o gestor diz que o DESTINO esta errado (ex: "nao, e pro grupo X", "manda pro Y", "nao, envia pra Z"), intent=change_destination e new_destination = nome EXATO do contato/grupo da lista acima. Faca fuzzy match com os nomes da lista. Se NAO encontrar correspondencia na lista, use o nome como o gestor escreveu.
- Se o gestor fornece uma versao corrigida da mensagem (ex: "Nao, envia assim: ...", "Nao, altere pra isso: ..."), intent=edit e new_message = o texto corrigido
- Se o gestor diz pra cancelar/nao enviar, intent=cancel
- Se o gestor aprova de alguma forma (ok, sim, manda, envia, pode mandar), intent=approve
- Se o gestor diz "so envia", "sem criar tarefa", "nao precisa criar tarefa", "so avisa", "mensagem so", "sem cobranca", "sem acompanhamento", intent=make_message_only. Se ele tambem corrigiu o texto, coloque o texto corrigido em new_message. Se nao corrigiu, deixe new_message vazio (vai usar a mensagem original).
- Se o gestor da uma instrucao generica de mudanca (ex: "seja mais firme", "tira a parte do seguro"), intent=edit e voce deve aplicar a mudanca na mensagem original
- REGRA MAIS IMPORTANTE: Se o gestor escreve a mensagem inteira de volta com correcoes, use EXATAMENTE o texto dele em new_message, caractere por caractere. NAO adicione opcoes 1/2/3, NAO adicione ATOM-XXXX, NAO adicione nada que o gestor nao escreveu. O texto do gestor e sagrado.
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
              newDestination = String(parsed.new_destination || "").trim();
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

        if (ownerIntent === "change_destination" && newDestination) {
          // Find the new contact/group by exact or fuzzy name match
          const destLower = newDestination.toLowerCase();
          const matchedContact = (editContacts ?? []).find(c => c.name.toLowerCase() === destLower)
            ?? (editContacts ?? []).find(c => c.name.toLowerCase().includes(destLower))
            ?? (editContacts ?? []).find(c => destLower.includes(c.name.toLowerCase()));

          if (matchedContact) {
            const newPhone = matchedContact.remote_jid
              ? (matchedContact.is_group ? String(matchedContact.remote_jid) : normalizePhone(String(matchedContact.remote_jid).split("@")[0]))
              : normalizePhone(String(matchedContact.phone ?? ""));
            const newName = matchedContact.name;

            // Update the approval with the new destination
            const draft = approval.task_draft as Record<string, unknown>;
            if (matchedContact.is_group) draft.group_name = newName;

            // Update proposed_message to reference the new destination name
            let updatedMsg = String(approval.proposed_message ?? "");
            const oldNameEsc = approval.assignee_name.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
            const nameRegex = new RegExp(oldNameEsc, "gi");
            if (nameRegex.test(updatedMsg)) {
              updatedMsg = updatedMsg.replace(nameRegex, newName);
            }

            await supabase
              .from("pending_message_approvals")
              .update({
                assignee_name: newName,
                assignee_phone: newPhone,
                proposed_message: updatedMsg,
                task_draft: draft,
              })
              .eq("id", approval.id);

            if (apiUrlEdit && apiKeyEdit && instanceEdit) {
              const numberEdit = remoteJid.endsWith("@g.us") ? remoteJid : normalizePhone(remoteJid.split("@")[0]);
              const shouldNudge = draft.nudge_active ?? false;
              const previewDest = updatedMsg.replace(/ATOM-XXXX/g, "(codigo gerado automaticamente)");
              const reAskMsg =
                `Entendi! Vou enviar para *${newName}*:\n\n` +
                `---\n${previewDest}\n---\n\n` +
                (shouldNudge ? `Cobranca ativa: vou acompanhar e cobrar respostas.\n` : `Sem cobranca: apenas envio sem cobrar resposta.\n`) +
                `\nPosso mandar? Responda *ok* para aprovar ou *nao* para cancelar.`;
              await fetch(`${apiUrlEdit}/message/sendText/${instanceEdit}`, {
                method: "POST",
                headers: { "Content-Type": "application/json", apikey: apiKeyEdit },
                body: JSON.stringify({ number: numberEdit, text: reAskMsg }),
              });
            }

            await logEvent("approval-destination-changed", `from="${approval.assignee_name}" to="${newName}"`);
            return new Response(
              JSON.stringify({ destination_changed: true, id: approval.id, new_name: newName }),
              { headers: { ...corsHeaders, "Content-Type": "application/json" } }
            );
          } else {
            // Not found in contacts - search WhatsApp
            const whatsappResults = await searchWhatsAppChats(sEdit, newDestination);
            if (whatsappResults.length === 1) {
              const chosen = whatsappResults[0];
              const newPhone = chosen.is_group ? chosen.remote_jid : normalizePhone(chosen.remote_jid.split("@")[0]);
              const newName = chosen.name;
              const draftWA = approval.task_draft as Record<string, unknown>;
              if (chosen.is_group) draftWA.group_name = newName;

              let updatedMsg = String(approval.proposed_message ?? "");
              const oldNameEsc = approval.assignee_name.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
              const nameRegex = new RegExp(oldNameEsc, "gi");
              if (nameRegex.test(updatedMsg)) updatedMsg = updatedMsg.replace(nameRegex, newName);

              await supabase.from("pending_message_approvals").update({
                assignee_name: newName, assignee_phone: newPhone,
                proposed_message: updatedMsg, task_draft: draftWA,
              }).eq("id", approval.id);

              // Auto-register the contact
              const { data: existingWA } = await supabase.from("contacts").select("id").eq("remote_jid", chosen.remote_jid).maybeSingle();
              if (!existingWA) {
                await supabase.from("contacts").insert({
                  name: chosen.name, phone: chosen.remote_jid,
                  country_code: "+55", department: chosen.is_group ? "Grupo" : "",
                  is_group: chosen.is_group, remote_jid: chosen.remote_jid, active: true,
                });
              }

              if (apiUrlEdit && apiKeyEdit && instanceEdit) {
                const numberEdit = remoteJid.endsWith("@g.us") ? remoteJid : normalizePhone(remoteJid.split("@")[0]);
                const previewMsg = updatedMsg.replace(/ATOM-XXXX/g, "(codigo gerado automaticamente)");
                const reAskMsg =
                  `Encontrei no WhatsApp! Vou enviar para *${newName}*:\n\n` +
                  `---\n${previewMsg}\n---\n\n` +
                  `Posso mandar? Responda *ok* para aprovar ou *nao* para cancelar.`;
                await fetch(`${apiUrlEdit}/message/sendText/${instanceEdit}`, {
                  method: "POST",
                  headers: { "Content-Type": "application/json", apikey: apiKeyEdit },
                  body: JSON.stringify({ number: numberEdit, text: reAskMsg }),
                });
              }

              await logEvent("approval-destination-changed-whatsapp", `to="${newName}"`);
              return new Response(
                JSON.stringify({ destination_changed: true, id: approval.id, new_name: newName }),
                { headers: { ...corsHeaders, "Content-Type": "application/json" } }
              );
            } else if (whatsappResults.length > 1) {
              // Multiple WhatsApp results - ask confirmation
              const confirmationNeeded = await askConfirmation(
                supabase, sEdit, remoteJid, newDestination, whatsappResults,
                { ...(approval.task_draft as Record<string, unknown>), proposed_message: approval.proposed_message }
              );
              if (confirmationNeeded) {
                await supabase.from("pending_message_approvals")
                  .update({ status: "expired", resolved_at: new Date().toISOString() })
                  .eq("id", approval.id);
                await logEvent("approval-dest-whatsapp-multi", `dest="${newDestination}"`);
                return new Response(
                  JSON.stringify({ awaiting_confirmation: true, searched: newDestination }),
                  { headers: { ...corsHeaders, "Content-Type": "application/json" } }
                );
              }
            }

            // Still not found
            if (apiUrlEdit && apiKeyEdit && instanceEdit) {
              const numberEdit = remoteJid.endsWith("@g.us") ? remoteJid : normalizePhone(remoteJid.split("@")[0]);
              const msg = `Nao encontrei "${newDestination}" nos contatos nem no WhatsApp. Envie o nome exato do grupo/pessoa ou *nao* para cancelar.`;
              await fetch(`${apiUrlEdit}/message/sendText/${instanceEdit}`, {
                method: "POST",
                headers: { "Content-Type": "application/json", apikey: apiKeyEdit },
                body: JSON.stringify({ number: numberEdit, text: msg }),
              });
            }

            await logEvent("approval-destination-not-found", `dest="${newDestination}"`);
            return new Response(
              JSON.stringify({ destination_not_found: true, searched: newDestination }),
              { headers: { ...corsHeaders, "Content-Type": "application/json" } }
            );
          }
        }

        if (ownerIntent === "make_message_only") {
          const draft = approval.task_draft as Record<string, unknown>;
          draft.message_only = true;
          draft.nudge_active = false;
          draft.nudge_repeat_hours = 0;
          const updatedMsg = newMessage || String(approval.proposed_message ?? "");
          // Strip ATOM-XXXX and 1/2/3 options from message if present
          const cleanMsg = updatedMsg
            .replace(/\n?Por favor, confirme como est[aá] essa tarefa:[\s\S]*?Preciso de ajuda\n?/gi, "")
            .replace(/\n?1️⃣[\s\S]*?3️⃣[^\n]*/gi, "")
            .replace(/\n?Ao concluir, responda:.*$/gim, "")
            .replace(/\n{3,}/g, "\n\n")
            .trim();

          await supabase
            .from("pending_message_approvals")
            .update({ proposed_message: cleanMsg, task_draft: draft })
            .eq("id", approval.id);

          if (apiUrlEdit && apiKeyEdit && instanceEdit) {
            const numberEdit = remoteJid.endsWith("@g.us") ? remoteJid : normalizePhone(remoteJid.split("@")[0]);
            const reAskMsg =
              `Entendi! Vou enviar para *${approval.assignee_name}* (sem criar tarefa):\n\n` +
              `---\n${cleanMsg}\n---\n\n` +
              `Posso mandar? Responda *ok* para aprovar ou *nao* para cancelar.`;
            await fetch(`${apiUrlEdit}/message/sendText/${instanceEdit}`, {
              method: "POST",
              headers: { "Content-Type": "application/json", apikey: apiKeyEdit },
              body: JSON.stringify({ number: numberEdit, text: reAskMsg }),
            });
          }

          await logEvent("approval-make-message-only", `approval=${approval.id}`);
          return new Response(
            JSON.stringify({ message_only: true, id: approval.id }),
            { headers: { ...corsHeaders, "Content-Type": "application/json" } }
          );
        }

        if (ownerIntent === "approve") {
          // Treat as approval - reuse the existing approval logic
          const draft = approval.task_draft as Record<string, unknown>;

          // Handle message_only in approve intent from edit flow
          if (draft.message_only === true) {
            const scheduledSendEdit = draft.scheduled_send as string | null;
            const isScheduledForLaterEdit = scheduledSendEdit && new Date(scheduledSendEdit).getTime() > Date.now();

            // If scheduled for later, defer to process-scheduled-sends cron
            if (isScheduledForLaterEdit) {
              await supabase.from("pending_message_approvals")
                .update({ status: "approved", resolved_at: new Date().toISOString(), scheduled_send_at: scheduledSendEdit })
                .eq("id", approval.id);
              if (apiUrlEdit && apiKeyEdit && instanceEdit) {
                const numberEdit = remoteJid.endsWith("@g.us") ? remoteJid : normalizePhone(remoteJid.split("@")[0]);
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
                const scheduleMsg = `Agendado! Vou enviar para *${approval.assignee_name}* em ${fmtSched(scheduledSendEdit!)}. Pode ficar tranquilo.`;
                await fetch(`${apiUrlEdit}/message/sendText/${instanceEdit}`, {
                  method: "POST",
                  headers: { "Content-Type": "application/json", apikey: apiKeyEdit },
                  body: JSON.stringify({ number: numberEdit, text: scheduleMsg }),
                });
              }
              await logEvent("approval-edit-message-only-scheduled", `approval=${approval.id} send=${scheduledSendEdit}`);
              return new Response(
                JSON.stringify({ scheduled: true, message_only: true, send_at: scheduledSendEdit }),
                { headers: { ...corsHeaders, "Content-Type": "application/json" } }
              );
            }

            // Send immediately
            if (apiUrlEdit && apiKeyEdit && instanceEdit && approval.proposed_message) {
              const isGroupMO = String(approval.assignee_phone).includes("@g.us");
              let numberMO = isGroupMO ? approval.assignee_phone : normalizePhone(approval.assignee_phone);
              if (!isGroupMO && numberMO.length <= 11) numberMO = "55" + numberMO;
              await fetch(`${apiUrlEdit}/message/sendText/${instanceEdit}`, {
                method: "POST",
                headers: { "Content-Type": "application/json", apikey: apiKeyEdit },
                body: JSON.stringify({ number: numberMO, text: approval.proposed_message }),
              });
              await supabase.from("send_logs").insert({
                contact_name: approval.assignee_name,
                contact_phone: approval.assignee_phone,
                template_name: "Mensagem direta (GIA NL)",
                message_content: approval.proposed_message,
                status: "sent",
                sent_at: new Date().toISOString(),
              });
            }
            await supabase.from("pending_message_approvals")
              .update({ status: "approved", resolved_at: new Date().toISOString() })
              .eq("id", approval.id);
            if (apiUrlEdit && apiKeyEdit && instanceEdit) {
              const numberEdit = remoteJid.endsWith("@g.us") ? remoteJid : normalizePhone(remoteJid.split("@")[0]);
              await fetch(`${apiUrlEdit}/message/sendText/${instanceEdit}`, {
                method: "POST",
                headers: { "Content-Type": "application/json", apikey: apiKeyEdit },
                body: JSON.stringify({ number: numberEdit, text: `Mensagem enviada para *${approval.assignee_name}*.` }),
              });
            }
            await logEvent("approval-edit-message-only-sent", `approval=${approval.id}`);
            return new Response(
              JSON.stringify({ sent: true, message_only: true }),
              { headers: { ...corsHeaders, "Content-Type": "application/json" } }
            );
          }

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
            const previewEdit = newMessage.replace(/ATOM-XXXX/g, "(codigo gerado automaticamente)");
            const reAskMsg =
              `Entendi! Vou enviar para *${approval.assignee_name}*:\n\n` +
              `---\n${previewEdit}\n---\n\n` +
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
    // Only match short commands (under 120 chars) to avoid false positives on long create_task commands
    const reportMatch = text.length < 120 && /^\s*GIA\s*[\s:,]+.*(relat[oó]rio|report|resumo\s+di[aá]rio)/i.test(text);
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
    if (giaNLMatch && !isStructuredGIA && remoteJid) {
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

          // ── RE-NUDGE FLOW ─────────────────────────────────────────────────────
          const isRenudgeCmd = /\b(cobra\s*(novamente|de\s*novo|outra\s*vez|mais\s*uma\s*vez)|cobr[ae]\s*de\s*novo|manda\s*(outra\s*)?(cobran[cç]a|lembrete)\s*(de\s*novo|novamente|outra\s*vez)?|reenvia\s*(cobran[cç]a|lembrete)|cobra\s+novamente)\b/i.test(freeText);
          if (isRenudgeCmd) {
            const renudgeParsePrompt = `O gestor quer reenviar uma cobrança sobre uma tarefa existente.\nCOMANDO: "${freeText}"\nResponda SOMENTE com JSON valido:\n{"assignee":"nome da pessoa a cobrar (apenas primeiro nome)","task_keywords":["palavras-chave do assunto da tarefa separadas"]}`;
            let renudgeAssignee = "";
            let renudgeKeywords: string[] = [];
            try {
              const rnRes = await fetch("https://api.openai.com/v1/chat/completions", {
                method: "POST",
                headers: { "Content-Type": "application/json", Authorization: `Bearer ${openaiKeyNL}` },
                body: JSON.stringify({ model: openaiModelNL, temperature: 0.2, messages: [{ role: "system", content: "Extrai informacoes. Responda SOMENTE com JSON valido." }, { role: "user", content: renudgeParsePrompt }] }),
              });
              if (rnRes.ok) {
                const rnData = await rnRes.json();
                const rnRaw = String(rnData?.choices?.[0]?.message?.content ?? "").trim().replace(/^```(?:json)?\s*/i, "").replace(/\s*```$/, "");
                const rnJson = JSON.parse(rnRaw);
                renudgeAssignee = String(rnJson.assignee || "").trim();
                renudgeKeywords = Array.isArray(rnJson.task_keywords) ? rnJson.task_keywords.map((k: unknown) => String(k)) : [];
              }
            } catch { /* fallback */ }

            if (!renudgeAssignee) {
              const m = freeText.match(/\b(?:a|o|pro|pra|para|da|do)\s+([A-ZÀ-Ú][a-zA-ZÀ-Ú]+)/);
              if (m) renudgeAssignee = m[1];
            }

            if (renudgeAssignee) {
              // Search by assignee only, then filter by keywords in title/description
              const { data: candidateTasks } = await supabase
                .from("tasks")
                .select("id, title, description, assignee_name, assignee_phone, task_code, due_date, status")
                .neq("status", "completed")
                .ilike("assignee_name", `%${renudgeAssignee}%`)
                .order("created_at", { ascending: false })
                .limit(20);

              let matchedTasks = candidateTasks ?? [];
              // If we have keywords, score tasks by keyword match
              if (renudgeKeywords.length > 0 && matchedTasks.length > 1) {
                const scored = matchedTasks.map(t => {
                  const haystack = `${t.title} ${t.description ?? ""}`.toLowerCase();
                  const score = renudgeKeywords.filter(kw => haystack.includes(kw.toLowerCase())).length;
                  return { ...t, score };
                });
                scored.sort((a, b) => b.score - a.score);
                if (scored[0].score > 0) matchedTasks = [scored[0]];
              }

              const apiUrlRN = sNL["evolution_api_url"]?.replace(/\/$/, "");
              const apiKeyRN = sNL["evolution_api_key"];
              const instanceRN = sNL["evolution_instance_name"];
              const numberOwnerRN = remoteJid.endsWith("@g.us") ? remoteJid : normalizePhone(remoteJid.split("@")[0]);

              if (matchedTasks.length === 0) {
                if (apiUrlRN && apiKeyRN && instanceRN) {
                  await fetch(`${apiUrlRN}/message/sendText/${instanceRN}`, { method: "POST", headers: { "Content-Type": "application/json", apikey: apiKeyRN }, body: JSON.stringify({ number: numberOwnerRN, text: `Nao encontrei tarefa pendente para "${renudgeAssignee}". Verifique o nome ou tente com o codigo (ex: ATOM-1017).` }) });
                }
                return new Response(JSON.stringify({ renudge: false, reason: "not_found" }), { headers: { ...corsHeaders, "Content-Type": "application/json" } });
              }

              const task = matchedTasks[0];
              const taskCode = task.task_code ?? "";
              const fmtDueRN = (iso: string | null) => {
                if (!iso) return "sem prazo";
                const d = new Date(new Date(iso).getTime() - 3 * 60 * 60 * 1000);
                return `${String(d.getUTCDate()).padStart(2,"0")}/${String(d.getUTCMonth()+1).padStart(2,"0")} ${String(d.getUTCHours()).padStart(2,"0")}:${String(d.getUTCMinutes()).padStart(2,"0")}`;
              };

              let renudgeMsg = `Oi ${(task.assignee_name ?? "").split(" ")[0]}! Aqui e a GIA, assistente do Sr. ${ownerName}.\n\nPassando para lembrar sobre: *"${task.title}"*.\n\nAinda aguardamos a conclusao. Ao finalizar, responda: *${taskCode} concluido*`;
              try {
                const rmRes = await fetch("https://api.openai.com/v1/chat/completions", {
                  method: "POST",
                  headers: { "Content-Type": "application/json", Authorization: `Bearer ${openaiKeyNL}` },
                  body: JSON.stringify({ model: openaiModelNL, temperature: 0.5, messages: [
                    { role: "system", content: `Voce e a GIA, assistente executiva do Sr. ${ownerName}. Escreva mensagens de recobranca humanizadas e diretas. Use emojis moderadamente.${sNL["ai_system_prompt"] ? "\n" + sNL["ai_system_prompt"] : ""}` },
                    { role: "user", content: `Gere mensagem de re-cobranca para:\nResponsavel: ${task.assignee_name}\nTarefa: ${task.title}\nDescricao: ${task.description || "sem descricao"}\nPrazo original: ${fmtDueRN(task.due_date)}\n\nINSTRUCOES OBRIGATORIAS:\n- OBRIGATORIO: A mensagem DEVE comecar com apresentacao da GIA. Ex: "Ola ${(task.assignee_name ?? "").split(" ")[0]}! Aqui e a GIA, assistente do Sr. ${ownerName}."\n- Use emojis moderadamente.\n- A mensagem DEVE terminar com: "Ao concluir, responda: ${taskCode} concluido"\nNao inclua nada alem da mensagem final.` },
                  ]}),
                });
                if (rmRes.ok) {
                  const rmData = await rmRes.json();
                  const rmContent = String(rmData?.choices?.[0]?.message?.content ?? "").trim();
                  if (rmContent) renudgeMsg = rmContent;
                }
              } catch { /* use fallback */ }

              await supabase.from("pending_message_approvals").insert({
                owner_jid: remoteJid,
                task_draft: { title: task.title, description: task.description ?? "", priority: "medium", recurrence: "none", recurrence_interval: 1, due_date: task.due_date, first_nudge_at: null, nudge_repeat_hours: 0, nudge_active: false, gia_instruction: "", send_now: true, scheduled_send: null, is_renudge: true, existing_task_id: task.id },
                proposed_message: renudgeMsg,
                assignee_name: task.assignee_name,
                assignee_phone: task.assignee_phone,
                status: "pending",
              });

              if (apiUrlRN && apiKeyRN && instanceRN) {
                const approvalMsg =
                  `Re-cobranca para *${task.assignee_name}* (${taskCode}):\n\n` +
                  `---\n${renudgeMsg}\n---\n\n` +
                  `// Envio: AGORA\n` +
                  (task.due_date ? `// Prazo original: ${fmtDueRN(task.due_date)}\n` : "") +
                  `\nPosso mandar? Responda *ok* para aprovar ou *nao* para cancelar.`;
                await fetch(`${apiUrlRN}/message/sendText/${instanceRN}`, { method: "POST", headers: { "Content-Type": "application/json", apikey: apiKeyRN }, body: JSON.stringify({ number: numberOwnerRN, text: approvalMsg }) });
              }

              await logEvent("renudge-approval-created", `task=${task.id} assignee="${task.assignee_name}"`);
              return new Response(JSON.stringify({ renudge: true, awaiting_approval: true, task_id: task.id }), { headers: { ...corsHeaders, "Content-Type": "application/json" } });
            }
          }
          // ── END RE-NUDGE FLOW ─────────────────────────────────────────────────

          const needsConfirmation = /\bconfirma[cç][aã]o\b/i.test(freeText);

          // Load contacts for the prompt so GPT can match exact names
          const { data: nlContacts } = await supabase
            .from("contacts")
            .select("name, is_group, department")
            .eq("active", true)
            .order("name");
          const nlContactsList = (nlContacts ?? []).map(c =>
            `- "${c.name}" (${c.is_group ? "GRUPO" : "PESSOA"}${c.department ? `, dept: ${c.department}` : ""})`
          ).join("\n");

          const parsePrompt = `Voce e a GIA, assistente executiva. O gestor enviou este comando por WhatsApp em linguagem natural. Extraia as informacoes estruturadas.

HOJE: ${todayISO} (${todayDayName})
FUSO HORARIO: America/Sao_Paulo (UTC-3). TODOS os horarios mencionados pelo gestor sao em horario de Brasilia (BRT).
NOME DO GESTOR: ${ownerName}
${needsConfirmation ? "\nATENCAO: O gestor usou a palavra 'confirmacao'. A mensagem DEVE incluir obrigatoriamente: 'Ao concluir, responda: ATOM-XXXX concluido'\n" : ""}
CONTATOS E GRUPOS CADASTRADOS (use o nome EXATO daqui quando possivel):
${nlContactsList || "(nenhum contato cadastrado)"}

COMANDO: "${freeText}"

Responda APENAS com JSON valido (sem markdown, sem crase), com estes campos:
{
  "title": "titulo curto da tarefa/acao (max 80 chars)",
  "description": "descricao completa do que fazer",
  "assignee": "nome da PESSOA ou GRUPO destinatario da mensagem (ONDE a mensagem sera enviada)",
  "assignees": ["lista de nomes se houver MULTIPLOS destinatarios, senao array vazio"],
  "is_group": false,
  "priority": "high/medium/low",
  "scheduled_send_iso": "data e hora de QUANDO A MENSAGEM deve ser ENVIADA, formato ISO 8601 SEM timezone (ex: 2026-07-22T09:00:00). IMPORTANTE: O horario deve ser EXATAMENTE o que o gestor falou em BRT. Se disse '9 da manha' -> T09:00:00. Se disse '14h' -> T14:00:00. NAO converta para UTC, NAO adicione Z ou +00:00. Se 'envia agora' ou nao especifica -> string vazia.",
  "due_date_iso": "data e hora do PRAZO FINAL da tarefa (quando a pessoa deve ter CONCLUIDO). Mesmo formato: ISO 8601 SEM timezone, horario em BRT. Se disse 'prazo as 9 da manha do dia 31' -> 2026-07-31T09:00:00. Se nao ha prazo, string vazia.",
  "recurrence": "none/daily/weekly/monthly/weekdays",
  "recurrence_interval": 1,
  "nudge_repeat_hours": 24,
  "nudge": true,
  "message_only": false,
  "instruction": "instrucao de COMO a GIA deve agir - ex: 'seja firme', 'apenas envie sem pedir resposta', 'cobre normalmente'",
  "proposed_message": "a mensagem EXATA que a GIA deve enviar para o destinatario, escrita de forma natural e humanizada. Use emojis de forma moderada."
}

REGRA CRITICA - message_only:
- Se o gestor diz "sem criar tarefa", "mensagem so", "so avisando", "so avisa", "apenas avise", "nao precisa cobrar", "sem cobranca", "sem acompanhamento" -> message_only=true, nudge=false
- Quando message_only=true: NAO inclua "Ao concluir, responda: ATOM-XXXX concluido" e NAO inclua opcoes 1/2/3 na proposed_message. A mensagem deve ser APENAS o aviso/informacao, sem pedir confirmacao.
- Quando message_only=false (padrao): INCLUA no final da proposed_message as opcoes 1/2/3 e "Ao concluir, responda: ATOM-XXXX concluido"

REGRAS CRITICAS - DESTINO (PARA ONDE ENVIAR):
- O campo "assignee" e o DESTINO da mensagem: para ONDE a mensagem sera enviada
- REGRA MAIS IMPORTANTE: Use o nome EXATO de um contato/grupo da lista CONTATOS E GRUPOS CADASTRADOS acima. Faca fuzzy match: se o gestor diz "contabilidade", encontre o grupo que tem "contabilidade" no nome (ex: "Contabilidade Group Global"). Use o nome completo e exato como aparece na lista.
- MUITO IMPORTANTE: So faca match se o nome do gestor REALMENTE corresponde a um grupo da lista. NAO force um match quando nao existe. Se o gestor diz "Orcamentos MOC" e NAO existe grupo com "Orcamentos" ou "MOC" na lista, use o nome EXATAMENTE como o gestor escreveu ("Orcamentos MOC"). O sistema vai buscar no WhatsApp automaticamente.
- Se o gestor diz "envia NO GRUPO X" ou "manda no grupo X" -> assignee = nome EXATO do grupo da lista, is_group = true
- Se o gestor diz "envia pro fulano" ou "manda pra fulano" -> assignee = nome EXATO da pessoa da lista, is_group = false
- MUITO IMPORTANTE: Diferencie o DESTINO (onde enviar) do ASSUNTO (sobre quem/o que e a mensagem)
- Exemplo: "envia no grupo Financeiro o lembrete de pix para Ronaldo" -> assignee = nome exato do grupo financeiro da lista (destino), is_group = true
- Exemplo: "envia pro Ronaldo pedindo o pix" -> assignee = nome exato do Ronaldo da lista (destino), is_group = false
- Se nao encontrar correspondencia na lista, use o nome como o gestor escreveu

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
- O proposed_message DEVE SEMPRE comecar com apresentacao da GIA. Ex: "Ola [nome]! Aqui e a GIA, Executive Advisor do Sr. ${ownerName}." — isso e OBRIGATORIO para a pessoa saber que nao e o proprio gestor escrevendo
- Use emojis de forma natural e moderada no proposed_message
- Quando message_only=false: ANTES da instrucao de conclusao, inclua EXATAMENTE estas opcoes de status na proposed_message: "Por favor, confirme como esta essa tarefa:\n1️⃣ Em andamento\n2️⃣ Concluida\n3️⃣ Preciso de ajuda" e TERMINE com "Ao concluir, responda: ATOM-XXXX concluido"
- Quando message_only=true: NAO inclua opcoes 1/2/3, NAO inclua "ATOM-XXXX concluido". Apenas a mensagem pura${needsConfirmation ? "\n- REGRA ABSOLUTA: O gestor usou 'confirmacao', a linha 'Ao concluir, responda: ATOM-XXXX concluido' e OBRIGATORIA" : ""}
- Se nao ha destinatario claro, deixe assignee vazio
- Se o gestor menciona dia da semana (ex: "na segunda-feira"), calcule a data ISO correta a partir de hoje ${todayISO}
- Se o gestor menciona horario (ex: "08:30hr"), inclua no campo correto (scheduled_send_iso ou due_date_iso conforme contexto)
- Se o gestor quer enviar para VARIOS contatos/pessoas, liste em "assignees"
- Se e uma tarefa recorrente (ex: "toda segunda", "todo dia"), defina recurrence adequadamente
- nudge_repeat_hours = intervalo entre cobranças em horas. Se recorrencia "diaria" ou "todo dia" -> nudge_repeat_hours = 24. Se "a cada 12h" -> 12. Se "semanal" -> 168. Se o gestor disser "a cada X horas" -> use X. Default: 24 para diarias.
- recurrence_interval = quantos periodos entre repeticoes. "todo dia" = daily + interval 1. "a cada 2 dias" = daily + interval 2. "toda semana" = weekly + interval 1.
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
              const messageOnly = parsed.message_only === true || parsed.message_only === "true";
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
              // Use GPT's nudge_repeat_hours if provided, else infer from recurrence
              let nudgeRepeatHoursNL = Number(parsed.nudge_repeat_hours) || 0;
              if (!nudgeRepeatHoursNL) {
                if (recurrence === "daily") nudgeRepeatHoursNL = 24;
                else if (recurrence === "weekdays") nudgeRepeatHoursNL = 24;
                else if (recurrence === "weekly") nudgeRepeatHoursNL = 168;
                else nudgeRepeatHoursNL = defaultRepeatHoursNL;
              }
              if (!firstNudgeNL && shouldNudge) {
                firstNudgeNL = new Date(Date.now() + 60 * 60 * 1000).toISOString();
              }

              // Resolve assignee
              let assigneeName = sNL["owner_name"] || "Eu";
              let assigneePhone = normalizePhone(ownerPhoneNL);
              let groupName = "";

              // If the user typed a phone number directly in the command, skip contact search
              // Matches formats like: 34 9123-4561, 349123-4561, +55 34 91234-5678, (34)91234-5678
              const inlinePhoneMatch = freeText.match(/(?:^|[\s(])(?:\+?55[\s\-]?)?(\(?\d{2}\)?[\s\-]?\d{4,5}[\s\-]?\d{4})(?=[\s,.]|$)/);
              const inlinePhone = inlinePhoneMatch ? inlinePhoneMatch[1].replace(/[\s\-().]/g, "") : null;
              if (inlinePhone && assigneeRaw) {
                const normalized = inlinePhone.length <= 11 ? "55" + inlinePhone : inlinePhone;
                assigneeName = assigneeRaw;
                assigneePhone = normalized;
                // Try to enrich name from contacts if available
                const { data: byPhone } = await supabase
                  .from("contacts")
                  .select("name, phone, remote_jid")
                  .or(`phone.ilike.%${inlinePhone}%,remote_jid.ilike.%${inlinePhone}%`)
                  .limit(1)
                  .maybeSingle();
                if (byPhone) {
                  assigneeName = byPhone.name;
                  assigneePhone = byPhone.remote_jid ? normalizePhone(String(byPhone.remote_jid).split("@")[0]) : normalizePhone(String(byPhone.phone ?? ""));
                }
              } else if (assigneeRaw) {
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
                      { title, description, priority, due_date: dueDateNL, recurrence, recurrence_interval: recurrenceInterval, first_nudge_at: firstNudgeNL, nudge_repeat_hours: shouldNudge ? nudgeRepeatHoursNL : 0, nudge_active: shouldNudge, gia_instruction: instruction, proposed_message: proposedMessage, group_name: groupName, is_nl_command: true, send_now: sendNowNL, scheduled_send: scheduledSendNL, message_only: messageOnly }
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
                        { title, description, priority, due_date: dueDateNL, recurrence, recurrence_interval: recurrenceInterval, first_nudge_at: firstNudgeNL, nudge_repeat_hours: shouldNudge ? nudgeRepeatHoursNL : 0, nudge_active: shouldNudge, gia_instruction: instruction, proposed_message: proposedMessage, group_name: groupName, is_nl_command: true, send_now: sendNowNL, scheduled_send: scheduledSendNL, message_only: messageOnly }
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
                      { title, description, priority, due_date: dueDateNL, recurrence, recurrence_interval: recurrenceInterval, first_nudge_at: firstNudgeNL, nudge_repeat_hours: shouldNudge ? nudgeRepeatHoursNL : 0, nudge_active: shouldNudge, gia_instruction: instruction, proposed_message: proposedMessage, group_name: groupName, is_nl_command: true, send_now: sendNowNL, scheduled_send: scheduledSendNL, message_only: messageOnly }
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
                      { title, description, priority, due_date: dueDateNL, recurrence, recurrence_interval: recurrenceInterval, first_nudge_at: firstNudgeNL, nudge_repeat_hours: shouldNudge ? nudgeRepeatHoursNL : 0, nudge_active: shouldNudge, gia_instruction: instruction, proposed_message: proposedMessage, group_name: groupName, is_nl_command: true, send_now: sendNowNL, scheduled_send: scheduledSendNL, message_only: messageOnly }
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
              } // end else if (assigneeRaw) contact search

              // Self-reminder: no assignee means the owner wants a personal reminder
              if (!assigneeRaw && (scheduledSendNL || dueDateNL)) {
                const apiUrlSelf = sNL["evolution_api_url"]?.replace(/\/$/, "");
                const apiKeySelf = sNL["evolution_api_key"];
                const instanceSelf = sNL["evolution_instance_name"];

                const { data: createdSelf } = await supabase.from("tasks").insert({
                  title,
                  description,
                  assignee_name: ownerNameNL,
                  assignee_phone: ownerPhoneNL,
                  group_name: "",
                  status: "pending",
                  priority,
                  due_date: dueDateNL ?? scheduledSendNL,
                  first_nudge_at: null,
                  nudge_active: false,
                  recurrence,
                  recurrence_interval: recurrenceInterval,
                  gia_instruction: instruction || "lembrete pessoal",
                  send_now: sendNowNL,
                  scheduled_send: scheduledSendNL,
                  is_nl_command: true,
                }).select("task_code").maybeSingle();

                if (apiUrlSelf && apiKeySelf && instanceSelf) {
                  const numberSelf = remoteJid.endsWith("@g.us") ? remoteJid : normalizePhone(remoteJid.split("@")[0]);
                  const fmtSelf = (iso: string | null) => {
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
                  const taskCode = createdSelf?.task_code ?? "";
                  const confirmMsg = `Lembrete agendado: *${title}*\n` +
                    (scheduledSendNL ? `Horario: ${fmtSelf(scheduledSendNL)}\n` : "") +
                    (dueDateNL && dueDateNL !== scheduledSendNL ? `Prazo: ${fmtSelf(dueDateNL)}\n` : "") +
                    (taskCode ? `Codigo: ${taskCode}` : "");
                  await fetch(`${apiUrlSelf}/message/sendText/${instanceSelf}`, {
                    method: "POST",
                    headers: { "Content-Type": "application/json", apikey: apiKeySelf },
                    body: JSON.stringify({ number: numberSelf, text: confirmMsg }),
                  });
                }

                await logEvent("gia-nl-self-reminder", title);
                return new Response(
                  JSON.stringify({ self_reminder: true, title }),
                  { headers: { ...corsHeaders, "Content-Type": "application/json" } }
                );
              }

              // If we got here, assignee is resolved. Create approval request.
              if (proposedMessage && assigneeName !== (sNL["owner_name"] || "Eu")) {
                const taskDraft = {
                  title, description, priority, recurrence, recurrence_interval: recurrenceInterval,
                  due_date: dueDateNL, first_nudge_at: firstNudgeNL,
                  nudge_repeat_hours: shouldNudge ? nudgeRepeatHoursNL : 0,
                  nudge_active: shouldNudge,
                  gia_instruction: instruction,
                  group_name: groupName,
                  send_now: sendNowNL,
                  scheduled_send: scheduledSendNL,
                  message_only: messageOnly,
                };

                // Cancel stale pending approvals before creating a new one
                await supabase.from("pending_message_approvals")
                  .update({ status: "expired", resolved_at: new Date().toISOString() })
                  .eq("owner_jid", remoteJid)
                  .eq("status", "pending");

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
                  const lines: string[] = [];
                  if (!sendNowNL && scheduledSendNL) lines.push(`Envio agendado: ${fmtDateNL(scheduledSendNL)}`);
                  else lines.push(`Envio: AGORA`);
                  if (dueDateNL) lines.push(`Prazo final: ${fmtDateNL(dueDateNL)}`);
                  if (shouldNudge && dueDateNL) lines.push(`Cobranca apos prazo: a cada ${defaultRepeatHoursNL}h`);
                  if (recurrence !== "none") lines.push(`Recorrencia: ${recurrence}${recurrenceInterval > 1 ? ` x${recurrenceInterval}` : ""}`);
                  const infoBlock = lines.map(l => `// ${l}`).join("\n");
                  const previewMsg = proposedMessage.replace(/ATOM-XXXX/g, "(codigo gerado automaticamente)");
                  const approvalMsg =
                    `Contato confirmado: *${assigneeName}*\n\n` +
                    `Vou enviar:\n---\n${previewMsg}\n---\n\n` +
                    infoBlock +
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
    if (remoteJid && text && eventName !== "send.message") {
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
          // Check for pending approvals FIRST - handle ok/nao before GPT
          const approvalText = text.trim().toLowerCase();
          const isQuickApprove = /^(ok|sim|manda|envia|aprovo|pode|pode mandar|vai|manda ver|show|beleza|perfeito|bora|blz|s)\s*$/i.test(approvalText);
          const isQuickReject = /^(n[aã]o|cancela|nao|nope|n|nao manda|cancela|para|deixa|esquece)\s*$/i.test(approvalText);
          if (isQuickApprove || isQuickReject) {
            const { data: chatPendingApproval } = await supabase
              .from("pending_message_approvals")
              .select("*")
              .eq("owner_jid", remoteJid)
              .eq("status", "pending")
              .order("created_at", { ascending: false })
              .limit(1);
            if (chatPendingApproval && chatPendingApproval.length > 0) {
              const approval = chatPendingApproval[0];
              if (isQuickReject) {
                await supabase.from("pending_message_approvals").update({ status: "rejected", resolved_at: new Date().toISOString() }).eq("id", approval.id);
                const numberR = remoteJid.endsWith("@g.us") ? remoteJid : normalizePhone(remoteJid.split("@")[0]);
                await fetch(`${apiUrlChat}/message/sendText/${instanceChat}`, { method: "POST", headers: { "Content-Type": "application/json", apikey: apiKeyChat }, body: JSON.stringify({ number: numberR, text: "Cancelado. Mensagem nao enviada." }) });
                await logEvent("approval-rejected-via-chat", `approval=${approval.id}`);
                return new Response(JSON.stringify({ approval_rejected: true }), { headers: { ...corsHeaders, "Content-Type": "application/json" } });
              }
              // Approve: create task and send message
              const draft = approval.task_draft as Record<string, unknown>;

              if (draft.message_only === true) {
                if (approval.proposed_message) {
                  const isGroupDest = String(approval.assignee_phone).includes("@g.us");
                  let numberDest = isGroupDest ? approval.assignee_phone : normalizePhone(approval.assignee_phone);
                  if (!isGroupDest && numberDest.length <= 11) numberDest = "55" + numberDest;
                  await fetch(`${apiUrlChat}/message/sendText/${instanceChat}`, { method: "POST", headers: { "Content-Type": "application/json", apikey: apiKeyChat }, body: JSON.stringify({ number: numberDest, text: approval.proposed_message }) });
                  await supabase.from("send_logs").insert({ contact_name: approval.assignee_name, contact_phone: approval.assignee_phone, template_name: "Mensagem direta (GIA Chat)", message_content: approval.proposed_message, status: "sent", sent_at: new Date().toISOString() });
                }
                await supabase.from("pending_message_approvals").update({ status: "approved", resolved_at: new Date().toISOString() }).eq("id", approval.id);
                const numberA = remoteJid.endsWith("@g.us") ? remoteJid : normalizePhone(remoteJid.split("@")[0]);
                await fetch(`${apiUrlChat}/message/sendText/${instanceChat}`, { method: "POST", headers: { "Content-Type": "application/json", apikey: apiKeyChat }, body: JSON.stringify({ number: numberA, text: `Mensagem enviada para *${approval.assignee_name}*.` }) });
                await logEvent("approval-message-only-via-chat", `approval=${approval.id}`);
                return new Response(JSON.stringify({ sent: true, message_only: true }), { headers: { ...corsHeaders, "Content-Type": "application/json" } });
              }

              const { data: createdTask } = await supabase.from("tasks").insert({
                title: draft.title ?? "Tarefa sem título", description: draft.description ?? "",
                assignee_name: approval.assignee_name, assignee_phone: approval.assignee_phone,
                group_name: draft.group_name ?? "", status: "pending", priority: draft.priority ?? "medium",
                due_date: draft.due_date ?? null, recurrence: draft.recurrence ?? "none",
                recurrence_interval: draft.recurrence_interval ?? 1, first_nudge_at: draft.first_nudge_at ?? null,
                nudge_repeat_hours: draft.nudge_repeat_hours ?? 0, nudge_active: draft.nudge_active ?? false,
                gia_instruction: draft.gia_instruction ?? "",
              }).select().maybeSingle();
              if (approval.proposed_message) {
                let msgToSend = String(approval.proposed_message);
                if (createdTask?.task_code) msgToSend = msgToSend.replace(/ATOM-XXXX/g, createdTask.task_code);
                const isGroupDest = String(approval.assignee_phone).includes("@g.us");
                let numberDest = isGroupDest ? approval.assignee_phone : normalizePhone(approval.assignee_phone);
                if (!isGroupDest && numberDest.length <= 11) numberDest = "55" + numberDest;
                await fetch(`${apiUrlChat}/message/sendText/${instanceChat}`, { method: "POST", headers: { "Content-Type": "application/json", apikey: apiKeyChat }, body: JSON.stringify({ number: numberDest, text: msgToSend }) });
                if (createdTask) {
                  const exactInstr = `ENVIAR_MENSAGEM_EXATA: ${msgToSend}`;
                  await supabase.from("tasks").update({ gia_instruction: exactInstr, last_ai_nudge: new Date().toISOString(), ai_interventions: 1 }).eq("id", createdTask.id);
                }
                await supabase.from("send_logs").insert({ contact_name: approval.assignee_name, contact_phone: approval.assignee_phone, template_name: "Mensagem aprovada (GIA Chat)", message_content: msgToSend, status: "sent", sent_at: new Date().toISOString() });
              }
              await supabase.from("pending_message_approvals").update({ status: "approved", resolved_at: new Date().toISOString(), task_id: createdTask?.id ?? null }).eq("id", approval.id);
              const numberA = remoteJid.endsWith("@g.us") ? remoteJid : normalizePhone(remoteJid.split("@")[0]);
              const code = createdTask?.task_code ? ` ${createdTask.task_code}` : "";
              await fetch(`${apiUrlChat}/message/sendText/${instanceChat}`, { method: "POST", headers: { "Content-Type": "application/json", apikey: apiKeyChat }, body: JSON.stringify({ number: numberA, text: `Mensagem enviada para *${approval.assignee_name}*${code}. Estou acompanhando.` }) });
              await logEvent("approval-approved-via-chat", `approval=${approval.id}`);
              return new Response(JSON.stringify({ approved: true, task_id: createdTask?.id }), { headers: { ...corsHeaders, "Content-Type": "application/json" } });
            }
          }

          const [
            { data: recentTasks },
            { data: pendingApprovals },
            { data: allContacts },
            { data: clevelGroups },
            { data: activeSchedules },
            { data: recentLogs },
          ] = await Promise.all([
            supabase
              .from("tasks")
              .select("id, task_code, title, assignee_name, status, due_date, gia_instruction, created_at, completed_at, assignee_phone")
              .order("created_at", { ascending: false })
              .limit(30),
            supabase
              .from("pending_message_approvals")
              .select("id, assignee_name, proposed_message, status, created_at")
              .eq("status", "pending")
              .order("created_at", { ascending: false })
              .limit(5),
            supabase
              .from("contacts")
              .select("name, phone, department, is_group, remote_jid, active")
              .eq("active", true)
              .order("name"),
            supabase
              .from("clevel_groups")
              .select("label, city, active, contact_id")
              .eq("active", true),
            supabase
              .from("schedules")
              .select("name, send_time, days_of_week, active, send_once")
              .eq("active", true)
              .order("send_time"),
            supabase
              .from("send_logs")
              .select("contact_name, template_name, message_content, status, sent_at")
              .order("sent_at", { ascending: false })
              .limit(15),
          ]);

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

          const contactsList = (allContacts ?? []).map(c => {
            const type = c.is_group ? "GRUPO" : "PESSOA";
            return `- ${c.name} (${type}) | tel: ${c.phone ?? ""} | dept: ${c.department ?? ""} | jid: ${c.remote_jid ?? ""}`;
          }).join("\n");

          const clevelList = (clevelGroups ?? []).map(g =>
            `- ${g.label} | cidade: ${g.city ?? ""}`
          ).join("\n");

          const schedulesList = (activeSchedules ?? []).map(s =>
            `- "${s.name}" | horario: ${s.send_time} | dias: ${(s.days_of_week ?? []).join(",")} | unico: ${s.send_once ? "sim" : "nao"}`
          ).join("\n");

          const logsList = (recentLogs ?? []).map(l =>
            `- [${l.sent_at?.slice(0, 16) ?? "?"}] → ${l.contact_name}: "${(l.message_content ?? "").slice(0, 50)}..." (${l.status})`
          ).join("\n");

          const groupContacts = (allContacts ?? []).filter(c => c.is_group);
          const personContacts = (allContacts ?? []).filter(c => !c.is_group);

          const chatPrompt = `${systemPromptChat}

Voce e a GIA, Executive Advisor do Sr. ${ownerNameChat}. O gestor (${ownerNameChat}) esta falando DIRETAMENTE com voce via WhatsApp.

REGRA CRITICA DE TOM:
- Voce esta conversando com SEU CHEFE. NUNCA se apresente ("Aqui e a GIA", "Ola Marco, sou a GIA") - ele SABE quem voce e.
- Fale como uma assistente HUMANA de confianca: direta, casual, eficiente. Nada de formalidade excessiva.
- Respostas CURTAS e diretas. Nada de "Estou a disposicao!", "Posso ajudar em algo mais?", "Se precisar e so avisar!". Isso e robotico.
- Use tom natural: "Pronto, feito.", "Agendado.", "Anotado, vou cobrar.", "Ja enviei.", "Essa aqui: [info]"
- Quando ele pedir algo, EXECUTE e confirme em 1-2 linhas. Nao faca discursos.
- Emojis: use com moderacao, 0-1 por mensagem. Nada de usar 3+ emojis.
- Se ele perguntar algo, responda DIRETO a informacao pedida. Nao enrole.
- Exemplos de respostas BOAS: "Feito, enviei pro grupo.", "ATOM-1041 concluida.", "Tem 3 tarefas pendentes do Diego.", "Agendado pra amanha 9h."
- Exemplos de respostas RUINS: "Ola Marco! Aqui e a GIA! Como posso ajudar voce hoje? Estou a disposicao! 🚀✨📝"

HOJE: ${todayISOChat} (${todayDayNameChat})
HORA ATUAL (Brasilia): ${nowBRChat.toISOString().slice(11, 16)}

═══ TAREFAS (${(recentTasks ?? []).length} mais recentes) ═══
${tasksContext || "(nenhuma tarefa)"}${pendingContext}

═══ CONTATOS SALVOS (${personContacts.length} pessoas, ${groupContacts.length} grupos) ═══
${contactsList || "(nenhum contato)"}

═══ GRUPOS C-LEVEL CADASTRADOS ═══
${clevelList || "(nenhum grupo C-LEVEL)"}

═══ AGENDAMENTOS ATIVOS ═══
${schedulesList || "(nenhum agendamento)"}

═══ ULTIMOS ENVIOS ═══
${logsList || "(nenhum envio recente)"}

IMPORTANTE - HISTORICO DE CONVERSA:
Voce tem acesso ao historico recente da conversa (ultimos 30 minutos). Use-o para entender o CONTEXTO de mensagens curtas como "8", "esse", "ok", "sim", "manda pro 3", etc. Se na conversa anterior voce listou opcoes numeradas, e o gestor responde com um numero, ENTENDA que ele esta selecionando aquela opcao e EXECUTE a acao correspondente.

COMPORTAMENTO:
- Voce TEM ACESSO a todos os dados acima. Quando o gestor perguntar sobre contatos, grupos, tarefas, envios, agendamentos, CONSULTE os dados e responda com informacoes reais.
- Se o gestor perguntar "quais grupos C-LEVEL voce esta?", liste os grupos com nome C-LEVEL dos CONTATOS SALVOS (is_group=true).
- Se perguntar "quem e responsavel pela tarefa X?", busque nas tarefas.
- Se perguntar "o que foi enviado hoje?", busque nos ultimos envios.
- Se perguntar sobre uma pessoa, busque nos contatos.
- ORIENTADA A ACAO: quando o gestor pedir algo, EXECUTE usando as acoes especiais. Nao fique so perguntando - se tem informacao suficiente, age.
- Quando o gestor der um comando claro (ex: "envia pro grupo X tal mensagem"), use IMEDIATAMENTE a acao create_task. NAO pergunte "qual grupo?" se ele ja disse qual.
- Se o gestor responde um NUMERO apos voce ter listado opcoes, EXECUTE a acao com a opcao selecionada. Ex: voce listou 15 grupos, ele respondeu "8" = use o grupo #8 da lista.
- Respostas curtas e diretas. Use listas so quando for necessario.
- Se o gestor pedir algo que voce nao consegue resolver, diga o que sabe e sugira alternativa em 1 linha.
- NUNCA termine com frases como "Se precisar de algo mais...", "Estou a disposicao", "Posso ajudar em mais alguma coisa?". Simplesmente responda e pronto.

ACOES ESPECIAIS (responda com JSON + ||| + mensagem de confirmacao):

1. ALTERAR AGENDAMENTO:
{"action": "reschedule", "task_code": "ATOM-XXXX", "new_due_date": "ISO8601", "send_now": true/false}

2. ALTERAR STATUS:
{"action": "update_status", "task_code": "ATOM-XXXX", "new_status": "pending|in_progress|awaiting_response|completed|cancelled"}
Mapeamento: "pendente"→"pending", "em andamento"→"in_progress", "aguardando resposta"/"IA cobrando"→"awaiting_response", "concluido"→"completed", "cancelado"→"cancelled"

3. CRIAR TAREFA / ENVIAR MENSAGEM / COBRANCA:
{"action": "create_task", "command": "COMANDO COMPLETO DO GESTOR COPIADO LITERALMENTE"}
Inclui: criar tarefa, enviar mensagem, cobrar, lembrete, tarefa recorrente, broadcast para grupos, etc.

Se nao e uma acao especial, apenas responda normalmente como assistente inteligente.`;

          try {
            // Load conversation history (last 10 messages within 30 min)
            const histCutoff = new Date(Date.now() - 30 * 60 * 1000).toISOString();
            const { data: histRows } = await supabase
              .from("gia_conversation_history")
              .select("role, content, created_at")
              .eq("owner_jid", remoteJid)
              .gte("created_at", histCutoff)
              .order("created_at", { ascending: true })
              .limit(10);
            const histMessages = (histRows ?? []).map(h => ({ role: h.role as "user" | "assistant", content: h.content }));

            // Save current user message to history
            await supabase.from("gia_conversation_history").insert({ owner_jid: remoteJid, role: "user", content: text });

            // Clean up old history (older than 1 hour)
            const cleanupCutoff = new Date(Date.now() - 60 * 60 * 1000).toISOString();
            await supabase.from("gia_conversation_history").delete().lt("created_at", cleanupCutoff);

            const aiResChat = await fetch("https://api.openai.com/v1/chat/completions", {
              method: "POST",
              headers: { "Content-Type": "application/json", Authorization: `Bearer ${openaiKeyChat}` },
              body: JSON.stringify({
                model: openaiModelChat,
                temperature: 0.5,
                messages: [
                  { role: "system", content: chatPrompt },
                  ...histMessages,
                  { role: "user", content: text },
                ],
              }),
            });

            if (aiResChat.ok) {
              const jChat = await aiResChat.json();
              let reply = String(jChat?.choices?.[0]?.message?.content ?? "").trim();

              // Check if the response contains a create_task action
              const jsonCreateMatch = /\{[\s\S]*?"action"\s*:\s*"create_task"[\s\S]*?\}/.exec(reply);
              if (jsonCreateMatch) {
                try {
                  const actionData = JSON.parse(jsonCreateMatch[0]);
                  const command = String(actionData.command || "").trim();
                  if (command) {
                    // Re-invoke the webhook with "GIA <command>" to leverage the full NL pipeline
                    const supabaseUrl = Deno.env.get("SUPABASE_URL")!;
                    const serviceKey = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!;
                    await fetch(`${supabaseUrl}/functions/v1/whatsapp-webhook`, {
                      method: "POST",
                      headers: { "Content-Type": "application/json", Authorization: `Bearer ${serviceKey}` },
                      body: JSON.stringify({
                        event: "messages.upsert",
                        internal_reinvoke: true,
                        data: {
                          key: { fromMe: true, remoteJid },
                          message: { conversation: `GIA ${command}` },
                          messageType: "conversation",
                        },
                        instance: instanceChat,
                      }),
                    });
                    // Always suppress the GPT reply - the NL pipeline handles communication
                    // (sends approval request or direct confirmation with real task code)
                    await logEvent("gia-chat-create-task", command.slice(0, 60));
                    return new Response(
                      JSON.stringify({ chat_reply: true, delegated_to_nl: true }),
                      { headers: { ...corsHeaders, "Content-Type": "application/json" } }
                    );
                  }
                } catch { /* JSON parse failed */ }
              }

              // Check if the response contains an update_status action
              const jsonStatusMatch = /^\s*\{[\s\S]*?"action"\s*:\s*"update_status"[\s\S]*?\}/.exec(reply);
              if (jsonStatusMatch) {
                try {
                  const actionData = JSON.parse(jsonStatusMatch[0]);
                  const taskCode = actionData.task_code;
                  const newStatus = actionData.new_status;
                  const validStatuses = ["pending", "in_progress", "awaiting_response", "completed", "cancelled"];
                  if (taskCode && validStatuses.includes(newStatus)) {
                    const { data: targetTask } = await supabase
                      .from("tasks")
                      .select("id, assignee_name")
                      .eq("task_code", taskCode)
                      .maybeSingle();
                    if (targetTask) {
                      const statusUpdate: Record<string, unknown> = { status: newStatus };
                      if (newStatus === "completed") {
                        statusUpdate.completed_at = new Date().toISOString();
                        // For recurring tasks, keep nudge_active so they fire again
                        const { data: taskFull } = await supabase.from("tasks").select("recurrence").eq("id", targetTask.id).maybeSingle();
                        const isRecurringTask = taskFull?.recurrence && taskFull.recurrence !== "none";
                        if (!isRecurringTask) statusUpdate.nudge_active = false;
                      } else if (newStatus === "cancelled") {
                        statusUpdate.nudge_active = false;
                      }
                      await supabase.from("tasks").update(statusUpdate).eq("id", targetTask.id);
                      reply = reply.includes("|||") ? reply.split("|||").pop()!.trim() : `Pronto! Status da ${taskCode} atualizado para "${newStatus}".`;
                    } else {
                      reply = reply.includes("|||") ? reply.split("|||").pop()!.trim() : `Nao encontrei a tarefa ${taskCode}.`;
                    }
                  }
                } catch { /* JSON parse failed */ }
              }

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
                // Save assistant reply to conversation history
                await supabase.from("gia_conversation_history").insert({ owner_jid: remoteJid, role: "assistant", content: reply });

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

    // Skip groups that belong to other systems (e.g. financial)
    const excludedJids = (settings["excluded_group_jids"] ?? "").split(",").map((s: string) => s.trim()).filter(Boolean);
    if (isGroup && excludedJids.includes(remoteJid)) {
      await logEvent("ignored-excluded-group", `jid=${remoteJid}`);
      return new Response(JSON.stringify({ ignored: "excluded_group" }), {
        headers: { ...corsHeaders, "Content-Type": "application/json" },
      });
    }

    // In groups, check if GIA is @mentioned, text says "GIA", has a task code,
    // or is a short intent reply (1/2/3/concluido etc.) to a recent nudge
    if (isGroup) {
      const giaPhone = settings["gia_phone"] ?? "";
      const giaJid = giaPhone ? `${normalizePhone(giaPhone)}@s.whatsapp.net` : "";
      const wasMentioned = giaJid
        ? mentionedJids.some((jid: string) => jid === giaJid || jid.startsWith(normalizePhone(giaPhone)))
        : false;
      const mentionedByName = /\b@?\s*gia\b/i.test(text);
      const hasTaskCode = /\bATOM-\d+\b/i.test(text) || /\bATOM-\d+\b/i.test(
        msg?.extendedTextMessage?.contextInfo?.quotedMessage?.conversation ??
        msg?.extendedTextMessage?.contextInfo?.quotedMessage?.extendedTextMessage?.text ?? ""
      );
      const isShortIntentReply = /^\s*[123]\s*$/.test(text) ||
        /\b(conclu[ií]d[oa]?|finalizado|feito|pronto|done|andamento|fazendo|bloquead[oa]?|travad[oa]?)\b/i.test(text);

      // For short intent replies, check if GIA recently nudged this group
      let recentNudgeInGroup = false;
      if (isShortIntentReply) {
        const { data: recentTasks } = await supabase
          .from("tasks")
          .select("id")
          .eq("assignee_phone", remoteJid)
          .neq("status", "completed")
          .not("last_ai_nudge", "is", null)
          .gte("last_ai_nudge", new Date(Date.now() - 48 * 60 * 60 * 1000).toISOString())
          .limit(1);
        recentNudgeInGroup = (recentTasks?.length ?? 0) > 0;
      }

      const giaWasInvoked = wasMentioned || mentionedByName || hasTaskCode || recentNudgeInGroup;

      // If auto_read is off, only process when GIA is directly invoked
      if (!autoRead && !giaWasInvoked) {
        await logEvent("ignored-group", "ai_auto_read_groups disabled and no GIA mention");
        return new Response(JSON.stringify({ ignored: "group auto-read disabled" }), {
          headers: { ...corsHeaders, "Content-Type": "application/json" },
        });
      }

      if (!giaWasInvoked) {
        await logEvent("ignored-group-no-mention", `jid=${remoteJid} text="${text.slice(0, 40)}"`);
        return new Response(JSON.stringify({ ignored: "group_no_mention" }), {
          headers: { ...corsHeaders, "Content-Type": "application/json" },
        });
      }
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

    // Only process if: (1) message is exactly 1/2/3, (2) has task code, (3) has gia_instruction and was nudged recently, or (4) short intent reply with recent nudge
    const giaInstr = String(match.gia_instruction ?? "").trim();
    let intent: Intent = classify(text);
    const lastNudge = match.last_ai_nudge ? new Date(String(match.last_ai_nudge)).getTime() : 0;
    const nudgedRecently = Date.now() - lastNudge < 48 * 60 * 60 * 1000; // 48h window

    // Short replies (1/2/3 or status keywords) to a recent nudge should always be processed
    const isShortReply = /^\s*[123]\s*$/.test(text) ||
      /\b(conclu[ií]d[oa]?|finalizado|feito|pronto|done|terminado|andamento|fazendo|executando|bloquead[oa]?|travad[oa]?|impedid[oa]?|enviado|enviada|sim|nao|não|ok)\b/i.test(text);

    // Map short replies 1/2/3 to intents when nudged recently
    // Standard GIA options: 1=Em andamento, 2=Concluido/Pronto, 3=Preciso de ajuda
    if (intent === "unknown" && nudgedRecently && /^\s*1\s*$/.test(text)) intent = "in_progress";
    if (intent === "unknown" && nudgedRecently && /^\s*2\s*$/.test(text)) intent = "completed";
    if (intent === "unknown" && nudgedRecently && /^\s*3\s*$/.test(text)) intent = "blocked";

    // If intent is unknown and no task code was explicitly referenced, check if it's a valid response to a nudge
    if (intent === "unknown" && !code && !giaInstr && !(isShortReply && nudgedRecently)) {
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

    // If task was nudged recently and intent is still unknown, use GPT to interpret the response
    if (intent === "unknown" && nudgedRecently && (giaInstr || isShortReply)) {
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
        const next = nextDueDate(match.due_date as string | null, recurrence, recurrenceInterval);
        updates.status = "completed";
        updates.completed_at = new Date().toISOString();
        updates.ai_interventions = 0;
        updates.last_ai_nudge = null;
        updates.nudge_active = true;
        if (next) {
          updates.due_date = next;
          updates.first_nudge_at = next;
        }
        recurred = true;
      } else {
        updates.status = "completed";
        updates.completed_at = new Date().toISOString();
        updates.nudge_active = false;
      }
    } else if (intent === "in_progress") {
      updates.status = "in_progress";
      const newDue = new Date(Date.now() + 4 * 60 * 60 * 1000).toISOString();
      updates.due_date = newDue;
      updates.first_nudge_at = newDue;
      updates.nudge_active = true;
      updates.last_ai_nudge = null;
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
    if (autoReply && (intent !== "unknown" || giaInstr || (isShortReply && nudgedRecently))) {
      const apiUrl = settings["evolution_api_url"]?.replace(/\/$/, "");
      const apiKey = settings["evolution_api_key"];
      const instanceName = settings["evolution_instance_name"];
      const openaiKey = settings["openai_api_key"] ?? "";
      const openaiModel = settings["openai_model"] || "gpt-4o-mini";
      const systemPrompt = settings["ai_system_prompt"] ?? "";
      if (apiUrl && apiKey && instanceName) {
        let replyText = replyFor(intent, String(match.assignee_name ?? ""), String(match.title ?? ""), String(match.task_code ?? ""), intent === "in_progress" ? (updates.due_date as string | undefined) : undefined);

        // If GPT already produced a reply from interpretation, use it (but not for in_progress — we need the deadline info)
        if (aiInterpretation && intent !== "in_progress") {
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
