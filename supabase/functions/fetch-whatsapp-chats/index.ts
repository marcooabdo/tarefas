import "jsr:@supabase/functions-js/edge-runtime.d.ts";
import { createClient } from "npm:@supabase/supabase-js@2";

const corsHeaders = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Methods": "GET, POST, PUT, DELETE, OPTIONS",
  "Access-Control-Allow-Headers": "Content-Type, Authorization, X-Client-Info, Apikey",
};

interface EvoChat { id?: string; remoteJid?: string; pushName?: string; name?: string; subject?: string; }
interface EvoContact { id?: string; remoteJid?: string; pushName?: string; name?: string; notify?: string; }

function jsonResponse(body: unknown, status = 200) {
  return new Response(JSON.stringify(body), {
    status,
    headers: { ...corsHeaders, "Content-Type": "application/json" },
  });
}

Deno.serve(async (req: Request) => {
  if (req.method === "OPTIONS") return new Response(null, { status: 200, headers: corsHeaders });

  try {
    const supabase = createClient(
      Deno.env.get("SUPABASE_URL")!,
      Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!
    );

    const { data: settings } = await supabase
      .from("app_settings")
      .select("key, value")
      .in("key", ["evolution_api_url", "evolution_api_key", "evolution_instance_name"]);

    const map = new Map((settings ?? []).map((s: { key: string; value: string }) => [s.key, s.value]));
    const apiUrl = (map.get("evolution_api_url") ?? "").replace(/\/$/, "");
    const apiKey = map.get("evolution_api_key") ?? "";
    const instance = map.get("evolution_instance_name") ?? "";

    if (!apiUrl || !apiKey || !instance) {
      return jsonResponse({ error: "Evolution API não configurada. Preencha URL, API Key e nome da instância em Configurações." }, 400);
    }

    const url = new URL(req.url);
    const body = req.method === "POST" ? await req.json().catch(() => ({})) : {};
    const action: string = body.action ?? url.searchParams.get("action") ?? "list";

    const headers = { apikey: apiKey, "Content-Type": "application/json" };

    if (action === "list") {
      const groupEndpoints = [
        `${apiUrl}/group/fetchAllGroups/${instance}?getParticipants=false`,
        `${apiUrl}/group/findGroups/${instance}`,
      ];
      const chatEndpoints = [
        `${apiUrl}/chat/findChats/${instance}`,
        `${apiUrl}/chat/fetchChats/${instance}`,
      ];
      const contactEndpoints = [
        `${apiUrl}/chat/findContacts/${instance}`,
        `${apiUrl}/chat/fetchContacts/${instance}`,
      ];

      // Fetch all groups via dedicated endpoint (most complete)
      let groupList: Array<{ id?: string; remoteJid?: string; subject?: string; name?: string }> = [];
      for (const ep of groupEndpoints) {
        try {
          const r = await fetch(ep, { method: "GET", headers });
          if (r.ok) { const j = await r.json(); groupList = Array.isArray(j) ? j : (j.groups ?? j.data ?? []); if (groupList.length) break; }
        } catch { /* try next */ }
      }

      let chats: EvoChat[] = [];
      for (const ep of chatEndpoints) {
        try {
          const r = await fetch(ep, { method: "POST", headers, body: JSON.stringify({}) });
          if (r.ok) { const j = await r.json(); chats = Array.isArray(j) ? j : (j.chats ?? j.data ?? []); if (chats.length) break; }
        } catch { /* try next */ }
      }

      let contactList: EvoContact[] = [];
      for (const ep of contactEndpoints) {
        try {
          const r = await fetch(ep, { method: "POST", headers, body: JSON.stringify({}) });
          if (r.ok) { const j = await r.json(); contactList = Array.isArray(j) ? j : (j.contacts ?? j.data ?? []); if (contactList.length) break; }
        } catch { /* try next */ }
      }

      const results: Array<{ remote_jid: string; name: string; phone: string; is_group: boolean }> = [];
      const seen = new Set<string>();

      // Groups from dedicated endpoint first
      for (const g of groupList) {
        const jid = g.id ?? g.remoteJid ?? "";
        if (!jid || seen.has(jid)) continue;
        seen.add(jid);
        const name = g.subject ?? g.name ?? "Grupo sem nome";
        results.push({ remote_jid: jid, name, phone: "", is_group: true });
      }

      for (const c of chats) {
        const jid = c.remoteJid ?? c.id ?? "";
        if (!jid || seen.has(jid)) continue;
        seen.add(jid);
        const isGroup = jid.endsWith("@g.us");
        const phone = isGroup ? "" : jid.split("@")[0].replace(/\D/g, "");
        const name = c.subject ?? c.name ?? c.pushName ?? (isGroup ? "Grupo sem nome" : phone);
        results.push({ remote_jid: jid, name, phone: isGroup ? "" : `+${phone}`, is_group: isGroup });
      }

      for (const c of contactList) {
        const jid = c.remoteJid ?? c.id ?? "";
        if (!jid || seen.has(jid) || jid.endsWith("@g.us") || jid.endsWith("@broadcast")) continue;
        seen.add(jid);
        const phone = jid.split("@")[0].replace(/\D/g, "");
        const name = c.pushName ?? c.name ?? c.notify ?? phone;
        results.push({ remote_jid: jid, name, phone: `+${phone}`, is_group: false });
      }

      const { data: existing } = await supabase.from("contacts").select("remote_jid").not("remote_jid", "is", null);
      const existingSet = new Set((existing ?? []).map((e: { remote_jid: string }) => e.remote_jid));
      const enriched = results.map((r) => ({ ...r, already_imported: existingSet.has(r.remote_jid) }));

      enriched.sort((a, b) => {
        if (a.is_group !== b.is_group) return a.is_group ? -1 : 1;
        return a.name.localeCompare(b.name);
      });

      return jsonResponse({ items: enriched, total: enriched.length });
    }

    if (action === "import") {
      const items: Array<{ remote_jid: string; name: string; phone: string; is_group: boolean }> = body.items ?? [];
      if (!Array.isArray(items) || items.length === 0) {
        return jsonResponse({ error: "Nenhum item para importar." }, 400);
      }

      const jids = items.map((i) => i.remote_jid).filter(Boolean);
      const { data: existing } = await supabase
        .from("contacts")
        .select("remote_jid")
        .in("remote_jid", jids);
      const existingSet = new Set((existing ?? []).map((e: { remote_jid: string }) => e.remote_jid));

      const toInsert = items
        .filter((it) => it.remote_jid && !existingSet.has(it.remote_jid))
        .map((it) => {
          const isGroup = !!it.is_group;
          const phone = isGroup ? it.remote_jid : (it.phone || "");
          return {
            name: it.name?.trim() || "Sem nome",
            phone,
            country_code: !isGroup && it.phone?.startsWith("+") ? it.phone.slice(0, 3) : "+55",
            department: isGroup ? "Grupo" : "",
            is_group: isGroup,
            remote_jid: it.remote_jid,
            active: true,
          };
        });

      if (toInsert.length === 0) {
        return jsonResponse({ imported: 0, skipped: items.length, reason: "Todos já estavam importados." });
      }

      const { data, error } = await supabase.from("contacts").insert(toInsert).select();
      if (error) return jsonResponse({ error: error.message, attempted: toInsert.length }, 500);
      return jsonResponse({ imported: data?.length ?? 0, skipped: items.length - toInsert.length });
    }

    return jsonResponse({ error: "Ação inválida." }, 400);
  } catch (e) {
    return jsonResponse({ error: (e as Error).message }, 500);
  }
});
