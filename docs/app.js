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
    const g = new Date(state.data.generated_at);
    $("#updated").textContent = `Aggiornato ${g.getDate()} ${MESI[g.getMonth()]} alle ${String(g.getHours()).padStart(2, "0")}:${String(g.getMinutes()).padStart(2, "0")}`;
    buildDays();
    buildFilters();
    render();
  }

  function visibleShows() {
    const q = norm(state.q);
    return state.data.shows.filter((s) =>
      !state.hidden.has(s.cinema) &&
      (!state.vos || s.vos) &&
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
        return `<div class="row"><div class="where">${esc(cinemaById[cid]?.name || cid)}${salas.length === 1 ? `<small>${esc(salas[0])}</small>` : ""}</div>
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
      return `<h2 class="sec-title">${esc(c.name)} <span class="muted">· ${esc(c.address)}</span></h2>
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
  $("#film").addEventListener("click", (e) => { if (e.target.id === "film" || e.target.closest(".close")) $("#film").close(); });

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
