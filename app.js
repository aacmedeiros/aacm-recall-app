/* AACM Recall — app principal
 *
 * Camada de dados: le e grava direto no repositorio PRIVADO do GitHub
 * (aacmedeiros/aacm-recall-data) via GitHub Contents API, usando um
 * token de acesso pessoal que fica so no localStorage deste navegador
 * (nunca no codigo do app, que e publico). Sem token, cai num modo
 * local de teste (data/index.json ao lado do app) — so usado em
 * desenvolvimento.
 *
 * "Overrides" locais: toda edicao atualiza o localStorage na hora
 * (resposta instantanea, funciona offline) e o commit de verdade pro
 * GitHub acontece quando voce termina de editar (fecha o editor) —
 * assim nao cria um commit a cada letra digitada.
 */

const DATA_BASE = "../data"; // usado so no modo local de teste (sem token)
const GEMINI_MODEL = "gemini-2.5-flash"; // trocar aqui se o nome do modelo mudar

const GH_OWNER = "aacmedeiros";
const GH_REPO = "aacm-recall-data";
const GH_BRANCH = "master";

const state = {
  index: [],
  activeTag: null,
  query: "",
  route: { view: "home" },
  bodyCache: {},
  indexSha: null,
  cardShas: {},
  customTags: loadJSON("aacm-custom-tags", []),
  overrides: loadJSON("aacm-overrides", {}), // slug -> { tags?: [...], content?: "..." }
  filters: { tags: new Set(), sources: new Set(), dateFrom: "", dateTo: "" },
  sort: { by: "created", dir: "desc", groupBy: "day" },
};

const TAG_ORDER_HINT = (tag) => {
  const m = tag.match(/^(\d)\./);
  if (m) return parseInt(m[1], 10);
  return 99;
};

function loadJSON(key, fallback) {
  try {
    const raw = localStorage.getItem(key);
    return raw ? JSON.parse(raw) : fallback;
  } catch (e) {
    return fallback;
  }
}
function saveJSON(key, value) {
  try {
    localStorage.setItem(key, JSON.stringify(value));
  } catch (e) {
    console.warn("Nao foi possivel salvar", key, e);
  }
}

// ---------------------------------------------------------------------
// Overrides: tags e conteudo editados localmente
// ---------------------------------------------------------------------

function getEffectiveTags(card) {
  const ov = state.overrides[card.slug];
  return ov && ov.tags ? ov.tags : card.tags;
}

function setCardTags(slug, tags) {
  state.overrides[slug] = { ...(state.overrides[slug] || {}), tags };
  saveJSON("aacm-overrides", state.overrides);
}

function getEffectiveContent(card, body) {
  const ov = state.overrides[card.slug];
  if (ov && typeof ov.content === "string") return ov.content;
  return body.summaryMd + (body.notesMd ? "\n\n" + body.notesMd : "");
}

function setCardContent(slug, content) {
  state.overrides[slug] = { ...(state.overrides[slug] || {}), content };
  saveJSON("aacm-overrides", state.overrides);
  state.termIndexCache = null; // o [[termo]] pode ter mudado, recalcula na proxima vez
}

// Envia o estado atual (tags + conteudo efetivos) do card para o GitHub.
// So faz algo se houver token configurado; sem token, fica so no
// localStorage (modo local de teste). Em caso de sucesso, limpa o
// "rascunho" local porque o GitHub ja passa a ser a fonte da verdade.
async function syncCardToGitHub(slug) {
  if (!getGhToken()) return { skipped: true };
  const card = state.index.find((c) => c.slug === slug);
  if (!card) return { skipped: true };

  const body = state.bodyCache[slug] || (await loadCardBody(slug));
  const content = getEffectiveContent(card, body);
  card.tags = getEffectiveTags(card);

  await saveCardToGitHub(slug, content);
  delete state.overrides[slug];
  saveJSON("aacm-overrides", state.overrides);
  return { skipped: false };
}

// ---------------------------------------------------------------------
// Indice de termos entre colchetes: "cards em comum" sao cards onde
// aparece o MESMO [[termo]], mesmo que o termo nao seja titulo de
// nenhum card. Construido a partir de index.json (rapido, sem precisar
// baixar o conteudo de todos os cards) + qualquer edicao local.
// ---------------------------------------------------------------------

const BRACKET_RE = /\[\[([^\]|]+)(?:\|[^\]]+)?\]\]/g;

function normalizeTerm(s) {
  return s.trim().toLowerCase().replace(/\s+/g, " ");
}

function extractBracketTerms(md) {
  const terms = [];
  const seen = new Set();
  let m;
  BRACKET_RE.lastIndex = 0;
  while ((m = BRACKET_RE.exec(md))) {
    const raw = m[1].trim();
    const norm = normalizeTerm(raw);
    if (norm && !seen.has(norm)) { seen.add(norm); terms.push(raw); }
  }
  return terms;
}

function getCardBracketTerms(card) {
  const ov = state.overrides[card.slug];
  if (ov && typeof ov.content === "string") return extractBracketTerms(ov.content);
  return card.bracket_terms || [];
}

function buildTermIndex() {
  if (state.termIndexCache) return state.termIndexCache;
  const map = new Map(); // normalizedTerm -> Set(slug)
  for (const card of state.index) {
    for (const term of getCardBracketTerms(card)) {
      const key = normalizeTerm(term);
      if (!map.has(key)) map.set(key, new Set());
      map.get(key).add(card.slug);
    }
  }
  state.termIndexCache = map;
  return map;
}

function allKnownTags() {
  const set = new Set(state.customTags);
  for (const card of state.index) {
    for (const t of getEffectiveTags(card)) set.add(t);
  }
  return [...set].sort((a, b) => TAG_ORDER_HINT(a) - TAG_ORDER_HINT(b) || a.localeCompare(b));
}

// ---------------------------------------------------------------------
// Camada de dados (fronteira que sera trocada pelo GitHub API depois)
// ---------------------------------------------------------------------

// ---------------------------------------------------------------------
// GitHub Contents API — ler e gravar arquivos no repositorio privado
// ---------------------------------------------------------------------

function getGhToken() { return localStorage.getItem("aacm-gh-token") || ""; }
function setGhToken(t) { localStorage.setItem("aacm-gh-token", t.trim()); }
function clearGhToken() { localStorage.removeItem("aacm-gh-token"); }

// base64 seguro pra UTF-8 (acentos, emoji nas tags, etc.). Converte em
// pedacos de 32KB — passar um array grande demais pra String.fromCharCode
// de uma vez (ex.: o index.json inteiro, ~190KB) estoura a pilha do JS.
function utf8ToBase64(str) {
  const bytes = new TextEncoder().encode(str);
  let binary = "";
  const chunkSize = 0x8000;
  for (let i = 0; i < bytes.length; i += chunkSize) {
    binary += String.fromCharCode.apply(null, bytes.subarray(i, i + chunkSize));
  }
  return btoa(binary);
}
function base64ToUtf8(b64) {
  return new TextDecoder().decode(Uint8Array.from(atob(b64), (c) => c.charCodeAt(0)));
}

async function ghRequest(path, options = {}) {
  const token = getGhToken();
  const res = await fetch(`https://api.github.com/repos/${GH_OWNER}/${GH_REPO}/contents/${path}`, {
    ...options,
    // "no-store": sem isso o navegador pode responder a leitura do sha
    // com uma resposta em cache (a API do GitHub permite cache por um
    // tempo), e ai o "busca fresco antes de gravar" nao adianta nada —
    // continua achando que o sha antigo e o atual, mesmo repetindo.
    cache: "no-store",
    headers: {
      Authorization: `Bearer ${token}`,
      Accept: "application/vnd.github+json",
      ...(options.headers || {}),
    },
  });
  return res;
}

// Le um arquivo do repo. Retorna {text, sha} ou null se nao existir (404).
async function ghGetFile(path) {
  const res = await ghRequest(`${path}?ref=${GH_BRANCH}`);
  if (res.status === 404) return null;
  if (res.status === 401) throw new Error("Token do GitHub invalido ou expirado.");
  if (!res.ok) throw new Error(`GitHub respondeu ${res.status} ao ler ${path}`);
  const data = await res.json();
  return { text: base64ToUtf8(data.content.replace(/\n/g, "")), sha: data.sha };
}

// Cria ou atualiza um arquivo (precisa do sha atual se o arquivo ja existe).
async function ghPutFile(path, text, message, sha) {
  const res = await ghRequest(path, {
    method: "PUT",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      message,
      content: utf8ToBase64(text),
      branch: GH_BRANCH,
      ...(sha ? { sha } : {}),
    }),
  });
  if (res.status === 409 || res.status === 422) {
    const errBody = await res.json().catch(() => ({}));
    const rawMsg = errBody.message || `status ${res.status}`;
    // So e um conflito de versao de verdade se o GitHub falar de "sha" na
    // mensagem — um 422 tambem pode ser outro problema (ex.: codificacao,
    // branch invalido), e nesses casos repetir a gravacao so vai falhar
    // igual 3x e esconder o motivo real.
    const err = new Error(rawMsg);
    err.isShaConflict = /sha/i.test(rawMsg);
    throw err;
  }
  if (!res.ok) {
    const errBody = await res.json().catch(() => ({}));
    throw new Error(`Falha ao gravar ${path} no GitHub: ${errBody.message || res.status}`);
  }
  const data = await res.json();
  return data.content.sha;
}

function sleep(ms) { return new Promise((resolve) => setTimeout(resolve, ms)); }

// Grava sempre buscando o sha mais recente na hora (em vez de confiar num
// sha guardado em memoria, que pode estar desatualizado — por exemplo se
// outro aparelho gravou antes, ou se uma tentativa anterior deu erro no
// meio do caminho). Se mesmo assim bater um conflito de versao (dois
// gravamentos quase simultaneos, ou a API do GitHub demorando a propagar
// o commit anterior), espera um pouco e tenta de novo, ate 5 vezes.
async function ghPutFileFresh(path, text, message, attempt = 1) {
  const current = await ghGetFile(path);
  try {
    return await ghPutFile(path, text, message, current ? current.sha : undefined);
  } catch (err) {
    if (err.isShaConflict && attempt < 5) {
      await sleep(400 * attempt);
      return ghPutFileFresh(path, text, message, attempt + 1);
    }
    throw new Error(`Conflito ao gravar ${path} no GitHub (${err.message}).`);
  }
}

// ---------------------------------------------------------------------
// Dados: index.json e cards/*.md — via GitHub se houver token, senao
// cai no modo local de teste (fetch relativo, so em desenvolvimento).
// ---------------------------------------------------------------------

async function loadIndex() {
  if (getGhToken()) {
    const file = await ghGetFile("index.json");
    if (!file) throw new Error("index.json nao encontrado no repositorio aacm-recall-data.");
    state.indexSha = file.sha;
    return JSON.parse(file.text);
  }
  const res = await fetch(`${DATA_BASE}/index.json`);
  if (!res.ok) throw new Error("Nao consegui carregar data/index.json (modo local)");
  return res.json();
}

async function saveIndex() {
  const text = JSON.stringify(state.index, null, 2);
  state.indexSha = await ghPutFileFresh("index.json", text, "Atualiza index.json");
}

async function ghDeleteFile(path, sha, message) {
  const res = await ghRequest(path, {
    method: "DELETE",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ message, sha, branch: GH_BRANCH }),
  });
  if (!res.ok) {
    const errBody = await res.json().catch(() => ({}));
    throw new Error(`Falha ao excluir ${path} no GitHub: ${errBody.message || res.status}`);
  }
}

// Exclui o card de vez: apaga cards/<slug>.md no GitHub (se houver token)
// e tira do index.json, alem de limpar qualquer rascunho/cache local.
async function deleteCard(slug) {
  const idx = state.index.findIndex((c) => c.slug === slug);
  if (idx === -1) return;
  const card = state.index[idx];

  if (getGhToken()) {
    const file = await ghGetFile(`cards/${slug}.md`);
    if (file) await ghDeleteFile(`cards/${slug}.md`, file.sha, `Exclui: ${card.title}`);
    state.index.splice(idx, 1);
    await saveIndex();
  } else {
    state.index.splice(idx, 1);
  }

  delete state.overrides[slug];
  saveJSON("aacm-overrides", state.overrides);
  delete state.bodyCache[slug];
  delete state.cardShas[slug];
  state.termIndexCache = null;
}

async function loadCardBody(slug) {
  if (state.bodyCache[slug]) return state.bodyCache[slug];

  let raw;
  if (getGhToken()) {
    const file = await ghGetFile(`cards/${slug}.md`);
    if (!file) throw new Error(`Card ${slug} nao encontrado no GitHub.`);
    state.cardShas[slug] = file.sha;
    raw = file.text;
  } else {
    const res = await fetch(`${DATA_BASE}/cards/${slug}.md`);
    if (!res.ok) throw new Error(`Nao consegui carregar o card ${slug}`);
    raw = await res.text();
  }

  const parsed = parseCardFile(raw);
  state.bodyCache[slug] = parsed;
  return parsed;
}

// Grava o card de volta no GitHub, reconstruindo o arquivo inteiro
// (frontmatter + conteudo). So entra em acao quando ha token configurado.
async function saveCardToGitHub(slug, content) {
  const card = state.index.find((c) => c.slug === slug);
  if (!card) throw new Error("Card nao encontrado no indice.");

  card.updated = new Date().toISOString();
  card.bracket_terms = extractBracketTerms(content);
  state.termIndexCache = null;
  // Se o card estava "pendente" e agora ganhou conteudo de verdade,
  // tira o selo de pendente (edicao manual conta como "resumido").
  if (card.status === "pendente" && content.trim()) card.status = "resumido";

  const fm = [
    "---",
    `title: "${(card.title || "").replace(/"/g, '\\"')}"`,
    `url: "${card.url || ""}"`,
    `source: "${card.source || ""}"`,
    "tags:",
    ...(card.tags.length ? card.tags.map((t) => `  - "${t}"`) : []),
    `thumbnail: "${card.thumbnail || ""}"`,
    "attachments:",
    ...(card.attachments || []).map((a) => `  - "${a}"`),
    `created: "${card.created || ""}"`,
    `updated: "${card.updated}"`,
    `status: "${card.status || "resumido"}"`,
    "---",
    "",
    "## Content",
    content.trim(),
    "",
  ].join("\n");

  const newSha = await ghPutFileFresh(`cards/${slug}.md`, fm, `Editar: ${card.title}`);
  state.cardShas[slug] = newSha;
  state.bodyCache[slug] = parseCardFile(fm);
  await saveIndex();
}

function parseCardFile(raw) {
  let body = raw;
  if (raw.startsWith("---")) {
    const end = raw.indexOf("\n---", 3);
    if (end !== -1) body = raw.slice(end + 4).replace(/^\n+/, "");
  }
  const contentIdx = body.indexOf("## Content");
  if (contentIdx !== -1) {
    return { summaryMd: body.slice(contentIdx + "## Content".length).trim(), notesMd: "" };
  }

  const summaryIdx = body.indexOf("## Summary");
  const notesIdx = body.indexOf("## My notes");

  let summaryMd = "";
  let notesMd = "";

  if (summaryIdx !== -1) {
    const summaryEnd = notesIdx !== -1 ? notesIdx : body.length;
    summaryMd = body.slice(summaryIdx + "## Summary".length, summaryEnd).trim();
  }
  if (notesIdx !== -1) {
    notesMd = body.slice(notesIdx + "## My notes".length).trim();
  }
  return { summaryMd, notesMd };
}

// ---------------------------------------------------------------------
// Mini renderizador de Markdown
// ---------------------------------------------------------------------

function escapeHtml(s) {
  return s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
}
function escapeAttr(s) {
  return escapeHtml(s).replace(/"/g, "&quot;");
}

function renderInline(text, titleToSlug) {
  let out = escapeHtml(text);

  out = out.replace(/\[\[([^\]|]+)(?:\|([^\]]+))\]\]|\[\[([^\]]+)\]\]/g, (m, a, alias, b) => {
    const target = (a || b || "").trim();
    const label = (alias || target).trim();
    const slug = titleToSlug.get(target.toLowerCase());
    const termAttr = `data-term="${escapeAttr(target)}"`;
    if (slug) return `<a href="#card/${slug}" class="wikilink" data-nav="${slug}" ${termAttr}>${label}</a>`;
    return `<span class="wikilink" ${termAttr}>${label}</span>`;
  });

  out = out.replace(/\[([^\]]+)\]\((https?:\/\/[^\s)]+)\)/g, (m, label, url) => {
    return `<a href="${url}" target="_blank" rel="noopener">${label}</a>`;
  });

  out = out.replace(/\*\*([^*]+)\*\*/g, "<strong>$1</strong>");
  out = out.replace(/==([^=]+)==/g, "<mark>$1</mark>");

  return out;
}

function renderMarkdown(md, titleToSlug) {
  const lines = md.split("\n");
  let html = "";
  let inList = false;
  const closeList = () => { if (inList) { html += "</ul>"; inList = false; } };

  for (const line of lines) {
    const t = line.trim();
    if (!t) { closeList(); continue; }
    if (t.startsWith("### ")) { closeList(); html += `<h3>${renderInline(t.slice(4), titleToSlug)}</h3>`; }
    else if (t.startsWith("## ")) { closeList(); html += `<h2>${renderInline(t.slice(3), titleToSlug)}</h2>`; }
    else if (/^[-*]\s+/.test(t)) {
      if (!inList) { html += "<ul>"; inList = true; }
      html += `<li>${renderInline(t.replace(/^[-*]\s+/, ""), titleToSlug)}</li>`;
    } else { closeList(); html += `<p>${renderInline(t, titleToSlug)}</p>`; }
  }
  closeList();
  return html;
}

// ---------------------------------------------------------------------
// Icones inline (sem dependencia externa)
// ---------------------------------------------------------------------

const ICONS = {
  home: `<svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M3 11.5 12 4l9 7.5"/><path d="M5 10v9a1 1 0 0 0 1 1h4v-6h4v6h4a1 1 0 0 0 1-1v-9"/></svg>`,
  filter: `<svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M4 5h16M7 12h10M10 19h4"/></svg>`,
  sort: `<svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M3 7h12M3 12h8M3 17h4M17 4v16m0 0 4-4m-4 4-4-4"/></svg>`,
  pencil: `<svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M12 20h9"/><path d="M16.5 3.5a2.1 2.1 0 0 1 3 3L7 19l-4 1 1-4Z"/></svg>`,
  trash: `<svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M3 6h18M8 6V4a2 2 0 0 1 2-2h4a2 2 0 0 1 2 2v2m3 0-1 14a2 2 0 0 1-2 2H7a2 2 0 0 1-2-2L4 6h16Z"/></svg>`,
  plus: `<svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5" stroke-linecap="round"><path d="M12 5v14M5 12h14"/></svg>`,
};

// ---------------------------------------------------------------------
// Render: sidebar de tags
// ---------------------------------------------------------------------

function renderSidebar() {
  const counts = new Map();
  for (const t of state.customTags) counts.set(t, counts.get(t) || 0);
  for (const card of state.index) {
    for (const tag of getEffectiveTags(card)) counts.set(tag, (counts.get(tag) || 0) + 1);
  }
  const tags = [...counts.keys()].sort(
    (a, b) => TAG_ORDER_HINT(a) - TAG_ORDER_HINT(b) || a.localeCompare(b)
  );

  const list = document.getElementById("tagList");
  list.innerHTML = "";

  const allItem = document.createElement("li");
  allItem.className = "tag-item" + (state.filters.tags.size === 0 ? " active" : "");
  allItem.innerHTML = `<span>🏠 Home</span><span class="count">${state.index.length}</span>`;
  allItem.onclick = () => { state.filters.tags = new Set(); navigate({ view: "home" }); };
  list.appendChild(allItem);

  for (const tag of tags) {
    const li = document.createElement("li");
    const active = state.filters.tags.size === 1 && state.filters.tags.has(tag);
    li.className = "tag-item" + (active ? " active" : "");
    li.innerHTML = `<span>${escapeHtml(tag)}</span><span class="count">${counts.get(tag)}</span>`;
    li.onclick = () => { state.filters.tags = new Set([tag]); navigate({ view: "home" }); };
    list.appendChild(li);
  }

  const newTagBtn = document.createElement("li");
  newTagBtn.className = "tag-item tag-item-new";
  newTagBtn.innerHTML = `<span>${ICONS.plus} Nova tag</span>`;
  newTagBtn.onclick = () => promptNewTag();
  list.appendChild(newTagBtn);
}

function promptNewTag() {
  const name = prompt("Nome da nova tag (ex.: 10. FINANÇAS 💰):");
  if (!name || !name.trim()) return;
  const clean = name.trim();
  if (!state.customTags.includes(clean)) {
    state.customTags.push(clean);
    saveJSON("aacm-custom-tags", state.customTags);
  }
  render();
}

// ---------------------------------------------------------------------
// Filtros e ordenacao
// ---------------------------------------------------------------------

function dateKey(iso) { return iso ? iso.slice(0, 10) : "0000-00-00"; }

function getFilteredSortedCards() {
  let cards = state.index.map((c) => ({ ...c, tags: getEffectiveTags(c) }));

  if (state.filters.tags.size) {
    cards = cards.filter((c) => c.tags.some((t) => state.filters.tags.has(t)));
  }
  if (state.filters.sources.size) {
    cards = cards.filter((c) => state.filters.sources.has(c.source));
  }
  if (state.filters.dateFrom) cards = cards.filter((c) => dateKey(c.created) >= state.filters.dateFrom);
  if (state.filters.dateTo) cards = cards.filter((c) => dateKey(c.created) <= state.filters.dateTo);

  if (state.query.trim()) {
    const q = state.query.trim().toLowerCase();
    cards = cards.filter(
      (c) =>
        c.title.toLowerCase().includes(q) ||
        (c.source || "").toLowerCase().includes(q) ||
        c.tags.some((t) => t.toLowerCase().includes(q))
    );
  }

  const dir = state.sort.dir === "asc" ? 1 : -1;
  cards.sort((a, b) => {
    let av, bv;
    switch (state.sort.by) {
      case "updated": av = a.updated; bv = b.updated; break;
      case "title": av = a.title.toLowerCase(); bv = b.title.toLowerCase(); break;
      case "connections":
        av = (a.links_to?.length || 0) + (a.linked_from?.length || 0);
        bv = (b.links_to?.length || 0) + (b.linked_from?.length || 0);
        break;
      default: av = a.created; bv = b.created;
    }
    if (av < bv) return -1 * dir;
    if (av > bv) return 1 * dir;
    return 0;
  });

  return cards;
}

function startOfWeek(d) {
  const day = (d.getDay() + 6) % 7;
  const r = new Date(d);
  r.setDate(d.getDate() - day);
  r.setHours(0, 0, 0, 0);
  return r;
}

function groupCards(cards) {
  if (state.sort.groupBy === "none") return [{ heading: null, items: cards }];

  const groups = [];
  const indexBySlug = new Map();

  for (const card of cards) {
    const d = card.created ? new Date(card.created) : null;
    let key, heading;
    if (!d || isNaN(d)) { key = "sem-data"; heading = "Sem data"; }
    else if (state.sort.groupBy === "day") {
      key = dateKey(card.created);
      heading = d.toLocaleDateString("pt-BR", { day: "2-digit", month: "long", year: "numeric" });
    } else if (state.sort.groupBy === "week") {
      const sow = startOfWeek(d);
      key = sow.toISOString().slice(0, 10);
      heading = "Semana de " + sow.toLocaleDateString("pt-BR", { day: "2-digit", month: "long" });
    } else {
      key = d.toISOString().slice(0, 7);
      heading = d.toLocaleDateString("pt-BR", { month: "long", year: "numeric" });
      heading = heading.charAt(0).toUpperCase() + heading.slice(1);
    }
    if (!indexBySlug.has(key)) {
      indexBySlug.set(key, { heading, items: [] });
      groups.push(indexBySlug.get(key));
    }
    indexBySlug.get(key).items.push(card);
  }
  return groups;
}

// ---------------------------------------------------------------------
// Render: Home
// ---------------------------------------------------------------------

function faviconFor(source) {
  return source ? `https://www.google.com/s2/favicons?sz=32&domain=${source}` : null;
}

function iconForTags(tags) {
  const t = (tags[0] || "").toLowerCase();
  if (t.includes("youtube")) return "🎥";
  if (t.includes("article")) return "📑";
  if (t.includes("news")) return "📰";
  if (t.includes("book")) return "📚";
  if (t.includes("automotive")) return "🚗";
  if (t.includes("persona")) return "👥";
  if (t.includes("print")) return "🖼️";
  if (t.includes("philosophy")) return "📖";
  if (t.includes("health")) return "💪";
  if (t.includes("personal")) return "📝";
  return "📄";
}

function cardTile(card) {
  const thumbHtml = card.thumbnail
    ? `<div class="card-thumb" style="background-image:url('${card.thumbnail}')"></div>`
    : `<div class="card-thumb">${iconForTags(card.tags)}</div>`;

  const fav = faviconFor(card.source);
  const sourceHtml = card.source
    ? `${fav ? `<img src="${fav}" width="14" height="14" style="border-radius:3px" />` : ""}<span>${card.source}</span>`
    : "<span>Nota pessoal</span>";

  const pendingBadge = card.status === "pendente" ? `<span class="pending-badge">⏳ pendente</span>` : "";

  return `
    <div class="card" data-nav="${card.slug}">
      ${thumbHtml}
      <div class="card-body">
        <div class="card-title">${escapeHtml(card.title)}</div>
        <div class="card-source">${sourceHtml}</div>
        <div style="display:flex; align-items:center; gap:8px; margin-top:auto;">
          <span class="tag-chip">${escapeHtml(card.tags[0] || "Untagged")}</span>
          ${pendingBadge}
        </div>
      </div>
    </div>`;
}

function renderHome() {
  const content = document.getElementById("content");
  const cards = getFilteredSortedCards();

  if (cards.length === 0) {
    content.innerHTML = `<div class="empty-state">Nenhum card encontrado com esses filtros.</div>`;
    return;
  }

  const groups = groupCards(cards);
  let html = "";
  for (const g of groups) {
    if (g.heading) html += `<div class="date-heading">${g.heading}</div>`;
    html += `<div class="grid">${g.items.map(cardTile).join("")}</div>`;
  }
  content.innerHTML = html;

  content.querySelectorAll("[data-nav]").forEach((el) => {
    el.addEventListener("click", () => navigate({ view: "card", slug: el.dataset.nav }));
  });
}

// ---------------------------------------------------------------------
// Render: Card detail
// ---------------------------------------------------------------------

function tagChipsHtml(card) {
  return card.tags
    .map(
      (t) => `
      <span class="tag-chip tag-chip-editable" data-tag="${escapeHtml(t)}">
        ${escapeHtml(t)}
        <span class="tag-actions">
          <button class="tag-action-btn" data-action="rename-tag" data-tag="${escapeHtml(t)}" title="Editar tag">${ICONS.pencil}</button>
          <button class="tag-action-btn" data-action="remove-tag" data-tag="${escapeHtml(t)}" title="Remover tag">${ICONS.trash}</button>
        </span>
      </span>`
    )
    .join("") + `<button class="tag-chip tag-chip-add" id="addTagBtn" title="Adicionar tag">${ICONS.plus}</button>`;
}

async function renderCardDetail(slug) {
  const card = state.index.find((c) => c.slug === slug);
  const content = document.getElementById("content");
  if (!card) { content.innerHTML = `<div class="empty-state">Card nao encontrado.</div>`; return; }

  content.innerHTML = `<div class="empty-state">Carregando…</div>`;
  const body = await loadCardBody(slug);
  const effectiveCard = { ...card, tags: getEffectiveTags(card) };
  const titleToSlug = new Map(state.index.map((c) => [c.title.toLowerCase(), c.slug]));

  const thumbHtml = card.thumbnail
    ? `<div class="detail-thumb" style="background-image:url('${card.thumbnail}')"></div>`
    : "";

  const attachmentsHtml = (card.attachments || [])
    .map((path) => {
      const name = path.split("/").pop();
      return `<a class="attachment-chip" href="${DATA_BASE}/${path}" target="_blank">📎 ${escapeHtml(name)}</a>`;
    })
    .join("");

  const connectedSlugs = [...new Set([...(card.links_to || []), ...(card.linked_from || [])])];
  const connectionsHtml = connectedSlugs.length
    ? `<div class="connections-list">${connectedSlugs
        .map((s) => {
          const c2 = state.index.find((c) => c.slug === s);
          return c2 ? `<a href="#card/${s}" data-nav="${s}">↔ ${escapeHtml(c2.title)}</a>` : "";
        })
        .join("")}</div>`
    : `<div class="empty-state" style="padding:20px 0;">Nenhuma conexao ainda. Use [[Titulo de outro card]] no conteudo.</div>`;

  const effectiveContent = getEffectiveContent(card, body);

  content.innerHTML = `
    <div class="detail">
      <button class="icon-btn detail-home" data-nav="home" title="Voltar para a Home">${ICONS.home}</button>
      ${thumbHtml}
      <div class="detail-title-row">
        <h1 class="detail-title" id="detailTitle">${escapeHtml(card.title)}</h1>
        <button class="icon-btn" id="editTitleBtn" title="Editar titulo">${ICONS.pencil}</button>
      </div>
      <div class="detail-meta">
        ${card.url ? `<a href="${card.url}" target="_blank" rel="noopener">🔗 ${card.source || card.url}</a>` : ""}
        ${tagChipsHtml(effectiveCard)}
      </div>

      <div class="tabs">
        <div class="tab active" data-tab="notebook">Notebook</div>
        <div class="tab" data-tab="connections">Connections ${connectedSlugs.length ? `(${connectedSlugs.length})` : ""}</div>
        <div class="tab" data-tab="ask">Ask ✨</div>
      </div>

      <div class="tab-panel" data-panel="notebook">
        <div class="panel-toolbar">
          <button class="btn-ghost" id="editBtn">${ICONS.pencil} Editar</button>
          <button class="btn-ghost btn-danger" id="deleteCardBtn">${ICONS.trash} Excluir</button>
          <span id="savedHint" class="saved-hint"></span>
        </div>
        <div id="prose" class="prose">${renderMarkdown(effectiveContent || "_Sem conteudo ainda._", titleToSlug)}</div>
        <div id="editWrap" style="display:none;">
          <div class="edit-toolbar">
            <button type="button" id="boldBtn" title="Negrito"><strong>B</strong></button>
            <button type="button" id="highlightBtn" title="Destacar em amarelo">🖍️ Highlight</button>
            <button type="button" id="wikilinkBtn" title="Conectar com outro card">[[ ]]</button>
          </div>
          <textarea id="contentArea" placeholder="Conteudo em Markdown. Use [[Titulo]] para conectar com outro card.">${escapeHtml(effectiveContent)}</textarea>
        </div>

        ${attachmentsHtml ? `<div class="attachments">${attachmentsHtml}</div>` : ""}
      </div>

      <div class="tab-panel" data-panel="connections" style="display:none;">
        ${connectionsHtml}
      </div>

      <div class="tab-panel" data-panel="ask" style="display:none;">
        <div id="askPanel"></div>
      </div>
    </div>
  `;

  wireCardDetailEvents(slug, card, effectiveCard);
  wireWikilinkPreviews(content.querySelector("#prose"), slug);
}

// ---------------------------------------------------------------------
// Preview ao passar o mouse num [[termo]]: mostra os OUTROS cards que
// usam esse mesmo termo entre colchetes — "cards em comum", nao o card
// cujo titulo bate com o termo.
// ---------------------------------------------------------------------

let wikilinkHideTimer = null;

function wireWikilinkPreviews(container, currentSlug) {
  if (!container) return;
  container.querySelectorAll(".wikilink").forEach((el) => {
    el.addEventListener("mouseenter", () => {
      clearTimeout(wikilinkHideTimer);
      showWikilinkPreview(el, currentSlug);
    });
    el.addEventListener("mouseleave", scheduleHideWikilinkPreview);
  });
}

// Da um "respiro" antes de fechar, pra dar tempo do mouse atravessar do
// termo ate a caixinha (que fica logo abaixo) sem ela sumir no caminho.
function scheduleHideWikilinkPreview() {
  clearTimeout(wikilinkHideTimer);
  wikilinkHideTimer = setTimeout(hideWikilinkPreview, 250);
}

function hideWikilinkPreview() {
  document.getElementById("wikilinkPop")?.remove();
}

function showWikilinkPreview(el, currentSlug) {
  hideWikilinkPreview();
  const term = el.dataset.term;
  if (!term) return;

  const termIndex = buildTermIndex();
  const slugs = [...(termIndex.get(normalizeTerm(term)) || [])].filter((s) => s !== currentSlug);
  const commonCards = slugs.map((s) => state.index.find((c) => c.slug === s)).filter(Boolean);

  let html = `<div class="wikilink-pop-title">[[${escapeHtml(term)}]]</div>`;
  if (commonCards.length) {
    html += `<div class="wikilink-pop-sub">Tambem aparece em ${commonCards.length} card${commonCards.length > 1 ? "s" : ""}:</div><ul class="wikilink-pop-list">`;
    html += commonCards.slice(0, 6).map((c) => `<li data-nav="${c.slug}">${escapeHtml(c.title)}</li>`).join("");
    html += `</ul>`;
    if (commonCards.length > 6) html += `<div class="wikilink-pop-more">+${commonCards.length - 6} mais</div>`;
  } else {
    html += `<div class="wikilink-pop-sub">Nenhum outro card usa esse termo ainda.</div>`;
  }

  const pop = document.createElement("div");
  pop.id = "wikilinkPop";
  pop.className = "wikilink-pop";
  pop.innerHTML = html;
  document.body.appendChild(pop);

  const rect = el.getBoundingClientRect();
  pop.style.left = Math.min(rect.left, window.innerWidth - 260) + "px";
  pop.style.top = rect.bottom + 6 + "px";

  // Enquanto o mouse estiver em cima da propria caixinha, ela fica aberta.
  pop.addEventListener("mouseenter", () => clearTimeout(wikilinkHideTimer));
  pop.addEventListener("mouseleave", scheduleHideWikilinkPreview);

  pop.querySelectorAll("li[data-nav]").forEach((li) => {
    li.addEventListener("click", () => {
      hideWikilinkPreview();
      navigate({ view: "card", slug: li.dataset.nav });
    });
  });
}

function wireCardDetailEvents(slug, card, effectiveCard) {
  const content = document.getElementById("content");

  content.querySelector('[data-nav="home"]').addEventListener("click", () => navigate({ view: "home" }));
  content.querySelectorAll("[data-nav]:not([data-nav='home'])").forEach((el) => {
    el.addEventListener("click", (e) => { e.preventDefault(); navigate({ view: "card", slug: el.dataset.nav }); });
  });

  content.querySelectorAll(".tab").forEach((tabEl) => {
    tabEl.addEventListener("click", () => {
      content.querySelectorAll(".tab").forEach((t) => t.classList.remove("active"));
      tabEl.classList.add("active");
      const target = tabEl.dataset.tab;
      content.querySelectorAll(".tab-panel").forEach((p) => { p.style.display = p.dataset.panel === target ? "" : "none"; });
      if (target === "ask" && !content.querySelector("#askPanel").dataset.inited) {
        initAskPanel(slug, card);
      }
    });
  });

  const deleteCardBtn = content.querySelector("#deleteCardBtn");
  deleteCardBtn.addEventListener("click", async () => {
    if (!confirm(`Excluir definitivamente o card "${card.title}"?\n\nIsso remove o arquivo do GitHub tambem — nao da pra desfazer.`)) return;
    deleteCardBtn.disabled = true;
    deleteCardBtn.innerHTML = "Excluindo…";
    try {
      await deleteCard(slug);
      navigate({ view: "home" });
    } catch (err) {
      alert("Nao consegui excluir: " + err.message);
      deleteCardBtn.disabled = false;
      deleteCardBtn.innerHTML = `${ICONS.trash} Excluir`;
    }
  });

  // ---- editar titulo ----
  async function applyTitleChange(newTitle) {
    card.title = newTitle;
    render();
    if (getGhToken()) {
      try { await syncCardToGitHub(slug); }
      catch (err) { alert("O titulo ficou salvo so neste navegador — nao sincronizou com o GitHub:\n" + err.message); }
    }
  }

  const detailTitle = content.querySelector("#detailTitle");
  const editTitleBtn = content.querySelector("#editTitleBtn");
  editTitleBtn.addEventListener("click", () => {
    const input = document.createElement("input");
    input.className = "detail-title-input";
    input.value = card.title;
    detailTitle.replaceWith(input);
    editTitleBtn.style.display = "none";
    input.focus();
    input.select();

    let done = false;
    function commit() {
      if (done) return;
      done = true;
      const val = input.value.trim();
      if (!val || val === card.title) { render(); return; }
      applyTitleChange(val);
    }
    input.addEventListener("keydown", (e) => {
      if (e.key === "Enter") { e.preventDefault(); input.blur(); }
      if (e.key === "Escape") { done = true; render(); }
    });
    input.addEventListener("blur", commit);
  });

  // ---- editar conteudo ----
  const prose = content.querySelector("#prose");
  const editWrap = content.querySelector("#editWrap");
  const editBtn = content.querySelector("#editBtn");
  const textarea = content.querySelector("#contentArea");
  const savedHint = content.querySelector("#savedHint");

  let outsideClickHandler = null;
  editBtn.addEventListener("click", () => {
    prose.style.display = "none";
    editWrap.style.display = "";
    editBtn.style.display = "none";
    textarea.focus();

    // Nao precisa de botao "Salvar/Concluir": clicar fora do editor
    // (em qualquer lugar da pagina) fecha e volta pra leitura — o
    // conteudo ja foi salvo pelo autosave enquanto voce digitava.
    outsideClickHandler = (e) => {
      if (!editWrap.contains(e.target)) {
        document.removeEventListener("mousedown", outsideClickHandler);
        closeEditor();
      }
    };
    document.addEventListener("mousedown", outsideClickHandler);
  });

  function wrapSelection(before, after) {
    const start = textarea.selectionStart, end = textarea.selectionEnd;
    const val = textarea.value;
    const scrollPos = textarea.scrollTop;
    const selected = val.slice(start, end) || "texto";
    const inserted = before + selected + after;

    textarea.focus();
    textarea.setSelectionRange(start, end);
    // execCommand faz uma edicao "nativa" (mantem undo e nao reseta o
    // scroll do campo, ao contrario de reatribuir .value inteiro).
    const usedExecCommand =
      document.execCommand && document.execCommand("insertText", false, inserted);
    if (!usedExecCommand) {
      textarea.value = val.slice(0, start) + inserted + val.slice(end);
      const newStart = start + before.length;
      textarea.selectionStart = newStart;
      textarea.selectionEnd = newStart + selected.length;
    } else {
      const newStart = start + before.length;
      textarea.setSelectionRange(newStart, newStart + selected.length);
    }
    // Restaura o scroll depois que o navegador tentar "seguir" a selecao
    // (esse ajuste acontece depois do fluxo sincrono, por isso o rAF).
    requestAnimationFrame(() => { textarea.scrollTop = scrollPos; });
  }
  content.querySelector("#boldBtn").addEventListener("click", () => wrapSelection("**", "**"));
  content.querySelector("#highlightBtn").addEventListener("click", () => wrapSelection("==", "=="));
  content.querySelector("#wikilinkBtn").addEventListener("click", () => wrapSelection("[[", "]]"));

  // Salvamento automatico: grava (local, por enquanto) 600ms depois que
  // voce para de digitar — sem precisar de um botao "Salvar". O aviso
  // "Salvando..." so atualiza nesse timer tambem (nao a cada letra), pra
  // nao ficar mudando o texto da tela toda hora e empurrando o scroll.
  let autosaveTimer = null;
  textarea.addEventListener("input", () => {
    clearTimeout(autosaveTimer);
    autosaveTimer = setTimeout(() => {
      savedHint.textContent = "Salvando…";
      setCardContent(slug, textarea.value);
      savedHint.textContent = "✅ Salvo automaticamente neste navegador";
      setTimeout(() => (savedHint.textContent = ""), 2500);
    }, 600);
  });

  async function closeEditor() {
    clearTimeout(autosaveTimer);
    setCardContent(slug, textarea.value); // garante que a ultima letra digitada tambem foi salva
    const titleToSlug = new Map(state.index.map((c) => [c.title.toLowerCase(), c.slug]));
    prose.innerHTML = renderMarkdown(textarea.value, titleToSlug);
    editWrap.style.display = "none"; prose.style.display = ""; editBtn.style.display = "";
    wireWikilinkPreviews(prose, slug);

    if (getGhToken()) {
      savedHint.textContent = "☁️ Sincronizando com o GitHub…";
      try {
        await syncCardToGitHub(slug);
        savedHint.textContent = "☁️ Sincronizado com o GitHub";
        setTimeout(() => (savedHint.textContent = ""), 3000);
      } catch (err) {
        savedHint.textContent = "⚠️ Nao sincronizou (ficou salvo so neste navegador): " + err.message;
      }
    } else {
      savedHint.textContent = "✅ Salvo neste navegador (sem GitHub conectado)";
      setTimeout(() => (savedHint.textContent = ""), 3000);
    }
  }

  // ---- tags: editar/excluir (hover) + adicionar ----
  async function applyTagChange(tags) {
    setCardTags(slug, tags);
    render();
    if (getGhToken()) {
      try { await syncCardToGitHub(slug); }
      catch (err) { alert("As tags ficaram salvas so neste navegador — nao sincronizaram com o GitHub:\n" + err.message); }
    }
  }

  content.querySelectorAll('[data-action="rename-tag"]').forEach((btn) => {
    btn.addEventListener("click", (e) => {
      e.stopPropagation();
      const old = btn.dataset.tag;
      const name = prompt("Novo nome da tag:", old);
      if (!name || !name.trim() || name === old) return;
      applyTagChange(getEffectiveTags(card).map((t) => (t === old ? name.trim() : t)));
    });
  });
  content.querySelectorAll('[data-action="remove-tag"]').forEach((btn) => {
    btn.addEventListener("click", (e) => {
      e.stopPropagation();
      const tag = btn.dataset.tag;
      if (!confirm(`Remover a tag "${tag}" deste card?`)) return;
      applyTagChange(getEffectiveTags(card).filter((t) => t !== tag));
    });
  });
  const addTagBtn = content.querySelector("#addTagBtn");
  if (addTagBtn) {
    addTagBtn.addEventListener("click", (e) => {
      e.stopPropagation();
      toggleTagPickerDropdown(addTagBtn, card, applyTagChange);
    });
  }
}

// ---------------------------------------------------------------------
// Ask: chat dentro do card (Gemini — nivel gratuito)
// ---------------------------------------------------------------------

function getGeminiKey() { return localStorage.getItem("aacm-gemini-key") || ""; }
function setGeminiKey(k) { localStorage.setItem("aacm-gemini-key", k); }

function initAskPanel(slug, card) {
  const panel = document.getElementById("askPanel");
  panel.dataset.inited = "1";
  const hasKey = !!getGeminiKey();

  panel.innerHTML = `
    ${!hasKey ? `
      <div class="ask-setup">
        <p>Para perguntar dentro do card, cole sua chave gratuita do Gemini (Google AI Studio).</p>
        <input id="geminiKeyInput" placeholder="Cole a chave do Gemini aqui" />
        <button class="btn-add" id="saveKeyBtn">Salvar chave</button>
        <p class="hint">Crie em <a href="https://aistudio.google.com/apikey" target="_blank">aistudio.google.com/apikey</a> — grátis, sem cartão. A chave fica só no seu navegador.</p>
      </div>` : `
      <div class="ask-scope">
        <label><input type="radio" name="askScope" value="card" checked /> Só este card</label>
        <label><input type="radio" name="askScope" value="base" /> Toda a sua base</label>
      </div>
      <div class="ask-messages" id="askMessages"></div>
      <div class="ask-input-row">
        <input id="askInput" placeholder="Pergunte algo..." />
        <button class="btn-add" id="askSendBtn">Enviar</button>
      </div>
    `}
  `;

  if (!hasKey) {
    panel.querySelector("#saveKeyBtn").addEventListener("click", () => {
      const v = panel.querySelector("#geminiKeyInput").value.trim();
      if (!v) return;
      setGeminiKey(v);
      panel.dataset.inited = "";
      initAskPanel(slug, card);
    });
    return;
  }

  const messagesEl = panel.querySelector("#askMessages");
  const inputEl = panel.querySelector("#askInput");
  const sendBtn = panel.querySelector("#askSendBtn");
  const history = [];

  function addBubble(role, text) {
    const div = document.createElement("div");
    div.className = "chat-msg chat-msg-" + role;
    div.textContent = text;
    messagesEl.appendChild(div);
    messagesEl.scrollTop = messagesEl.scrollHeight;
    return div;
  }

  // Acrescenta a pergunta+resposta no final do conteudo do card (Notebook)
  // e sincroniza com o GitHub, igual uma edicao manual faria.
  async function addAnswerToNotebook(question, answer, btn) {
    btn.disabled = true;
    btn.textContent = "Adicionando…";
    try {
      const body = await loadCardBody(slug);
      const current = getEffectiveContent(card, body);
      const block = `**Pergunta (Ask):** ${question}\n\n${answer}`;
      const newContent = (current.trim() ? current.trim() + "\n\n---\n\n" : "") + block;
      setCardContent(slug, newContent);

      // Atualiza a aba Notebook (que esta escondida, nao recarregada) pra
      // nao ficar desatualizada se o usuario trocar de aba depois.
      const titleToSlug = new Map(state.index.map((c) => [c.title.toLowerCase(), c.slug]));
      const prose = document.getElementById("prose");
      const textarea = document.getElementById("contentArea");
      if (prose) prose.innerHTML = renderMarkdown(newContent, titleToSlug);
      if (textarea) textarea.value = newContent;

      if (getGhToken()) {
        btn.textContent = "☁️ Sincronizando…";
        await syncCardToGitHub(slug);
      }
      btn.textContent = "✅ Adicionado ao Notebook";
    } catch (err) {
      btn.disabled = false;
      btn.textContent = "+ Adicionar no Notebook";
      alert("Nao consegui adicionar ao Notebook: " + err.message);
    }
  }

  async function send() {
    const question = inputEl.value.trim();
    if (!question) return;
    inputEl.value = "";
    addBubble("user", question);
    const thinking = document.createElement("div");
    thinking.className = "chat-msg chat-msg-assistant";
    thinking.textContent = "…pensando";
    messagesEl.appendChild(thinking);

    const scope = panel.querySelector('input[name="askScope"]:checked').value;
    try {
      const body = await loadCardBody(slug);
      let context;
      if (scope === "card") {
        context = `Card: "${card.title}"\n\n${getEffectiveContent(card, body)}`;
      } else {
        context = await buildBaseContext(question);
      }
      const answer = await askGemini(context, question, history);
      thinking.remove();
      const bubble = addBubble("assistant", answer);
      const addBtn = document.createElement("button");
      addBtn.className = "btn-ghost ask-add-notebook";
      addBtn.textContent = "+ Adicionar no Notebook";
      addBtn.addEventListener("click", () => addAnswerToNotebook(question, answer, addBtn));
      bubble.appendChild(addBtn);
      messagesEl.scrollTop = messagesEl.scrollHeight;
      history.push({ q: question, a: answer });
    } catch (err) {
      thinking.remove();
      addBubble("assistant", "Erro ao consultar o Gemini: " + err.message);
    }
  }

  sendBtn.addEventListener("click", send);
  inputEl.addEventListener("keydown", (e) => { if (e.key === "Enter") send(); });
}

// Busca simples por palavras-chave na base: pontua pelo titulo + tags do
// indice (rapido, sem baixar nada), pega os ~5 cards mais relevantes e so
// entao busca o conteudo completo deles para montar o contexto real.
async function buildBaseContext(question) {
  const words = question.toLowerCase().split(/\W+/).filter((w) => w.length > 3);
  const scored = state.index
    .map((c) => {
      const hay = (c.title + " " + c.tags.join(" ")).toLowerCase();
      const score = words.reduce((s, w) => s + (hay.includes(w) ? 1 : 0), 0);
      return { c, score };
    })
    .filter((x) => x.score > 0)
    .sort((a, b) => b.score - a.score)
    .slice(0, 5)
    .map((x) => x.c);

  if (scored.length === 0) {
    return "Nenhum card da base bateu com palavras-chave da pergunta. Responda com base no seu conhecimento geral, avisando que nao achou cards relacionados.";
  }

  const blocks = await Promise.all(
    scored.map(async (c) => {
      try {
        const b = await loadCardBody(c.slug);
        return `### ${c.title}\n${getEffectiveContent(c, b)}`;
      } catch (e) {
        return `### ${c.title}\n(nao foi possivel carregar o conteudo)`;
      }
    })
  );
  return blocks.join("\n\n---\n\n");
}

async function askGemini(context, question, history) {
  const key = getGeminiKey();
  const histText = history.map((h) => `Pergunta anterior: ${h.q}\nResposta anterior: ${h.a}`).join("\n\n");
  const prompt =
    `Voce e um assistente dentro de um app pessoal de notas (AACM Recall). ` +
    `Responda em portugues, de forma direta, usando o contexto abaixo quando relevante.\n\n` +
    `CONTEXTO:\n${context}\n\n${histText ? histText + "\n\n" : ""}PERGUNTA: ${question}`;

  const url = `https://generativelanguage.googleapis.com/v1beta/models/${GEMINI_MODEL}:generateContent?key=${encodeURIComponent(key)}`;
  const res = await fetch(url, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ contents: [{ parts: [{ text: prompt }] }] }),
  });
  if (!res.ok) {
    const errText = await res.text();
    throw new Error(`HTTP ${res.status} — ${errText.slice(0, 200)}`);
  }
  const data = await res.json();
  return data?.candidates?.[0]?.content?.parts?.[0]?.text || "(sem resposta)";
}

// ---------------------------------------------------------------------
// Dropdowns: Filter e Sort
// ---------------------------------------------------------------------

function closeDropdowns() {
  document.querySelectorAll(".dropdown-panel").forEach((el) => el.remove());
}

// Painel de filtro em "gaveta": uma tela principal (Date / Source / Tags)
// e cada uma abre a sua propria tela, com busca — igual ao Recall.
// Dropdown pra adicionar tag a um card: lista as tags que ja existem na
// base (igual ao Recall) com busca, em vez de pedir pra digitar o nome
// de cabeca. No fim da lista da pra criar uma tag nova.
function toggleTagPickerDropdown(anchorEl, card, onApply) {
  if (document.querySelector(".dropdown-panel[data-kind='tag-pick']")) { closeDropdowns(); return; }
  closeDropdowns();

  const panel = document.createElement("div");
  panel.className = "dropdown-panel dropdown-panel-filter";
  panel.dataset.kind = "tag-pick";
  positionDropdown(panel, anchorEl);
  document.body.appendChild(panel);

  const current = new Set(getEffectiveTags(card));
  const available = allKnownTags().filter((t) => !current.has(t));

  const renderList = (query) => {
    const q = (query || "").toLowerCase();
    const filtered = available.filter((t) => t.toLowerCase().includes(q));
    return filtered
      .map(
        (t) => `<div class="dropdown-check tag-pick-row" data-tag="${escapeHtml(t)}" style="cursor:pointer;">
          <span class="dropdown-check-label">${escapeHtml(t)}</span>
        </div>`
      )
      .join("") || `<div class="hint" style="padding:10px 0;">Nenhuma tag encontrada</div>`;
  };

  panel.innerHTML = `
    <div class="filter-sub-header">Adicionar tag</div>
    <div class="filter-search"><input type="text" id="tagPickSearch" placeholder="Buscar ou criar tag..." autofocus /></div>
    <div class="dropdown-list filter-sub-list" id="tagPickList">${renderList("")}</div>
    <div class="dropdown-section">
      <button class="btn-ghost" id="tagPickCreate" style="width:100%;text-align:left;">+ Criar e adicionar nova tag</button>
    </div>
  `;

  function wireRows() {
    panel.querySelectorAll(".tag-pick-row").forEach((row) => {
      row.addEventListener("click", () => {
        onApply([...new Set([...getEffectiveTags(card), row.dataset.tag])]);
        closeDropdowns();
      });
    });
  }
  wireRows();

  const searchInput = panel.querySelector("#tagPickSearch");
  searchInput.addEventListener("input", (e) => {
    panel.querySelector("#tagPickList").innerHTML = renderList(e.target.value);
    wireRows();
  });

  function createFromSearch() {
    const name = searchInput.value.trim();
    if (!name) return;
    if (!state.customTags.includes(name)) {
      state.customTags.push(name);
      saveJSON("aacm-custom-tags", state.customTags);
    }
    onApply([...new Set([...getEffectiveTags(card), name])]);
    closeDropdowns();
  }
  panel.querySelector("#tagPickCreate").addEventListener("click", createFromSearch);
  searchInput.addEventListener("keydown", (e) => {
    if (e.key === "Enter") createFromSearch();
  });
}

function toggleFilterDropdown(anchorEl) {
  if (document.querySelector(".dropdown-panel[data-kind='filter']")) { closeDropdowns(); return; }
  closeDropdowns();

  const panel = document.createElement("div");
  panel.className = "dropdown-panel dropdown-panel-filter";
  panel.dataset.kind = "filter";
  positionDropdown(panel, anchorEl);
  document.body.appendChild(panel);

  renderFilterMain(panel);
}

function activeFilterCount(kind) {
  if (kind === "tags") return state.filters.tags.size;
  if (kind === "source") return state.filters.sources.size;
  if (kind === "date") return (state.filters.dateFrom ? 1 : 0) + (state.filters.dateTo ? 1 : 0);
  return 0;
}

function renderFilterMain(panel) {
  const rows = [
    ["date", "📅", "Date"],
    ["source", "🌐", "Source"],
    ["tags", "🏷️", "Tags"],
  ];
  const anyActive =
    state.filters.tags.size || state.filters.sources.size || state.filters.dateFrom || state.filters.dateTo;

  panel.innerHTML = `
    <div class="filter-menu-list">
      ${rows.map(([kind, icon, label]) => {
        const count = activeFilterCount(kind);
        return `
        <div class="filter-menu-row" data-kind="${kind}">
          <span class="filter-menu-icon">${icon}</span>
          <span class="filter-menu-label">${label}</span>
          ${count ? `<span class="filter-menu-count">${count}</span>` : ""}
          <span class="filter-menu-chevron">›</span>
        </div>`;
      }).join("")}
    </div>
    ${anyActive ? `<div class="dropdown-section"><button class="btn-ghost" id="clearFiltersBtn">Limpar filtros</button></div>` : ""}
  `;
  panel.querySelectorAll(".filter-menu-row").forEach((row) => {
    row.addEventListener("click", () => renderFilterSub(panel, row.dataset.kind));
  });
  const clearBtn = panel.querySelector("#clearFiltersBtn");
  if (clearBtn) clearBtn.addEventListener("click", () => {
    state.filters = { tags: new Set(), sources: new Set(), dateFrom: "", dateTo: "" };
    renderFilterMain(panel); renderHome(); renderSidebar();
  });
}

function renderFilterSub(panel, kind) {
  const titles = { date: "Date", source: "Source", tags: "Tags" };

  if (kind === "date") {
    panel.innerHTML = `
      <div class="filter-sub-header"><button class="filter-back" id="filterBack">‹</button> ${titles.date}</div>
      <div class="dropdown-section">
        <div class="dropdown-row">
          <input type="date" id="fDateFrom" value="${state.filters.dateFrom}" />
          <span>até</span>
          <input type="date" id="fDateTo" value="${state.filters.dateTo}" />
        </div>
      </div>
    `;
    panel.querySelector("#fDateFrom").addEventListener("change", (e) => { state.filters.dateFrom = e.target.value; renderHome(); });
    panel.querySelector("#fDateTo").addEventListener("change", (e) => { state.filters.dateTo = e.target.value; renderHome(); });
    panel.querySelector("#filterBack").addEventListener("click", () => renderFilterMain(panel));
    return;
  }

  const isTags = kind === "tags";
  const items = isTags
    ? allKnownTags()
    : [...new Set(state.index.map((c) => c.source).filter(Boolean))].sort();
  const counts = new Map();
  for (const card of state.index) {
    if (isTags) for (const t of getEffectiveTags(card)) counts.set(t, (counts.get(t) || 0) + 1);
    else if (card.source) counts.set(card.source, (counts.get(card.source) || 0) + 1);
  }
  const activeSet = isTags ? state.filters.tags : state.filters.sources;

  const renderList = (query) => {
    const q = (query || "").toLowerCase();
    return items
      .filter((it) => it.toLowerCase().includes(q))
      .map(
        (it) => `
        <label class="dropdown-check">
          <input type="checkbox" value="${escapeHtml(it)}" ${activeSet.has(it) ? "checked" : ""} />
          <span class="dropdown-check-label">${escapeHtml(it)}</span>
          <span class="filter-menu-count">${counts.get(it) || 0}</span>
        </label>`
      )
      .join("") || `<div class="hint" style="padding:10px 0;">Nada encontrado</div>`;
  };

  panel.innerHTML = `
    <div class="filter-sub-header"><button class="filter-back" id="filterBack">‹</button> ${titles[kind]}</div>
    <div class="filter-search"><input type="text" id="filterSearch" placeholder="Search for ${titles[kind].toLowerCase()}..." /></div>
    <div class="dropdown-list filter-sub-list" id="filterSubList">${renderList("")}</div>
  `;

  function wireChecks() {
    panel.querySelectorAll('.filter-sub-list input[type="checkbox"]').forEach((cb) => {
      cb.addEventListener("change", () => {
        if (cb.checked) activeSet.add(cb.value); else activeSet.delete(cb.value);
        renderHome();
        if (isTags) renderSidebar();
      });
    });
  }
  wireChecks();

  panel.querySelector("#filterSearch").addEventListener("input", (e) => {
    panel.querySelector("#filterSubList").innerHTML = renderList(e.target.value);
    wireChecks();
  });
  panel.querySelector("#filterBack").addEventListener("click", () => renderFilterMain(panel));
}

function toggleSortDropdown(anchorEl) {
  if (document.querySelector(".dropdown-panel[data-kind='sort']")) { closeDropdowns(); return; }
  closeDropdowns();

  const BY_OPTIONS = [
    ["created", "Created at"],
    ["updated", "Last updated"],
    ["title", "Alphabetical"],
    ["connections", "Connections"],
  ];
  const GROUP_OPTIONS = [["day", "Day"], ["week", "Week"], ["month", "Month"], ["none", "None"]];

  const panel = document.createElement("div");
  panel.className = "dropdown-panel";
  panel.dataset.kind = "sort";
  panel.innerHTML = `
    <div class="dropdown-section">
      <div class="dropdown-title">Order by</div>
      ${BY_OPTIONS.map(([v, l]) => `
        <label class="dropdown-radio"><input type="radio" name="sortBy" value="${v}" ${state.sort.by === v ? "checked" : ""} /> ${l}</label>
      `).join("")}
    </div>
    <div class="dropdown-section">
      <div class="dropdown-title">Direction</div>
      <label class="dropdown-radio"><input type="radio" name="sortDir" value="desc" ${state.sort.dir === "desc" ? "checked" : ""} /> Descending</label>
      <label class="dropdown-radio"><input type="radio" name="sortDir" value="asc" ${state.sort.dir === "asc" ? "checked" : ""} /> Ascending</label>
    </div>
    <div class="dropdown-section">
      <div class="dropdown-title">Group by</div>
      ${GROUP_OPTIONS.map(([v, l]) => `
        <label class="dropdown-radio"><input type="radio" name="groupBy" value="${v}" ${state.sort.groupBy === v ? "checked" : ""} /> ${l}</label>
      `).join("")}
    </div>
  `;
  positionDropdown(panel, anchorEl);
  document.body.appendChild(panel);

  panel.querySelectorAll('input[name="sortBy"]').forEach((r) => r.addEventListener("change", (e) => { state.sort.by = e.target.value; renderHome(); }));
  panel.querySelectorAll('input[name="sortDir"]').forEach((r) => r.addEventListener("change", (e) => { state.sort.dir = e.target.value; renderHome(); }));
  panel.querySelectorAll('input[name="groupBy"]').forEach((r) => r.addEventListener("change", (e) => { state.sort.groupBy = e.target.value; renderHome(); }));
}

function positionDropdown(panel, anchorEl) {
  const rect = anchorEl.getBoundingClientRect();
  panel.style.position = "fixed";
  panel.style.top = rect.bottom + 6 + "px";
  panel.style.right = window.innerWidth - rect.right + "px";
}

document.addEventListener("click", (e) => {
  if (e.target.closest(".dropdown-panel") || e.target.closest("#filterBtn") || e.target.closest("#sortBtn") || e.target.closest("#addTagBtn")) return;
  closeDropdowns();
});

// ---------------------------------------------------------------------
// Modal "+ Add"
// ---------------------------------------------------------------------

function openAddModal(prefill = {}) {
  const root = document.getElementById("modalRoot");
  const tags = allKnownTags();

  root.innerHTML = `
    <div class="modal-backdrop" id="backdrop">
      <div class="modal">
        <h3>➕ Salvar no AACM Recall</h3>
        <input id="mUrl" placeholder="URL (opcional p/ notas)" value="${escapeHtml(prefill.url || "")}" />
        <input id="mTitle" placeholder="Titulo" value="${escapeHtml(prefill.title || "")}" />
        <select id="mTag">
          ${tags.map((t) => `<option value="${escapeHtml(t)}">${escapeHtml(t)}</option>`).join("")}
        </select>
        <textarea id="mNote" placeholder="Nota rapida (opcional)" rows="3"></textarea>
        <div class="modal-actions">
          <button class="btn-ghost" id="mCancel">Cancelar</button>
          <button class="btn-add" id="mSave">Salvar</button>
        </div>
      </div>
    </div>`;

  document.getElementById("backdrop").addEventListener("click", (e) => { if (e.target.id === "backdrop") root.innerHTML = ""; });
  document.getElementById("mCancel").addEventListener("click", () => (root.innerHTML = ""));
  document.getElementById("mSave").addEventListener("click", async () => {
    const saveBtn = document.getElementById("mSave");
    const url = document.getElementById("mUrl").value.trim();
    let title = document.getElementById("mTitle").value.trim();
    const tag = document.getElementById("mTag").value;
    let note = document.getElementById("mNote").value.trim();
    let thumbnail = "";

    saveBtn.disabled = true;
    try {
      // So colou a URL, sem titulo/nota proprios: pede pro Gemini buscar
      // titulo + resumo + imagem automaticamente, como o Recall fazia.
      if (url && !note) {
        if (getGeminiKey()) {
          saveBtn.textContent = "Buscando resumo (IA)…";
          try {
            const meta = await fetchUrlMetadataViaGemini(url);
            if (meta) {
              if (!title && meta.title) title = meta.title;
              if (meta.summary) note = meta.summary;
              else if (meta.summaryError) note = `_Titulo e imagem foram buscados, mas o resumo por IA falhou: ${meta.summaryError}_`;
              if (meta.image) thumbnail = meta.image;
            }
          } catch (err) {
            console.warn("Resumo automatico via Gemini falhou:", err);
            note = note || `_Nao consegui buscar um resumo automatico (${err.message}). Edite manualmente._`;
          }
        } else {
          note = "_Sem resumo automatico: conecte sua chave gratuita do Gemini na aba Ask de qualquer card para isso funcionar._";
        }
      }
      if (!title) title = "(sem título)";

      saveBtn.textContent = "Salvando…";
      const slug = await createCard({ url, title, tag, note, thumbnail });
      root.innerHTML = "";
      navigate({ view: "card", slug });
    } catch (err) {
      alert("Nao consegui salvar: " + err.message);
      saveBtn.textContent = "Salvar";
      saveBtn.disabled = false;
    }
  });
}

// Cria um card novo (do botao +Add, do bookmarklet ou do Compartilhar do
// Android) e grava de verdade no GitHub, se houver token configurado.
async function createCard({ url, title, tag, note, thumbnail }) {
  let source = "";
  if (url) { try { source = new URL(url).hostname.replace(/^www\./, ""); } catch (e) {} }

  const now = new Date().toISOString();
  const datePart = now.slice(0, 10);
  const slugTitle = title.toLowerCase().normalize("NFD").replace(/[̀-ͯ]/g, "")
    .replace(/[^a-z0-9]+/g, "-").replace(/^-+|-+$/g, "").slice(0, 60);
  let slug = `${datePart}-${slugTitle || "card"}`;
  const existingSlugs = new Set(state.index.map((c) => c.slug));
  let n = 2;
  while (existingSlugs.has(slug)) { slug = `${datePart}-${slugTitle || "card"}-${n++}`; }

  const card = {
    slug, title, url, source,
    tags: [tag],
    thumbnail: thumbnail || "",
    attachments: [],
    created: now, updated: now,
    // "pendente" so quando o card nasce sem nenhum conteudo (nem nota
    // manual, nem resumo automatico da IA) — pra sinalizar que ainda
    // precisa de atencao. Se ja tem conteudo, considera "resumido".
    status: note.trim() ? "resumido" : "pendente",
    links_to: [], linked_from: [], bracket_terms: [],
  };

  state.index.unshift(card);
  state.bodyCache[slug] = { summaryMd: note, notesMd: "" };

  if (getGhToken()) {
    await saveCardToGitHub(slug, note);
  }
  return slug;
}

// Pede pro Gemini visitar a URL (via url_context, que roda do lado do
// Google — sem o bloqueio de CORS que a gente teria tentando buscar a
// pagina direto do navegador) e devolver titulo + resumo em topicos +
// imagem de capa, igual o Recall original fazia. So funciona se o
// usuario ja colou a chave gratuita do Gemini em algum card (Ask).
function youtubeVideoId(url) {
  try {
    const u = new URL(url);
    const host = u.hostname.replace(/^www\.|^m\./, "");
    if (host === "youtu.be") return u.pathname.slice(1).split("/")[0] || null;
    if (host === "youtube.com") {
      if (u.pathname === "/watch") return u.searchParams.get("v");
      const m = u.pathname.match(/^\/(?:shorts|embed|live)\/([\w-]{6,})/);
      if (m) return m[1];
    }
  } catch (e) {}
  return null;
}

// YouTube bloqueia leitura de pagina sem login, entao url_context nao
// funciona. Aqui: titulo + miniatura vem do oEmbed publico do YouTube
// (aceita CORS) e o resumo vem do Gemini "assistindo" o video via link
// (fileData), que e o jeito suportado de passar video do YouTube.
async function fetchYoutubeMetadata(videoId) {
  const key = getGeminiKey();
  const watchUrl = `https://www.youtube.com/watch?v=${videoId}`;
  const result = { title: "", summary: "", image: `https://i.ytimg.com/vi/${videoId}/hqdefault.jpg`, summaryError: "" };

  try {
    const r = await fetch(`https://www.youtube.com/oembed?url=${encodeURIComponent(watchUrl)}&format=json`);
    if (r.ok) {
      const j = await r.json();
      result.title = (j.title || "").trim();
      if (j.thumbnail_url) result.image = j.thumbnail_url;
    }
  } catch (e) { /* segue so com o que ja temos */ }

  try {
    const endpoint = `https://generativelanguage.googleapis.com/v1beta/models/${GEMINI_MODEL}:generateContent?key=${encodeURIComponent(key)}`;
    const res = await fetch(endpoint, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        contents: [{
          parts: [
            { fileData: { fileUri: watchUrl } },
            { text:
              "Resuma este video em portugues, em topicos markdown: use '## ' para secoes e '- ' para cada " +
              "topico, cobrindo os pontos principais. Responda somente com o resumo, sem introducao nem comentarios." },
          ],
        }],
        generationConfig: { maxOutputTokens: 4096 },
      }),
    });
    if (!res.ok) {
      const errText = await res.text();
      throw new Error(`HTTP ${res.status} — ${errText.slice(0, 300)}`);
    }
    const data = await res.json();
    const parts = data?.candidates?.[0]?.content?.parts || [];
    result.summary = parts.map((p) => p.text || "").join("").trim();
    if (!result.summary) throw new Error("O Gemini nao devolveu texto (video privado, muito longo ou sem permissao).");
  } catch (e) {
    result.summaryError = e.message;
  }
  return result;
}

async function fetchUrlMetadataViaGemini(url) {
  const key = getGeminiKey();
  if (!key) return null;

  const videoId = youtubeVideoId(url);
  if (videoId) return fetchYoutubeMetadata(videoId);

  const prompt =
    `Acesse esta URL: ${url}\n\n` +
    `Sua resposta final deve ser SOMENTE o JSON abaixo — nao escreva raciocinio, ` +
    `explicacoes, nem nenhum texto antes ou depois dele:\n` +
    `{"title": "titulo da pagina, curto", "summary": "resumo em portugues, em topicos markdown ` +
    `(use '## ' para secoes se fizer sentido e '- ' para cada topico), cobrindo os pontos principais ` +
    `do conteudo", "image": "URL da imagem de capa/og:image da pagina, ou string vazia se nao achar"}`;

  const endpoint = `https://generativelanguage.googleapis.com/v1beta/models/${GEMINI_MODEL}:generateContent?key=${encodeURIComponent(key)}`;
  const res = await fetch(endpoint, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      contents: [{ parts: [{ text: prompt }] }],
      tools: [{ url_context: {} }],
      // Em paginas que bloqueiam acesso (ex.: YouTube sem login), o
      // modelo tenta "pensar alto" formas de contornar isso, e essa
      // narrativa as vezes consome todo o limite de tokens antes de
      // chegar no JSON final (resposta cortada no meio). Desligando o
      // "pensamento" ele vai direto pra resposta, mesmo que mais simples.
      generationConfig: {
        thinkingConfig: { thinkingBudget: 0 },
        maxOutputTokens: 4096,
      },
    }),
  });
  if (!res.ok) {
    const errText = await res.text();
    throw new Error(`HTTP ${res.status} — ${errText.slice(0, 200)}`);
  }
  const data = await res.json();
  const text = data?.candidates?.[0]?.content?.parts?.[0]?.text || "";
  const parsed = extractJsonObject(text);
  if (parsed) {
    return {
      title: (parsed.title || "").trim(),
      summary: (parsed.summary || "").trim(),
      image: (parsed.image || "").trim(),
    };
  }
  // Sem JSON reconhecivel na resposta (ex.: pagina bloqueou o acesso e o
  // modelo nao conseguiu concluir) — melhor avisar no formulario do que
  // salvar um texto de raciocinio solto como se fosse o resumo do card.
  throw new Error("O Gemini nao devolveu um resumo valido para essa pagina (pode ser uma pagina que bloqueia acesso, como o YouTube as vezes faz).");
}

// Acha e faz parse de um objeto JSON dentro de um texto maior: tenta o
// texto inteiro primeiro, depois um bloco ```json ... ```, depois o
// trecho entre a primeira "{" e a ultima "}" do texto.
function extractJsonObject(text) {
  const candidates = [text.trim()];
  const fenced = text.match(/```(?:json)?\s*([\s\S]*?)```/i);
  if (fenced) candidates.push(fenced[1].trim());
  const first = text.indexOf("{");
  const last = text.lastIndexOf("}");
  if (first !== -1 && last > first) candidates.push(text.slice(first, last + 1));

  for (const candidate of candidates) {
    try {
      return JSON.parse(candidate);
    } catch (e) { /* tenta o proximo */ }
  }
  return null;
}

// ---------------------------------------------------------------------
// Router
// ---------------------------------------------------------------------

function navigate(route) {
  state.route = route;
  location.hash = route.view === "card" ? `card/${route.slug}` : "";
  render();
}

function render() {
  renderSidebar();
  if (state.route.view === "card") renderCardDetail(state.route.slug);
  else renderHome();
}

function routeFromHash() {
  const h = location.hash.replace(/^#/, "");
  if (h.startsWith("card/")) return { view: "card", slug: h.slice(5) };
  return { view: "home" };
}

// ---------------------------------------------------------------------
// Boot
// ---------------------------------------------------------------------

function showGithubGate() {
  return new Promise((resolve) => {
    const root = document.getElementById("modalRoot");
    root.innerHTML = `
      <div class="modal-backdrop" id="ghBackdrop">
        <div class="modal">
          <h3>🔗 Conectar ao GitHub</h3>
          <p class="hint" style="margin:0 0 12px;">
            Cole aqui o token que voce gerou em
            github.com/settings/personal-access-tokens — ele fica guardado
            so neste navegador/aparelho, nunca e enviado pra mim nem pro
            codigo do app.
          </p>
          <input id="ghTokenInput" placeholder="github_pat_..." autocomplete="off" />
          <div class="modal-actions">
            <button class="btn-ghost" id="ghSkip">Usar sem GitHub (modo teste local)</button>
            <button class="btn-add" id="ghConnect">Conectar</button>
          </div>
        </div>
      </div>`;

    document.getElementById("ghSkip").addEventListener("click", () => {
      localStorage.setItem("aacm-gh-skip", "1");
      root.innerHTML = "";
      resolve();
    });
    document.getElementById("ghConnect").addEventListener("click", () => {
      const v = document.getElementById("ghTokenInput").value.trim();
      if (!v) return;
      setGhToken(v);
      localStorage.removeItem("aacm-gh-skip");
      root.innerHTML = "";
      resolve();
    });
  });
}

function wireGithubStatus() {
  const el = document.getElementById("githubStatus");
  if (!el) return;
  const connected = !!getGhToken();
  el.textContent = connected ? "☁️ GitHub conectado" : "🔌 Conectar ao GitHub";
  el.onclick = async () => {
    if (connected) {
      if (!confirm("Desconectar este aparelho do GitHub? (o token sera apagado daqui)")) return;
      clearGhToken();
    } else {
      await showGithubGate();
    }
    location.reload();
  };
}

async function main() {
  const skipped = localStorage.getItem("aacm-gh-skip") === "1";
  if (!getGhToken() && !skipped) await showGithubGate();

  state.index = await loadIndex();
  state.route = routeFromHash();
  render();

  window.addEventListener("hashchange", () => { state.route = routeFromHash(); render(); });

  document.getElementById("searchInput").addEventListener("input", (e) => {
    state.query = e.target.value;
    if (state.route.view !== "home") navigate({ view: "home" }); else renderHome();
  });

  document.getElementById("addBtn").addEventListener("click", () => openAddModal());
  document.getElementById("brandHome").addEventListener("click", (e) => { e.preventDefault(); navigate({ view: "home" }); });
  document.getElementById("filterBtn").addEventListener("click", (e) => toggleFilterDropdown(e.currentTarget));
  document.getElementById("sortBtn").addEventListener("click", (e) => toggleSortDropdown(e.currentTarget));
  wireGithubStatus();

  const qp = new URLSearchParams(location.search);
  if (qp.get("prefill") === "1") {
    openAddModal({ url: qp.get("url") || "", title: qp.get("title") || "" });
    history.replaceState(null, "", location.pathname);
  }

  await resetStaleServiceWorkerOnce();
  if ("serviceWorker" in navigator) navigator.serviceWorker.register("sw.js").catch(() => {});
}

// Faz uma faxina ÚNICA (uma vez por aparelho) em qualquer service worker e
// cache antigos — resolve o caso de uma versao anterior do app ter ficado
// "presa" servindo codigo desatualizado, mesmo depois de publicar correcoes.
// So roda de novo se eu mudar o numero da versao abaixo.
const SW_RESET_VERSION = "2";
async function resetStaleServiceWorkerOnce() {
  if (localStorage.getItem("aacm-sw-reset") === SW_RESET_VERSION) return;
  try {
    if ("serviceWorker" in navigator) {
      const regs = await navigator.serviceWorker.getRegistrations();
      await Promise.all(regs.map((r) => r.unregister()));
    }
    if (window.caches) {
      const keys = await caches.keys();
      await Promise.all(keys.map((k) => caches.delete(k)));
    }
  } catch (e) { console.warn("Faxina de service worker falhou:", e); }
  localStorage.setItem("aacm-sw-reset", SW_RESET_VERSION);
}

main().catch((err) => {
  document.getElementById("content").innerHTML = `<div class="empty-state">Erro ao carregar: ${escapeHtml(err.message)}</div>`;
  console.error(err);
});
