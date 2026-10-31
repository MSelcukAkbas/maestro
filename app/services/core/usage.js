// Oturum başına harcama ve bağlam boyutu: Claude'un konuşma dosyasından (projects/*/<id>.jsonl) okunur.
// Dosya ölçümle ortak okuyucudan (server/transcript.js) kaldığı yerden okunur; yalnızca yeni satırlar işlenir.

function emptyState() {
  return {
    seenMsg: new Set(),
    tokens: { input: 0, output: 0, cacheRead: 0, cacheCreate: 0 },
    // Her Claude süreci kendi cost-state toplamını yazar; devam ettirilen oturumda süreç başına son değer toplanır.
    costByRun: new Map(),
    context: 0,
    model: null,
    lastText: '',
    lastAt: null,
    firstAt: null,
    prompts: 0,
    // Bu oturumun SendMessage ile gönderdiği mesajlar (iletişim haritası ve zaman çizelgesi için).
    sent: [],
    seenTool: new Set(),
    // Çağrılan skill'ler (Skill aracı ve kullanıcının /ad komutu) ve MCP sunucuları: ad → sayı. Rol danışmanı ve rol
    // sayfası hangi yeteneğin gerçekten kullanıldığını buradan görür.
    skillCalls: {},
    mcpCalls: {},
  };
}

const MAX_SENT = 300;

function firstLine(s) {
  return String(s || '').split('\n').map((x) => x.trim()).find(Boolean) || '';
}

function textOf(content) {
  if (typeof content === 'string') return content;
  if (!Array.isArray(content)) return '';
  return content.filter((c) => c && c.type === 'text').map((c) => c.text).join('\n');
}

// j: konuşma kaydının ayrıştırılmış bir satırı (server/transcript.js her satırı bir kez ayrıştırır).
function applyObj(st, j) {
  const ts = j.timestamp ? Date.parse(j.timestamp) : null;
  if (j.type === 'cost-state') {
    st.costByRun.set(String(j.startTime), {
      cost: Number(j.totalCostUSD) || 0,
      added: Number(j.totalLinesAdded) || 0,
      removed: Number(j.totalLinesRemoved) || 0,
    });
    return;
  }
  if (j.type === 'user' && j.message && !j.isSidechain) {
    const c = j.message.content;
    const isToolResult = Array.isArray(c) && c.some((x) => x && x.type === 'tool_result');
    if (!isToolResult && textOf(c).trim()) st.prompts++;
    const cmd = !isToolResult && textOf(c).match(/<command-name>\/?([^<\s]+)<\/command-name>/);
    if (cmd) st.skillCalls[cmd[1]] = (st.skillCalls[cmd[1]] || 0) + 1;
    if (ts && !st.firstAt) st.firstAt = ts;
    return;
  }
  if (j.type !== 'assistant' || !j.message || j.isSidechain) return;
  const m = j.message;
  if (ts) {
    st.lastAt = ts;
    if (!st.firstAt) st.firstAt = ts;
  }
  if (m.model && m.model !== '<synthetic>') st.model = m.model;
  if (Array.isArray(m.content)) {
    for (const c of m.content) {
      if (!c || c.type !== 'tool_use' || !c.input || st.seenTool.has(c.id)) continue;
      if (c.name === 'Skill' && typeof c.input.skill === 'string') {
        st.seenTool.add(c.id);
        st.skillCalls[c.input.skill] = (st.skillCalls[c.input.skill] || 0) + 1;
        continue;
      }
      const mcp = String(c.name).match(/^mcp__(.+?)__/);
      if (mcp) {
        st.seenTool.add(c.id);
        st.mcpCalls[mcp[1]] = (st.mcpCalls[mcp[1]] || 0) + 1;
        continue;
      }
      if (c.name !== 'SendMessage') continue;
      st.seenTool.add(c.id);
      st.sent.push({
        ts: ts || Date.now(),
        // "ad [ref]" biçimindeki ek kaldırılır; eşleştirme oturum adıyla yapılır.
        to: String(c.input.to || '').replace(/\s*\[[0-9a-f]+\]\s*$/i, ''),
        text: (c.input.summary || firstLine(c.input.message)).slice(0, 200),
        body: String(c.input.message || '').slice(0, 6000),
      });
      if (st.sent.length > MAX_SENT) st.sent.shift();
    }
  }
  const text = textOf(m.content).trim();
  if (text) st.lastText = text;
  const u = m.usage;
  if (!u) return;
  const ctx = (u.input_tokens || 0) + (u.cache_read_input_tokens || 0) + (u.cache_creation_input_tokens || 0) + (u.output_tokens || 0);
  if (ctx > 0) st.context = ctx;
  // Aynı yanıt birden çok satıra bölünerek yazılabilir; tokenlar mesaj kimliği başına bir kez sayılır.
  const id = m.id || j.uuid;
  if (st.seenMsg.has(id)) return;
  st.seenMsg.add(id);
  st.tokens.input += u.input_tokens || 0;
  st.tokens.output += u.output_tokens || 0;
  st.tokens.cacheRead += u.cache_read_input_tokens || 0;
  st.tokens.cacheCreate += u.cache_creation_input_tokens || 0;
}

// Oturumun özet durumu; kayıt ölçümle (meter) ortak okuyucudan okunur. Dosya yoksa null.
function stateOf(file) {
  if (!file) return null;
  const t = require('./transcript').read(file);
  return t ? t.u : null;
}

function sessionMessages(file) {
  const st = stateOf(file);
  return st ? st.sent : [];
}

function sessionStats(file) {
  const st = stateOf(file);
  if (!st) return null;
  let cost = 0, added = 0, removed = 0;
  for (const r of st.costByRun.values()) {
    cost += r.cost;
    added += r.added;
    removed += r.removed;
  }
  return {
    costUSD: cost,
    linesAdded: added,
    linesRemoved: removed,
    tokens: st.tokens,
    context: st.context,
    model: st.model,
    lastText: st.lastText.length > 1200 ? st.lastText.slice(0, 1200) + '…' : st.lastText,
    firstAt: st.firstAt,
    lastAt: st.lastAt,
    prompts: st.prompts,
    skillCalls: st.skillCalls,
    mcpCalls: st.mcpCalls,
  };
}

module.exports = { sessionStats, sessionMessages, emptyState, applyObj };
