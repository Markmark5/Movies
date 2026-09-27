// Daily snapshot of UK streaming catalogues → data/seen.json + data/arrivals.json
// Node 20+, no dependencies. Usage: TMDB_API_KEY=... node scripts/snapshot.mjs
import { readFile, writeFile, mkdir } from "node:fs/promises";
import { gunzipSync } from "node:zlib";

const KEY = (process.env.TMDB_API_KEY || "").trim();
if (!KEY) { console.error("TMDB_API_KEY is not set."); process.exit(1); }
const BEARER = KEY.length > 40;

const DATA = new URL("../data/", import.meta.url);
const TRACKED = [/^netflix$/i, /^amazon prime video$/i, /bbc iplayer/i, /^itvx$|itv hub/i, /^channel 4$|all 4/i, /^disney plus$/i];
const RETURN_GAP = 14;     // days absent before a comeback counts as a new arrival
const KEEP_DAYS = 60;      // arrivals window written to arrivals.json
const CONCURRENCY = 5;
const MAX_PAGES = 500;     // TMDB discover cap

const today = new Intl.DateTimeFormat("en-CA", { timeZone: "Europe/London" }).format(new Date());
const dayNum = d => Date.parse(d + "T00:00:00Z") / 864e5;
const daysBetween = (a, b) => dayNum(b) - dayNum(a);
const addDays = (d, n) => new Date((dayNum(d) + n) * 864e5).toISOString().slice(0, 10);
const isDate = s => /^\d{4}-\d{2}-\d{2}$/.test(s || "");
const sleep = ms => new Promise(r => setTimeout(r, ms));

async function tmdb(path, params = {}) {
  const u = new URL("https://api.themoviedb.org/3" + path);
  if (!BEARER) u.searchParams.set("api_key", KEY);
  for (const [k, v] of Object.entries(params)) if (v !== "" && v != null) u.searchParams.set(k, v);
  for (let attempt = 0; ; attempt++) {
    let status = 0, retryAfter = 0;
    try {
      const r = await fetch(u, { headers: BEARER ? { Authorization: "Bearer " + KEY } : {} });
      if (r.ok) return r.json();
      status = r.status; retryAfter = +r.headers.get("retry-after") || 0;
      if (status === 401) throw Object.assign(new Error("TMDB rejected the key (401)."), { fatal: true });
      if (status !== 429 && status < 500) throw Object.assign(new Error(`TMDB ${status} on ${path}`), { fatal: true });
    } catch (e) {
      if (e.fatal) throw e;
    }
    if (attempt >= 5) throw new Error(`TMDB ${status || "network error"} on ${path} after retries`);
    await sleep(Math.max(retryAfter * 1000, 1000 * 2 ** attempt));
  }
}

// Run fn over items with a small worker pool
async function pool(items, fn, n = CONCURRENCY) {
  const out = new Array(items.length); let i = 0;
  await Promise.all(Array.from({ length: Math.min(n, items.length) }, async () => {
    while (i < items.length) { const k = i++; out[k] = await fn(items[k], k); }
  }));
  return out;
}

async function readJson(name, fallback) {
  try { return JSON.parse(await readFile(new URL(name, DATA), "utf8")); } catch { return fallback; }
}
async function writeJson(name, obj, pretty) {
  await writeFile(new URL(name, DATA), JSON.stringify(obj, null, pretty ? 2 : 0) + "\n");
}

const baseQuery = id => ({
  watch_region: "GB", language: "en-GB", with_watch_providers: id,
  with_watch_monetization_types: "flatrate|free|ads", sort_by: "popularity.desc",
  include_adult: false, "vote_count.gte": 5
});

// All films on one provider. Splits by release-date range if a query exceeds TMDB's 500-page cap.
async function catalogue(id, range = null) {
  const q = { ...baseQuery(id) };
  if (range) { q["primary_release_date.gte"] = range[0]; q["primary_release_date.lte"] = range[1]; }
  const first = await tmdb("/discover/movie", { ...q, page: 1 });
  if (first.total_pages > MAX_PAGES && (!range || range[0] !== range[1])) {
    const [a, b] = range || ["1870-01-01", addDays(today, 365)];
    const mid = addDays(a, Math.floor(daysBetween(a, b) / 2));
    const parts = [await catalogue(id, [a, mid]), await catalogue(id, [addDays(mid, 1), b])];
    if (!range) {
      // Undated films fall outside every date range; the popular ones show in an unsplit first page anyway
      parts.push(first.results);
    }
    return parts.flat();
  }
  const pages = Array.from({ length: Math.min(first.total_pages, MAX_PAGES) - 1 }, (_, k) => k + 2);
  const rest = await pool(pages, p => tmdb("/discover/movie", { ...q, page: p }).then(d => d.results));
  return [first.results, ...rest].flat();
}

// IMDb ratings for every tracked film, from IMDb's free daily dataset.
// data/imdb-ids.json caches TMDB id → IMDb number (0 = none) and data/countries.json caches
// TMDB id → origin countries ("GB,US"), so only new films need a details lookup.
async function buildRatings(seen) {
  const ids = await readJson("imdb-ids.json", {});
  const countries = await readJson("countries.json", {});
  const all = [...new Set(Object.values(seen).flatMap(m => Object.keys(m)))];
  const todo = all.filter(id => !(id in ids) || !(id in countries));
  console.log(`Film details: ${all.length - todo.length} cached, ${todo.length} to look up.`);
  let done = 0;
  await pool(todo, async id => {
    try {
      const d = await tmdb(`/movie/${id}`);
      ids[id] = +(d.imdb_id || "").replace(/^tt/, "") || 0;
      countries[id] = (d.origin_country?.length ? d.origin_country : (d.production_countries || []).map(c => c.iso_3166_1)).join(",");
    }
    catch { /* try again tomorrow */ }
    if (++done % 2000 === 0) console.log(`  ${done}/${todo.length}`);
  }, 10);
  await writeJson("imdb-ids.json", ids);
  await writeJson("countries.json", countries);

  const r = await fetch("https://datasets.imdbws.com/title.ratings.tsv.gz");
  if (!r.ok) throw new Error(`IMDb dataset download failed (${r.status})`);
  const want = new Map(Object.entries(ids).filter(([, n]) => n).map(([t, n]) => [n, t]));
  const out = {};
  for (const line of gunzipSync(Buffer.from(await r.arrayBuffer())).toString("utf8").split("\n")) {
    const [tc, avg, votes] = line.split("\t");
    const t = want.get(+tc.slice(2));
    if (t) out[t] = [+avg, +votes, +tc.slice(2)];
  }
  await writeJson("ratings.json", out);
  console.log(`ratings.json: ${Object.keys(out).length} films with IMDb ratings.`);
  return { ratings: out, countries };
}

// Compact list of films currently on a tracked service, so the app can sort Top rated by IMDb.
// Row: [id, title, poster, year, lang, genre_ids, countries, providers, imdbRating|null, imdbVotes, tmdbAvg, tmdbCount]
// Poster is the TMDB path without "/" and ".jpg". TMDB scores are only kept for films IMDb hasn't rated.
// Left out to keep the file small: films rated under 5 (below the app's slider), under 100 IMDb votes,
// or with no IMDb rating and under 200 TMDB votes.
async function buildCatalogue(seen, meta, tracked, { ratings, countries }) {
  const prev = await readJson("catalogue.json", { rows: [] });
  const prevRows = new Map(prev.rows.map(r => [r[0], r]));
  const poster = p => (p || "").replace(/^\/|\.jpg$/g, "");
  const stillThere = addDays(today, -3), provs = new Map();
  for (const [pid, map] of Object.entries(seen))
    for (const [tid, e] of Object.entries(map))
      if (e.last >= stillThere) (provs.get(+tid) || provs.set(+tid, []).get(+tid)).push(+pid);
  const rows = [];
  for (const [id, ps] of provs) {
    const m = meta.get(id), old = prevRows.get(id), r = ratings[id];
    if (!m && !old) continue;
    const tAvg = m ? Math.round((m.vote_average || 0) * 10) / 10 : old[10], tCount = m ? m.vote_count || 0 : old[11];
    if (r ? r[0] < 5 || r[1] < 100 : tAvg < 5 || tCount < 200) continue;
    rows.push([id,
      m ? m.title : old[1], m ? poster(m.poster_path) : old[2], m ? +(m.release_date || "").slice(0, 4) || 0 : old[3],
      m ? m.original_language || "" : old[4], m ? m.genre_ids || [] : old[5],
      countries[id] ?? (old ? old[6] : ""), ps,
      r ? r[0] : null, r ? r[1] : 0, r ? 0 : tAvg, r ? 0 : tCount]);
  }
  rows.sort((a, b) => (b[8] ?? b[10]) - (a[8] ?? a[10]) || b[9] - a[9]);
  await writeJson("catalogue.json", { generated: today, providers: [...tracked], rows });
  console.log(`catalogue.json: ${rows.length} films.`);
}

async function main() {
  const config = await readJson("providers.json", { extra: [] });
  const seen = await readJson("seen.json", {});
  const prevArrivals = await readJson("arrivals.json", null);
  const prevMeta = new Map((prevArrivals?.items || []).map(m => [m.id, m]));

  const pv = await tmdb("/watch/providers/movie", { watch_region: "GB" });
  const byId = new Map(pv.results.map(p => [p.provider_id, p.provider_name]));
  const ids = new Set(TRACKED.map(re => pv.results.find(p => re.test(p.provider_name))?.provider_id).filter(Boolean));
  for (const x of config.extra || []) if (byId.has(+x)) ids.add(+x); else console.warn(`Extra provider ${x} not found in GB list, skipped.`);

  const meta = new Map(); // tmdbId → discover result from today
  let okCount = 0;
  for (const id of ids) {
    const name = byId.get(id);
    let films;
    try { films = await catalogue(id); }
    catch (e) { console.warn(`${name} (${id}): ${e.message} — left unchanged today.`); continue; }
    if (!films.length) { console.warn(`${name} (${id}): no results — left unchanged today.`); continue; }
    okCount++;

    const key = String(id);
    const baseline = !seen[key];
    const map = seen[key] ||= {};
    // Last date this provider was successfully snapshotted, so missed runs don't look like absences
    const prevRun = Object.values(map).reduce((m, e) => e.last > m ? e.last : m, "");
    let fresh = 0;
    for (const f of films) {
      meta.set(f.id, f);
      const e = map[f.id];
      if (!e) { map[f.id] = { first: baseline ? "baseline" : today, last: today }; if (!baseline) fresh++; }
      else if (e.last !== today) {
        if (prevRun && daysBetween(e.last, prevRun) >= RETURN_GAP) { e.first = today; fresh++; }
        e.last = today;
      }
    }
    console.log(`${name} (${id}): ${new Set(films.map(f => f.id)).size} films${baseline ? " — baseline" : `, ${fresh} new`}`);
  }
  if (!okCount) throw new Error("No provider could be snapshotted.");

  // Build arrivals: dated first-seen within KEEP_DAYS, still present in the last few days
  const since = addDays(today, -KEEP_DAYS), stillThere = addDays(today, -3);
  const items = new Map();
  for (const [pid, map] of Object.entries(seen)) {
    for (const [tid, e] of Object.entries(map)) {
      if (!isDate(e.first) || e.first < since || e.last < stillThere) continue;
      const m = meta.get(+tid) || prevMeta.get(+tid);
      if (!m) continue;
      const it = items.get(+tid) || items.set(+tid, {
        id: m.id, title: m.title, poster_path: m.poster_path || null, release_date: m.release_date || "",
        original_language: m.original_language, origin_country: m.origin_country || prevMeta.get(m.id)?.origin_country,
        genre_ids: m.genre_ids || [], vote_average: m.vote_average || 0, vote_count: m.vote_count || 0, arrivals: {}
      }).get(+tid);
      it.arrivals[pid] = e.first;
    }
  }

  // origin_country isn't in discover results; fetch details for arrival items only
  const missing = [...items.values()].filter(it => !Array.isArray(it.origin_country));
  await pool(missing, async it => {
    try { const d = await tmdb(`/movie/${it.id}`); it.origin_country = d.origin_country || (d.production_countries || []).map(c => c.iso_3166_1); }
    catch { it.origin_country = []; }
  });

  const list = [...items.values()].sort((a, b) =>
    Object.values(b.arrivals).sort().at(-1).localeCompare(Object.values(a.arrivals).sort().at(-1)) || b.vote_count - a.vote_count);

  await mkdir(DATA, { recursive: true });
  await writeJson("seen.json", seen);
  await writeJson("arrivals.json", { generated: today, baselineDate: prevArrivals?.baselineDate || today, items: list });
  if (!(await readJson("providers.json", null))) await writeJson("providers.json", { extra: [] }, true);
  try { await buildCatalogue(seen, meta, ids, await buildRatings(seen)); }
  catch (e) { console.warn(`Ratings/catalogue not updated today: ${e.message}`); }
  console.log(`arrivals.json: ${list.length} films in the last ${KEEP_DAYS} days.`);
}

main().catch(e => { console.error(e.message); process.exit(1); });
