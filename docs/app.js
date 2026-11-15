/* Cinema Bologna — app statica che legge data/showtimes.json */
(() => {
  "use strict";

  const $ = (s, el = document) => el.querySelector(s);
  const store = {
    get(k, d) { try { const v = localStorage.getItem("cb:" + k); return v == null ? d : JSON.parse(v); } catch { return d; } },
    set(k, v) { try { localStorage.setItem("cb:" + k, JSON.stringify(v)); } catch { /* privato */ } },
  };

  const state = {
    data: null,
    day: null,
    view: store.get("view", "film"),
    q: "",
    vos: store.get("vos", false),
    past: false,
    hidden: new Set(store.get("hidden", [])),
    italian: new Set(),
    home: store.get("home", null),       // {lat, lon, label} — resta solo su questo telefono
    travel: store.get("travel", null),   // {key, at, byCinema: {id: {walk, bus, km}}}
  };

  const GIORNI = ["Dom", "Lun", "Mar", "Mer", "Gio", "Ven", "Sab"];
  const MESI = ["gen", "feb", "mar", "apr", "mag", "giu", "lug", "ago", "set", "ott", "nov", "dic"];

  const dayKey = (d) => `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}-${String(d.getDate()).padStart(2, "0")}`;
  // "2026-11-16T18:30+01:00" -> chiave giorno e ora come scritte (sono già ora di Roma)
  const showDay = (s) => s.start.slice(0, 10);
  const showTime = (s) => s.start.slice(11, 16);
  const ts = (s) => Date.parse(s.start);
  const norm = (t) => t.normalize("NFD").replace(/[̀-ͯ]/g, "").toLowerCase()
    .replace(/[’'`]/g, "").replace(/\(.*?\)/g, " ").replace(/[^a-z0-9]+/g, " ").trim();
  const esc = (t) => String(t ?? "").replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]));

  let cinemaById = {};
  const TRUSTED = new Set(["CCB", "Cineteca"]);

  async function load() {
    try {
      const r = await fetch("data/showtimes.json", { cache: "no-cache" });
      if (!r.ok) throw new Error(r.status);
      state.data = await r.json();
    } catch (e) {
      $("#updated").textContent = "Impossibile caricare gli orari";
      $("#list").innerHTML = `<p class="empty">Nessun dato disponibile. Controlla la connessione e riprova.</p>`;
      return;
    }
    cinemaById = Object.fromEntries(state.data.cinemas.map((c) => [c.id, c]));
    // film in lingua italiana = già in lingua originale
    state.italian = new Set();
    for (const s of state.data.shows) {
      const f = state.data.films?.[s.film];
      const country = (f?.country || "").trim();
      if (s.ita || /^italia\b/i.test(country)) state.italian.add(norm(s.title));
    }
    const g = new Date(state.data.generated_at);
    $("#updated").textContent = `Aggiornato ${g.getDate()} ${MESI[g.getMonth()]} alle ${String(g.getHours()).padStart(2, "0")}:${String(g.getMinutes()).padStart(2, "0")}`;
    buildDays();
    buildFilters();
    render();
    route(false);
    if (state.home) computeTravel().then(() => { render(); route(false); }).catch(() => {});
  }

  function visibleShows() {
    const q = norm(state.q);
    return state.data.shows.filter((s) =>
      !state.hidden.has(s.cinema) &&
      (!state.vos || s.vos || state.italian.has(norm(s.title))) &&
      (!q || norm(s.title).includes(q) || (s.director && norm(s.director).includes(q))));
  }

  function buildDays() {
    const today = dayKey(new Date());
    const counts = {};
    for (const s of visibleShows()) counts[showDay(s)] = (counts[showDay(s)] || 0) + 1;
    const keys = Object.keys(counts).filter((k) => k >= today).sort();
    if (!state.day || !keys.includes(state.day)) state.day = keys.includes(today) ? today : keys[0] || today;
    const tomorrow = dayKey(new Date(Date.now() + 864e5));
    $("#days").innerHTML = keys.map((k) => {
      const d = new Date(k + "T12:00:00");
      const label = k === today ? "Oggi" : k === tomorrow ? "Domani" : GIORNI[d.getDay()];
      return `<button class="day" data-day="${k}" aria-pressed="${k === state.day}">
        <small>${label}</small><b>${d.getDate()}</b><span class="n">${counts[k]} spett.</span></button>`;
    }).join("");
    const sel = $(`.day[aria-pressed="true"]`);
    if (sel) sel.scrollIntoView({ inline: "nearest", block: "nearest" });
    buildPosters();
  }

  // Carosello locandine: tutti i film in programmazione da ora in avanti
  function buildPosters() {
    const now = Date.now() - 10 * 60e3;
    const groups = new Map();
    for (const s of visibleShows()) {
      if (ts(s) < now) continue;
      const k = norm(s.title);
      if (!groups.has(k)) groups.set(k, []);
      groups.get(k).push(s);
    }
    const list = [...groups.entries()].map(([k, ss]) => {
      const trusted = ss.find((s) => TRUSTED.has(cinemaById[s.cinema]?.group));
      return { k, ss, title: (trusted || ss[0]).title, info: filmInfo(ss), cinemas: new Set(ss.map((s) => s.cinema)).size };
    }).sort((a, b) => b.ss.length - a.ss.length);
    $("#posters").innerHTML = list.map((f) => `<button class="poster" data-film="${esc(f.k)}" title="${esc(f.title)}">
        ${imgTag(f.info, "pimg")}
        <span class="ptitle">${esc(f.title)}</span>
        <span class="pmeta">${f.cinemas > 1 ? f.cinemas + " cinema" : esc(cinemaById[f.ss[0].cinema]?.name)}</span></button>`).join("");
    $("#posters").hidden = !list.length;
  }

  function buildFilters() {
    const groups = {};
    for (const c of state.data.cinemas) (groups[c.group] ||= []).push(c);
    const counts = {};
    for (const s of state.data.shows) counts[s.cinema] = (counts[s.cinema] || 0) + 1;
    $("#cinemaList").innerHTML = Object.entries(groups).map(([g, list]) =>
      `<h4>${esc(g === "CCB" ? "Circuito Cinema Bologna" : g === "Cineteca" ? "Cineteca di Bologna" : g === "Pop Up" ? "Pop Up Cinema" : g)}</h4>` +
      list.map((c) => `<label class="opt"><input type="checkbox" data-cinema="${c.id}" ${state.hidden.has(c.id) ? "" : "checked"}>
        <span>${esc(c.name)}<small>${esc(c.address)} · ${counts[c.id] || 0} spettacoli</small></span></label>`).join("")
    ).join("");
    updateFilterBadge();
  }

  function updateFilterBadge() {
    const b = $("#filterCount");
    const n = state.data.cinemas.length - state.hidden.size;
    b.hidden = state.hidden.size === 0;
    b.textContent = n;
  }

  function render() {
    const now = Date.now();
    let shows = visibleShows().filter((s) => showDay(s) === state.day);
    const isToday = state.day === dayKey(new Date());
    const pastCount = shows.filter((s) => ts(s) < now - 10 * 60e3).length;
    if (!state.past) shows = shows.filter((s) => ts(s) >= now - 10 * 60e3);
    $("#pastBtn").hidden = !isToday || pastCount === 0;

    const failing = Object.entries(state.data.sources || {}).filter(([, v]) => !v.ok).map(([k]) => k);
    const warn = failing.length ? `<p class="warn">Alcune fonti non hanno risposto all'ultimo aggiornamento (${esc(failing.join(", "))}): i loro orari potrebbero non essere aggiornati.</p>` : "";

    if (!shows.length) {
      $("#list").innerHTML = warn + `<p class="empty">Nessuno spettacolo${state.q ? ` per “${esc(state.q)}”` : ""} in questo giorno.</p>`;
      return;
    }
    const html = state.view === "cinema" ? byCinema(shows, now) : state.view === "time" ? byTime(shows, now) : byFilm(shows, now);
    $("#list").innerHTML = warn + html;
  }

  function pill(s, now, nextTs) {
    const cls = ts(s) < now ? "past" : ts(s) === nextTs ? "next" : "";
    const href = s.buy || s.info || cinemaById[s.cinema]?.url;
    const title = `${s.title} — ${cinemaById[s.cinema]?.name}${s.sala ? " (" + s.sala + ")" : ""}`;
    return `<a class="time ${cls}" href="${esc(href)}" target="_blank" rel="noopener" title="${esc(title)}">${showTime(s)}${s.vos ? '<span class="v">VOS</span>' : ""}</a>`;
  }

  function tagsHtml(tags) {
    return (tags || []).slice(0, 3).map((t) => `<span class="tag">${esc(t)}</span>`).join("");
  }


  // Unisce le schede dello stesso film viste in cinema diversi
  function filmInfo(shows) {
    const out = {};
    const keys = [...new Set(shows.map((s) => s.film).filter(Boolean))];
    // prima le schede di CCB/Pop Up (locandine verticali), poi le altre
    const rank = (k) => /circuitocinema|popupcinema/.test(k) ? 0 : 1;
    keys.sort((a, b) => rank(a) - rank(b));
    for (const k of keys) {
      const f = state.data.films?.[k];
      if (!f) continue;
      for (const [field, v] of Object.entries(f)) {
        if (v && out[field] == null) out[field] = v;
      }
      if (f.plot && (!out.plot || (f.plot.length > out.plot.length && rank(k) === 1))) out.plot = f.plot;
    }
    out.director = shows.find((s) => s.director)?.director;
    out.links = keys;
    return out;
  }

  // ------------------------------------------------------------ percorsi da casa
  const travelFor = (cid) => state.home && state.travel?.byCinema?.[cid];
  const fmtMin = (m) => m >= 60 ? `${Math.floor(m / 60)} h ${m % 60}′` : `${m}′`;
  const hhmm = (t) => { const d = new Date(t); return `${String(d.getHours()).padStart(2, "0")}:${String(d.getMinutes()).padStart(2, "0")}`; };
  const MARGIN = 5; // minuti di anticipo per biglietto e posto

  function travelBadge(cid) {
    const t = travelFor(cid);
    if (!t) return "";
    return `<small class="trip">🚶 ${fmtMin(t.walk)}${t.bus ? ` · 🚌 ~${fmtMin(t.bus)}` : ""}</small>`;
  }

  function mapsUrl(cid, mode) {
    const c = cinemaById[cid];
    const dest = `${c.lat},${c.lon}`;
    return `https://www.google.com/maps/dir/?api=1&origin=${state.home.lat},${state.home.lon}&destination=${dest}&travelmode=${mode}`;
  }

  async function computeTravel(force) {
    if (!state.home) return;
    const key = `${state.home.lat.toFixed(5)},${state.home.lon.toFixed(5)}`;
    if (!force && state.travel?.key === key) return;
    const cins = state.data.cinemas;
    const coords = [`${state.home.lon},${state.home.lat}`, ...cins.map((c) => `${c.lon},${c.lat}`)].join(";");
    const table = async (profile) => {
      const r = await fetch(`https://routing.openstreetmap.de/routed-${profile}/table/v1/driving/${coords}?sources=0&annotations=duration,distance`);
      if (!r.ok) throw new Error(r.status);
      return r.json();
    };
    const [foot, car] = await Promise.all([table("foot"), table("car")]);
    const byCinema = {};
    cins.forEach((c, i) => {
      const walk = Math.round(foot.durations[0][i + 1] / 60);
      const km = foot.distances?.[0]?.[i + 1] / 1000;
      const drive = car.durations[0][i + 1] / 60;
      // stima bus: 4′ a piedi alla fermata + 5′ di attesa media + viaggio (traffico e fermate) + 3′ dalla fermata
      const bus = Math.round(4 + 5 + drive * 1.6 + 3);
      byCinema[c.id] = { walk, km: km ? Math.round(km * 10) / 10 : null, bus: walk > 12 && bus < walk ? bus : null };
    });
    state.travel = { key, at: Date.now(), byCinema };
    store.set("travel", state.travel);
  }

  function goBlock(shows) {
    if (!state.home) {
      return `<p class="hint">Imposta il tuo indirizzo di casa (pulsante ⚙︎ in alto) per vedere quanto ci metti ad arrivare e a che ora uscire.</p>`;
    }
    const now = Date.now();
    const nextBy = new Map();
    for (const s of shows) if (ts(s) > now && !nextBy.has(s.cinema)) nextBy.set(s.cinema, s);
    const rows = [...nextBy.values()].sort((a, b) => ts(a) - ts(b)).map((s) => {
      const t = travelFor(s.cinema);
      const c = cinemaById[s.cinema];
      if (!t) return "";
      const leave = (m) => hhmm(ts(s) - (m + MARGIN) * 60e3);
      const late = (m) => ts(s) - (m + MARGIN) * 60e3 < now;
      const opt = (icon, label, m, mode) => `<a class="go-opt ${late(m) ? "late" : ""}" href="${esc(mapsUrl(s.cinema, mode))}" target="_blank" rel="noopener">
          <span class="go-ico">${icon}</span><span><b>${label === "bus" ? "~" : ""}${fmtMin(m)}</b> ${label}<small>${late(m) ? "non fai in tempo" : "esci alle " + leave(m)}</small></span></a>`;
      return `<div class="go-row"><div class="go-head"><b>${esc(c.name)}</b> · spettacolo delle ${showTime(s)}${showDay(s) !== dayKey(new Date()) ? ` (${esc(dayLabelShort(showDay(s)))})` : ""}</div>
        <div class="go-opts">${opt("🚶", "a piedi", t.walk, "walking")}${t.bus ? opt("🚌", "bus", t.bus, "transit") : `<a class="go-opt" href="${esc(mapsUrl(s.cinema, "transit"))}" target="_blank" rel="noopener"><span class="go-ico">🚌</span><span><b>Bus</b><small>vicino: meglio a piedi</small></span></a>`}</div></div>`;
    }).join("");
    return rows ? `<h3 class="orari">Come arrivare</h3><div class="go">${rows}</div>
      <p class="hint">Tempi a piedi calcolati con OpenStreetMap; il bus è una stima (attesa compresa). Tocca per il percorso esatto su Google Maps. Uscita calcolata con ${MARGIN}′ di anticipo.</p>` : "";
  }

  function dayLabelShort(k) {
    const d = new Date(k + "T12:00:00");
    return `${GIORNI[d.getDay()]} ${d.getDate()}`;
  }

  function metaLine(info) {
    return [info.director ? "di " + info.director : null, info.year, info.duration ? info.duration + "′" : null, info.genre]
      .filter(Boolean).join(" · ");
  }

  function imgTag(info, cls) {
    const src = info.poster || info.still;
    if (!src) return `<div class="${cls} noimg" aria-hidden="true"></div>`;
    return `<img class="${cls}" src="${esc(src)}" alt="" loading="lazy" referrerpolicy="no-referrer" onerror="this.replaceWith(Object.assign(document.createElement('div'),{className:'${cls} noimg'}))">`;
  }

  function byFilm(shows, now) {
    const films = new Map();
    for (const s of shows) {
      const k = norm(s.title);
      if (!films.has(k)) films.set(k, { title: s.title, director: s.director, tags: new Set(), shows: [] });
      const f = films.get(k);
      f.shows.push(s);
      // Pop Up e Galliera scrivono i titoli in MAIUSCOLO: preferisco la grafia di CCB/Cineteca
      if (TRUSTED.has(cinemaById[s.cinema]?.group)) f.title = s.title;
      if (!f.director && s.director) f.director = s.director;
      (s.tags || []).forEach((t) => f.tags.add(t));
    }
    const upcoming = (f) => Math.min(...f.shows.map((s) => (ts(s) >= now ? ts(s) : Infinity)));
    const list = [...films.values()].sort((a, b) => (upcoming(a) - upcoming(b)) || a.title.localeCompare(b.title, "it"));
    return list.map((f) => {
      const byC = new Map();
      for (const s of f.shows) {
        if (!byC.has(s.cinema)) byC.set(s.cinema, []);
        byC.get(s.cinema).push(s);
      }
      const nextTs = upcoming(f);
      const rows = [...byC.entries()].sort((a, b) => ts(a[1][0]) - ts(b[1][0])).map(([cid, ss]) => {
        const salas = [...new Set(ss.map((s) => s.sala).filter(Boolean))];
        return `<div class="row"><div class="where">${esc(cinemaById[cid]?.name || cid)}${salas.length === 1 ? `<small>${esc(salas[0])}</small>` : ""}${travelBadge(cid)}</div>
          <div class="times">${ss.map((s) => pill(s, now, nextTs)).join("")}</div></div>`;
      }).join("");
      const info = filmInfo(f.shows);
      return `<article class="card"><button class="card-head" data-film="${esc(norm(f.title))}">
        ${imgTag(info, "thumb")}
        <span class="head-text"><h3>${esc(f.title)}</h3>
        <p class="meta">${esc(metaLine(info))}</p>${tagsHtml([...f.tags])}</span>
        <svg class="chev" viewBox="0 0 24 24" width="18" height="18" aria-hidden="true"><path d="m9 6 6 6-6 6" stroke="currentColor" stroke-width="2" fill="none" stroke-linecap="round"/></svg></button>
        <div class="rows">${rows}</div></article>`;
    }).join("");
  }

  function line(s, now, withCinema) {
    const href = s.buy || s.info || cinemaById[s.cinema]?.url;
    const sub = [withCinema ? cinemaById[s.cinema]?.name : null, s.sala, s.vos ? "V.O.S." : null, s.director ? "di " + s.director : null].filter(Boolean).join(" · ");
    return `<a class="line ${ts(s) < now ? "past" : ""}" href="${esc(href)}" target="_blank" rel="noopener">
      <span class="t">${showTime(s)}</span><span class="what"><b class="film-link" data-film="${esc(norm(s.title))}">${esc(s.title)}</b><small>${esc(sub)}</small></span></a>`;
  }

  function byCinema(shows, now) {
    const order = state.data.cinemas.map((c) => c.id);
    const groups = new Map(order.map((id) => [id, []]));
    for (const s of shows) groups.get(s.cinema)?.push(s);
    return [...groups.entries()].filter(([, ss]) => ss.length).map(([cid, ss]) => {
      const c = cinemaById[cid];
      const t = travelFor(cid);
      return `<h2 class="sec-title">${esc(c.name)} <span class="muted">· ${esc(c.address)}${t ? ` · 🚶 ${fmtMin(t.walk)}${t.bus ? ` · 🚌 ~${fmtMin(t.bus)}` : ""}` : ""}</span></h2>
        <section class="card">${ss.map((s) => line(s, now, false)).join("")}</section>`;
    }).join("");
  }

  function byTime(shows, now) {
    const slots = [["Mattina", 0, 13], ["Pomeriggio", 13, 18], ["Prima serata", 18, 20.5], ["Sera", 20.5, 30]];
    return slots.map(([label, a, b]) => {
      const ss = shows.filter((s) => { const [h, m] = showTime(s).split(":").map(Number); const x = h + m / 60; return x >= a && x < b; });
      return ss.length ? `<h2 class="sec-title">${label}</h2><section class="card">${ss.map((s) => line(s, now, true)).join("")}</section>` : "";
    }).join("");
  }


  // ------------------------------------------------------------ scheda film
  function openFilm(key) {
    const now = Date.now();
    const shows = state.data.shows.filter((s) => norm(s.title) === key && ts(s) >= now - 10 * 60e3 && !state.hidden.has(s.cinema));
    if (!shows.length) return;
    const trusted = shows.find((s) => TRUSTED.has(cinemaById[s.cinema]?.group));
    const title = (trusted || shows[0]).title;
    const info = filmInfo(shows);
    const tags = [...new Set(shows.flatMap((s) => s.tags || []))];
    const byDay = new Map();
    for (const s of shows) {
      const d = showDay(s);
      if (!byDay.has(d)) byDay.set(d, new Map());
      const m = byDay.get(d);
      if (!m.has(s.cinema)) m.set(s.cinema, []);
      m.get(s.cinema).push(s);
    }
    const today = dayKey(new Date()), tomorrow = dayKey(new Date(Date.now() + 864e5));
    const dayLabel = (k) => {
      const d = new Date(k + "T12:00:00");
      return (k === today ? "Oggi" : k === tomorrow ? "Domani" : GIORNI[d.getDay()]) + ` ${d.getDate()} ${MESI[d.getMonth()]}`;
    };
    const next = Math.min(...shows.map(ts));
    const orari = [...byDay.entries()].sort().map(([d, m]) => `<h4>${dayLabel(d)}</h4>` +
      [...m.entries()].map(([cid, ss]) => {
        const salas = [...new Set(ss.map((s) => s.sala).filter(Boolean))];
        return `<div class="row"><div class="where">${esc(cinemaById[cid]?.name)}${salas.length === 1 ? `<small>${esc(salas[0])}</small>` : ""}</div>
        <div class="times">${ss.map((s) => pill(s, now, next)).join("")}</div></div>`;
      }).join("")).join("");
    const facts = [
      ["Regia", info.director], ["Cast", info.cast], ["Paese", info.country], ["Anno", info.year],
      ["Durata", info.duration ? info.duration + " minuti" : null], ["Genere", info.genre],
    ].filter(([, v]) => v);
    const img = info.poster || info.still;
    const wide = !info.poster || info.poster === info.still;
    $("#filmBody").innerHTML = `
      ${img ? `<div class="hero ${wide ? "wide" : "tall"}"><img src="${esc(img)}" alt="" referrerpolicy="no-referrer" onerror="this.parentElement.remove()"></div>` : ""}
      <h2>${esc(title)}</h2>
      <p class="meta">${esc(metaLine(info))}</p>${tagsHtml(tags)}
      ${info.plot ? `<p class="plot">${esc(info.plot)}</p>` : ""}
      ${facts.length ? `<dl class="facts">${facts.map(([k, v]) => `<dt>${k}</dt><dd>${esc(v)}</dd>`).join("")}</dl>` : ""}
      <div class="actions">
        ${info.trailer ? `<a class="btn" href="${esc(info.trailer)}" target="_blank" rel="noopener">▶ Trailer</a>` : ""}
        ${info.links[0] ? `<a class="btn ghost" href="${esc(info.links[0])}" target="_blank" rel="noopener">Scheda sul sito</a>` : ""}
      </div>
      ${goBlock(shows.slice().sort((a, b) => ts(a) - ts(b)))}
      <h3 class="orari">Prossimi spettacoli</h3>
      <div class="rows">${orari}</div>`;
    const dlgF = $("#film");
    dlgF.showModal();
    $("#filmBody").scrollTop = 0;
  }

  $("#list").addEventListener("click", (e) => {
    const t = e.target.closest("[data-film]");
    if (!t) return;
    e.preventDefault();
    openFilm(t.dataset.film);
  });
  $("#posters").addEventListener("click", (e) => {
    const t = e.target.closest("[data-film]");
    if (t) openFilm(t.dataset.film);
  });
  $("#film").addEventListener("click", (e) => { if (e.target.id === "film" || e.target.closest(".close")) $("#film").close(); });


  // ------------------------------------------------------------ sezione Cinema (#cinema, #cinema/<id>)
  const upcoming = () => { const now = Date.now() - 10 * 60e3; return state.data.shows.filter((s) => ts(s) >= now); };

  function cinemaMapsUrl(c) {
    if (state.home) return mapsUrl(c.id, "transit");
    return `https://www.google.com/maps/search/?api=1&query=${encodeURIComponent(c.lat + "," + c.lon)}`;
  }

  function renderCinemaList() {
    const all = upcoming();
    const today = dayKey(new Date());
    const groups = {};
    for (const c of state.data.cinemas) (groups[c.group] ||= []).push(c);
    const GROUP = { CCB: "Circuito Cinema Bologna", Cineteca: "Cineteca di Bologna", "Pop Up": "Pop Up Cinema", Galliera: "Galliera" };
    // i cinema più vicini a casa per primi, se l'indirizzo è impostato
    const near = state.home && state.travel ? [...state.data.cinemas].sort((a, b) => (travelFor(a.id)?.walk ?? 999) - (travelFor(b.id)?.walk ?? 999)) : null;
    const card = (c) => {
      const ss = all.filter((s) => s.cinema === c.id);
      const films = new Set(ss.map((s) => norm(s.title))).size;
      const todayN = ss.filter((s) => showDay(s) === today).length;
      const next = ss[0];
      return `<a class="ccard" href="#cinema/${c.id}">
        <span class="ccard-main"><b>${esc(c.name)}</b><small>${esc(c.address)}</small>
        <small>${films} film · ${todayN ? todayN + (todayN === 1 ? " spettacolo oggi" : " spettacoli oggi") : "nessuno spettacolo oggi"}</small>
        ${next ? `<small class="cnext">Prossimo: ${showDay(next) === today ? "" : esc(dayLabelShort(showDay(next))) + " "}${showTime(next)} · ${esc(next.title)}</small>` : ""}
        ${travelBadge(c.id)}</span>
        <svg class="chev" viewBox="0 0 24 24" width="18" height="18" aria-hidden="true"><path d="m9 6 6 6-6 6" stroke="currentColor" stroke-width="2" fill="none" stroke-linecap="round"/></svg></a>`;
    };
    $("#cinemaPage").innerHTML = `
      <div class="cpage-head"><a class="back" href="#" aria-label="Indietro">‹</a><h2>Cinema</h2></div>
      ${near ? `<h3 class="sec-title">Più vicini a casa</h3><div class="cgrid">${near.slice(0, 3).map(card).join("")}</div>` : ""}
      ${Object.entries(groups).map(([g, list]) => `<h3 class="sec-title">${esc(GROUP[g] || g)}</h3><div class="cgrid">${list.map(card).join("")}</div>`).join("")}`;
  }

  function renderCinemaDetail(cid) {
    const c = cinemaById[cid];
    if (!c) { location.hash = "#cinema"; return; }
    const now = Date.now();
    const ss = upcoming().filter((s) => s.cinema === cid && (!state.vos || s.vos || state.italian.has(norm(s.title))));
    const byDay = new Map();
    for (const s of ss) {
      if (!byDay.has(showDay(s))) byDay.set(showDay(s), new Map());
      const m = byDay.get(showDay(s));
      const k = norm(s.title);
      if (!m.has(k)) m.set(k, []);
      m.get(k).push(s);
    }
    const today = dayKey(new Date()), tomorrow = dayKey(new Date(Date.now() + 864e5));
    const label = (k) => {
      const d = new Date(k + "T12:00:00");
      const names = ["Domenica", "Lunedì", "Martedì", "Mercoledì", "Giovedì", "Venerdì", "Sabato"];
      return (k === today ? "Oggi, " : k === tomorrow ? "Domani, " : "") + `${names[d.getDay()]} ${d.getDate()} ${MESI[d.getMonth()]}`;
    };
    const t = travelFor(cid);
    const chips = [...byDay.keys()].map((k) => {
      const d = new Date(k + "T12:00:00");
      return `<button class="day" data-jump="${k}"><small>${k === today ? "Oggi" : k === tomorrow ? "Domani" : GIORNI[d.getDay()]}</small><b>${d.getDate()}</b></button>`;
    }).join("");
    const days = [...byDay.entries()].map(([k, films]) => `
      <section class="cday" id="d-${k}"><h3 class="cday-title">${label(k)}</h3>
      <div class="card">${[...films.entries()].map(([fk, list]) => {
        const info = filmInfo(list);
        const trusted = state.data.shows.find((s) => norm(s.title) === fk && TRUSTED.has(cinemaById[s.cinema]?.group));
        const salas = [...new Set(list.map((s) => s.sala).filter(Boolean))];
        return `<div class="cfilm"><button class="cfilm-head" data-film="${esc(fk)}">${imgTag(info, "cthumb")}
          <span><b>${esc((trusted || list[0]).title)}</b><small>${esc([metaLine(info), salas.join(", ")].filter(Boolean).join(" · "))}</small></span></button>
          <div class="times">${list.map((s) => pill(s, now, -1)).join("")}</div></div>`;
      }).join("")}</div></section>`).join("");
    $("#cinemaPage").innerHTML = `
      <div class="cpage-head"><a class="back" href="#cinema" aria-label="Tutti i cinema">‹</a>
        <div><h2>${esc(c.name)}</h2><p class="muted small">${esc(c.address)}${t ? ` · 🚶 ${fmtMin(t.walk)}${t.bus ? ` · 🚌 ~${fmtMin(t.bus)}` : ""}` : ""}</p></div></div>
      <div class="actions cactions">
        <a class="btn ghost" href="${esc(cinemaMapsUrl(c))}" target="_blank" rel="noopener">📍 ${state.home ? "Percorso" : "Mappa"}</a>
        <a class="btn ghost" href="${esc(c.url)}" target="_blank" rel="noopener">Sito del cinema</a>
      </div>
      ${state.vos ? `<p class="hint">Filtro “Lingua originale” attivo.</p>` : ""}
      ${byDay.size ? `<nav class="days cdays" aria-label="Vai al giorno">${chips}</nav>${days}` : `<p class="empty">Nessuno spettacolo in programma.</p>`}`;
  }

  function route(scroll = true) {
    const h = location.hash;
    const inCinema = h.startsWith("#cinema");
    $("#homeView").hidden = inCinema;
    $("#cinemaPage").hidden = !inCinema;
    if (!state.data || !inCinema) return;
    const id = h.split("/")[1];
    id ? renderCinemaDetail(decodeURIComponent(id)) : renderCinemaList();
    if (scroll) window.scrollTo(0, 0);
  }
  window.addEventListener("hashchange", () => route(true));
  $("#cinemaPage").addEventListener("click", (e) => {
    const j = e.target.closest("[data-jump]");
    if (j) { $("#d-" + j.dataset.jump)?.scrollIntoView({ behavior: "smooth", block: "start" }); return; }
    const f = e.target.closest("[data-film]");
    if (f) openFilm(f.dataset.film);
    const b = e.target.closest(".back");
    if (b && b.getAttribute("href") === "#") { e.preventDefault(); history.replaceState(null, "", location.pathname + location.search); route(true); }
  });

  // ------------------------------------------------------------ eventi
  $("#days").addEventListener("click", (e) => {
    const b = e.target.closest(".day");
    if (!b) return;
    state.day = b.dataset.day;
    document.querySelectorAll(".day").forEach((x) => x.setAttribute("aria-pressed", x === b));
    render();
    window.scrollTo({ top: 0, behavior: "smooth" });
  });

  document.querySelectorAll(".seg button").forEach((b) => {
    b.setAttribute("aria-selected", b.dataset.view === state.view);
    b.addEventListener("click", () => {
      state.view = b.dataset.view;
      store.set("view", state.view);
      document.querySelectorAll(".seg button").forEach((x) => x.setAttribute("aria-selected", x === b));
      render();
    });
  });

  let qTimer;
  $("#q").addEventListener("input", (e) => {
    clearTimeout(qTimer);
    qTimer = setTimeout(() => { state.q = e.target.value; buildDays(); render(); }, 120);
  });

  const vosBtn = $("#vosBtn");
  vosBtn.setAttribute("aria-pressed", state.vos);
  vosBtn.addEventListener("click", () => {
    state.vos = !state.vos; store.set("vos", state.vos);
    vosBtn.setAttribute("aria-pressed", state.vos);
    buildDays(); render();
  });
  $("#pastBtn").addEventListener("click", (e) => {
    state.past = !state.past;
    e.currentTarget.setAttribute("aria-pressed", state.past);
    render();
  });

  const dlg = $("#filters");
  $("#filtersBtn").addEventListener("click", () => dlg.showModal());
  dlg.addEventListener("click", (e) => { if (e.target === dlg) dlg.close(); });
  $("#cinemaList").addEventListener("change", (e) => {
    const id = e.target.dataset.cinema;
    if (!id) return;
    e.target.checked ? state.hidden.delete(id) : state.hidden.add(id);
    saveHidden();
  });
  $("#allOn").addEventListener("click", () => { state.hidden.clear(); buildFilters(); saveHidden(); });
  $("#allOff").addEventListener("click", () => { state.data.cinemas.forEach((c) => state.hidden.add(c.id)); buildFilters(); saveHidden(); });
  // ------------------------------------------------------------ indirizzo di casa
  function showHome(msg) {
    $("#homeStatus").textContent = msg || (state.home ? `Impostato: ${state.home.label}` : "Nessun indirizzo impostato");
    $("#homeClear").hidden = !state.home;
  }
  async function setHome(home) {
    state.home = home;
    store.set("home", home);
    showHome("Calcolo i tempi di percorso…");
    try { await computeTravel(true); showHome(); } catch { showHome("Indirizzo salvato, ma il calcolo dei percorsi non è riuscito: riprova più tardi."); }
    render();
  }
  const placeLabel = (r) => {
    const a = r.address || {};
    const street = [a.road, a.house_number].filter(Boolean).join(" ");
    const area = a.suburb || a.quarter || a.neighbourhood || a.hamlet || "";
    const town = a.city || a.town || a.village || "";
    return [street || r.display_name.split(",")[0], area, town].filter(Boolean).join(", ");
  };
  $("#homeSave").addEventListener("click", async () => {
    const q = $("#homeInput").value.trim();
    if (!q) return;
    showHome("Cerco l'indirizzo…");
    $("#homeChoices").innerHTML = "";
    try {
      const url = "https://nominatim.openstreetmap.org/search?format=json&addressdetails=1&limit=5&countrycodes=it&viewbox=11.22,44.56,11.45,44.42&q=" + encodeURIComponent(/bologna/i.test(q) ? q : q + ", Bologna");
      const res = await (await fetch(url)).json();
      // tolgo i doppioni (stessa etichetta)
      const seen = new Set();
      const r = res.filter((x) => { const l = placeLabel(x); if (seen.has(l)) return false; seen.add(l); return true; });
      if (!r.length) return showHome("Indirizzo non trovato: prova a scriverlo per esteso (es. Via Giuseppe Dossetti 5).");
      if (r.length === 1) {
        await setHome({ lat: +r[0].lat, lon: +r[0].lon, label: placeLabel(r[0]) });
        $("#homeInput").value = "";
        return;
      }
      showHome("Ho trovato più indirizzi: scegli quello giusto.");
      $("#homeChoices").innerHTML = r.map((x, i) => `<button type="button" class="choice" data-i="${i}">${esc(placeLabel(x))}</button>`).join("");
      $("#homeChoices").onclick = async (e) => {
        const b = e.target.closest(".choice");
        if (!b) return;
        const x = r[+b.dataset.i];
        $("#homeChoices").innerHTML = "";
        $("#homeInput").value = "";
        await setHome({ lat: +x.lat, lon: +x.lon, label: placeLabel(x) });
      };
    } catch { showHome("Ricerca non riuscita: controlla la connessione."); }
  });
  $("#homeInput").addEventListener("keydown", (e) => { if (e.key === "Enter") { e.preventDefault(); $("#homeSave").click(); } });
  $("#homeGeo").addEventListener("click", () => {
    if (!navigator.geolocation) return showHome("Posizione non disponibile su questo dispositivo.");
    showHome("Rilevo la posizione…");
    navigator.geolocation.getCurrentPosition(
      (p) => setHome({ lat: p.coords.latitude, lon: p.coords.longitude, label: "posizione rilevata" }),
      () => showHome("Permesso di posizione negato."), { enableHighAccuracy: true, timeout: 15000 });
  });
  $("#homeClear").addEventListener("click", () => {
    state.home = null; state.travel = null;
    store.set("home", null); store.set("travel", null);
    showHome(); render();
  });
  showHome();

  function saveHidden() {
    store.set("hidden", [...state.hidden]);
    updateFilterBadge(); buildDays(); render();
  }

  // aggiorna i "passati" ogni minuto e ricarica quando l'app torna in primo piano
  setInterval(() => state.data && render(), 60e3);
  document.addEventListener("visibilitychange", () => { if (!document.hidden) load(); });

  if ("serviceWorker" in navigator && location.protocol === "https:") {
    navigator.serviceWorker.register("sw.js").catch(() => {});
  }
  load();
})();
