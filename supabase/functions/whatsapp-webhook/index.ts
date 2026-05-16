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
          })
          .select()
          .maybeSingle();

        await supabase
          .from("pending_task_confirmations")
          .update({ status: "confirmed", resolved_at: new Date().toISOString() })
          .eq("id", confirmation.id);

        // Send confirmation reply
        const apiUrlConf = sConf["evolution_api_url"]?.replace(/\/$/, "");
        const apiKeyConf = sConf["evolution_api_key"];
        const instanceConf = sConf["evolution_instance_name"];
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
                  { title, description, priority, due_date, recurrence, recurrence_interval: recurrenceInterval, first_nudge_at: first_nudge_at, nudge_repeat_hours, nudge_active }
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
                  { title, description, priority, due_date, recurrence, recurrence_interval: recurrenceInterval, first_nudge_at: first_nudge_at, nudge_repeat_hours, nudge_active }
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
            `Cobrança: ${fmtDate(first_nudge_at)}${nudge_repeat_hours > 0 ? ` (repete a cada ${nudge_repeat_hours}h)` : ""}`;
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
