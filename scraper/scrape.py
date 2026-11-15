#!/usr/bin/env python3
"""Raccoglie gli spettacoli di alcuni cinema di Bologna in un unico JSON.

Fonti:
  - Circuito Cinema Bologna (Europa, Odeon, Rialto, Roma): circuitocinemabologna.it
  - Cineteca di Bologna (Lumière, Cervi, Modernissimo): cinetecadibologna.it
  - Pop Up Cinema (Jolly, Arlecchino, Medica, Bristol): *.popupcinema.18tickets.it
  - Cinema Teatro Galliera: cinemateatrogalliera.it (agenda testuale)

Solo libreria standard: gira ovunque ci sia Python 3.9+.
Uso: python3 scraper/scrape.py --out docs/data/showtimes.json
"""
from __future__ import annotations

import argparse
import datetime as dt
import html
import json
import re
import sys
import time
import urllib.request
from pathlib import Path

try:
    from zoneinfo import ZoneInfo
    TZ = ZoneInfo("Europe/Rome")
except Exception:  # pragma: no cover - fallback senza tzdata
    TZ = dt.timezone(dt.timedelta(hours=1))

UA = ("Mozilla/5.0 (compatible; CinemaBolognaBot/1.0; uso personale; "
      "aggrega orari per un'app privata)")
DAYS_AHEAD = 10

CINEMAS = [
    {"id": "europa", "name": "Europa", "group": "CCB", "address": "Via Pietralata 55/a",
     "url": "https://www.circuitocinemabologna.it/"},
    {"id": "odeon", "name": "Odeon", "group": "CCB", "address": "Via Mascarella 3",
     "url": "https://www.circuitocinemabologna.it/"},
    {"id": "rialto", "name": "Rialto", "group": "CCB", "address": "Via Rialto 19",
     "url": "https://www.circuitocinemabologna.it/"},
    {"id": "roma", "name": "Roma d'Essai", "group": "CCB", "address": "Via Fondazza 4",
     "url": "https://www.circuitocinemabologna.it/"},
    {"id": "lumiere", "name": "Lumière", "group": "Cineteca", "address": "Piazzetta P. P. Pasolini 3/b",
     "url": "https://cinetecadibologna.it/programmazione/film-in-programma/"},
    {"id": "cervi", "name": "Cervi", "group": "Cineteca", "address": "Via Riva di Reno 72",
     "url": "https://cinetecadibologna.it/programmazione/film-in-programma/"},
    {"id": "modernissimo", "name": "Modernissimo", "group": "Cineteca", "address": "Piazza Re Enzo",
     "url": "https://cinetecadibologna.it/programmazione/film-in-programma/"},
    {"id": "galliera", "name": "Galliera", "group": "Galliera", "address": "Via Matteotti 27",
     "url": "https://www.cinemateatrogalliera.it/"},
    {"id": "jolly", "name": "Jolly", "group": "Pop Up", "address": "Via Marconi 14",
     "url": "https://jolly.popupcinema.18tickets.it/"},
    {"id": "arlecchino", "name": "Arlecchino", "group": "Pop Up", "address": "Via delle Lame 59",
     "url": "https://arlecchino.popupcinema.18tickets.it/"},
    {"id": "medica", "name": "Medica", "group": "Pop Up", "address": "Via Monte Grappa 9",
     "url": "https://medica.popupcinema.18tickets.it/"},
    {"id": "bristol", "name": "Bristol", "group": "Pop Up", "address": "Via Toscana 146",
     "url": "https://bristol.popupcinema.18tickets.it/"},
]


# ---------------------------------------------------------------- utilità

def fetch(url: str, tries: int = 3) -> str:
    last = None
    for i in range(tries):
        try:
            req = urllib.request.Request(url, headers={"User-Agent": UA, "Accept-Language": "it-IT,it"})
            with urllib.request.urlopen(req, timeout=30) as r:
                return r.read().decode("utf-8", errors="replace")
        except Exception as e:  # noqa: BLE001
            last = e
            time.sleep(2 * (i + 1))
    raise RuntimeError(f"{url}: {last}")


def text(fragment: str) -> str:
    """HTML -> testo su una riga."""
    fragment = re.sub(r"<(script|style)\b.*?</\1>", " ", fragment, flags=re.S | re.I)
    fragment = re.sub(r"<[^>]+>", " ", fragment)
    return re.sub(r"\s+", " ", html.unescape(fragment)).strip()


def is_caps(t: str) -> bool:
    letters = [c for c in t if c.isalpha()]
    return bool(letters) and sum(c.isupper() for c in letters) / len(letters) > 0.8


def nice_title(t: str) -> str:
    """Titoli TUTTI MAIUSCOLI -> "Maiuscola iniziale" all'italiana (lascia stare quelli già misti)."""
    t = re.sub(r"\s+", " ", t).strip()
    if not is_caps(t):
        return t
    t = t.lower()
    up = lambda m: m.group(1) + m.group(2).upper()  # noqa: E731
    t = re.sub(r"^([^\w]*)(\w)", up, t)                        # inizio
    t = re.sub(r"([:(.!?–-]\s*[\"'«“]?)(\w)", up, t)            # dopo : ( – ecc.
    t = re.sub(r"\b(ii|iii|iv|vi|vii|viii|ix|xi|xii)\b", lambda m: m.group(1).upper(), t)
    t = re.sub(r"\b(vos|v\.o\.s\.?|\d+k|3d|2d|usa|uk|tv)\b", lambda m: m.group(1).upper(), t)
    return t.replace("'", "’")


VOS_RE = re.compile(r"\b(v\.?\s?o\.?\s?s\.?|original version|versione originale|lingua originale)\b", re.I)


def clean_vos_title(t: str) -> str:
    t = re.sub(r"\s*[-–]?\s*\(?original version\)?\s*$", "", t, flags=re.I)
    t = re.sub(r"\s*\(?\bv\.?o\.?s\.?\)?\s*$", "", t, flags=re.I)
    return t.strip(" -–")


def short_tags(tags, n=3):
    out = []
    for t in tags:
        t = (t or "").strip()
        if t and len(t) <= 40 and t.lower() not in (x.lower() for x in out):
            out.append(t[0].upper() + t[1:].lower() if is_caps(t) else t)
    return out[:n]


def sala_name(cinema: str, raw):
    """'Odeon c' -> 'Sala C', 'Rialto 2' -> 'Sala 2', 'Europa cinema' -> None."""
    if not raw:
        return None
    raw = raw.strip()
    rest = re.sub(r"^" + re.escape(cinema) + r"\b", "", raw, flags=re.I).strip()
    if rest.lower() in ("", "cinema", "d'essai", "d’essai"):
        return None
    if len(rest) <= 2:
        return "Sala " + rest.upper()
    return raw


def iso(d: dt.datetime) -> str:
    if d.tzinfo is None:
        d = d.replace(tzinfo=TZ)
    return d.astimezone(TZ).isoformat(timespec="minutes")


# ---------------------------------------------------------------- CCB

CCB_MAP = {"europa": "europa", "odeon": "odeon", "rialto": "rialto", "roma": "roma"}


def scrape_ccb() -> list[dict]:
    page = fetch("https://www.circuitocinemabologna.it/")
    shows, seen = [], set()
    for art in re.finditer(r'<article class="film-list--item"(.*?)</article>', page, re.S):
        block = art.group(0)
        m = re.search(r'<span class="item-projections">(.*?)</span>', block, re.S)
        if not m:
            continue
        try:
            projections = json.loads(html.unescape(m.group(1)))
        except json.JSONDecodeError:
            continue
        t = re.search(r'class="title-medium item-title">\s*<a href="([^"]+)">(.*?)</a>', block, re.S)
        title = text(t.group(2)) if t else "?"
        info = t.group(1) if t else None
        sub = re.search(r'class="text item-subtitle">(.*?)</p>', block, re.S)
        director = re.sub(r"^di\s+", "", text(sub.group(1))) if sub else None
        vos = 'data-vos="true"' in block
        labels = [text(x) for x in re.findall(r'class="label[^"]*">(.*?)</div>', block, re.S)]
        labels = [x for x in labels if x and x.lower() not in ("v.o.s", "v.o.s.")]
        img = re.search(r'data-image="([^"]+)"', block)
        for p in projections:
            pid = p.get("projection_public_id") or p.get("projection_url")
            if pid in seen:
                continue
            seen.add(pid)
            cid = CCB_MAP.get((p.get("cinema_name") or "").strip().lower())
            if not cid:
                continue
            start = dt.datetime.fromisoformat(p["start"].replace("Z", "+00:00"))
            shows.append({
                "cinema": cid,
                "sala": sala_name(cid, p.get("theater_name")),
                "title": nice_title(title),
                "director": director,
                "start": iso(start),
                "vos": vos,
                "tags": short_tags(labels),
                "buy": p.get("projection_url"),
                "info": info,
                "image": img.group(1) if img else None,
            })
    return shows


# ---------------------------------------------------------------- Cineteca

def cineteca_venue(where: str):
    w = where.lower()
    if "lumi" in w:
        sala = where.split("|", 1)[1].strip() if "|" in where else None
        return "lumiere", sala
    if "cervi" in w:
        return "cervi", None
    if "modernissimo" in w:
        return "modernissimo", None
    return None, None


def scrape_cineteca() -> list[dict]:
    shows, seen = [], set()
    today = dt.datetime.now(TZ).date()
    for i in range(DAYS_AHEAD):
        day = today + dt.timedelta(days=i)
        url = f"https://cinetecadibologna.it/programmazione/film-in-programma/?data={day.isoformat()}"
        try:
            page = fetch(url)
        except RuntimeError as e:
            print("  cineteca:", e, file=sys.stderr)
            continue
        for art in re.finditer(r'<article id="c-repeat-loop-(\d+)" class="c-repeat-loop.*?</article>', page, re.S):
            rid, block = art.group(1), art.group(0)
            if rid in seen:
                continue
            tm = re.search(r'c-repeat-loop__time"\s*>\s*H\s*(\d{1,2})[:.](\d{2})', block)
            dm = re.search(r'datetime="(\d{4}-\d{2}-\d{2})', block)
            wm = re.search(r'c-repeat-loop__where">(.*?)</div>', block, re.S)
            if not (tm and dm and wm):
                continue
            cid, sala = cineteca_venue(text(wm.group(1)))
            if not cid:
                continue
            seen.add(rid)
            d = dt.date.fromisoformat(dm.group(1))
            start = dt.datetime(d.year, d.month, d.day, int(tm.group(1)), int(tm.group(2)), tzinfo=TZ)
            title_m = re.search(r'c-repeat-loop__title[^>]*>(.*?)</h6>', block, re.S)
            title = text(title_m.group(1)) if title_m else "?"
            info_m = re.search(r'c-repeat-loop__title-info">(.*?)</p>', block, re.S)
            subtitle = text(info_m.group(1)) if info_m else ""
            director = None
            dmatch = re.search(r"\bdi\s+(.+?)(?:\s*\(\d+.?\))?$", subtitle)
            if dmatch:
                director = dmatch.group(1).strip()
            labels = [text(x) for x in re.findall(r'c-repeat-loop__label c-repeat-loop__label--\d[^"]*"\s*>(.*?)</div>', block, re.S)]
            infos = [text(x) for x in re.findall(r'c-repeat-loop__info-item-text">(.*?)</div>', block, re.S)]
            body = text(block)
            vos = bool(re.search(r"versione originale|lingua originale", body, re.I)) and not re.search(r"in lingua italiana", body, re.I)
            buy = re.search(r'href="(https://[^"]*18tickets[^"]*)"', block)
            info = re.search(r'href="(https://cinetecadibologna\.it/programmazione/proiezione/[^"]+)"', block)
            img = re.search(r'<img[^>]+src="([^"]+)"', block)
            tags = short_tags([x for x in labels + infos if not VOS_RE.search(x)
                               and not re.search(r"lingua italiana|doppiaggio", x, re.I)])
            shows.append({
                "cinema": cid,
                "sala": sala,
                "title": nice_title(title),
                "director": director,
                "start": iso(start),
                "vos": vos,
                "tags": tags,
                "buy": html.unescape(buy.group(1)) if buy else None,
                "info": html.unescape(info.group(1)) if info else None,
                "image": img.group(1) if img else None,
            })
        time.sleep(0.5)
    return shows


# ---------------------------------------------------------------- Pop Up (18tickets)

def scrape_popup_one(cid: str) -> list[dict]:
    base = f"https://{cid}.popupcinema.18tickets.it"
    page = fetch(base + "/")
    shows = []
    # Ogni film inizia col primo link movie__title verso /film/<id>; lo spezzo per film.
    starts = [(m.start(), m.group(1), text(m.group(2)))
              for m in re.finditer(r"<a class='movie__title' href='[^']*/film/(\d+)'>\s*([^<]+?)\s*</a>", page)]
    blocks, last_id = [], None
    for n, (pos, fid, title) in enumerate(starts):
        if fid == last_id:
            continue
        last_id = fid
        blocks.append((pos, fid, title))
    for n, (pos, fid, title) in enumerate(blocks):
        end = blocks[n + 1][0] if n + 1 < len(blocks) else len(page)
        block = page[pos:end]
        lang = re.search(r"Lingua:\s*</strong>\s*([^<]+)", block)
        lang = lang.group(1).strip() if lang else ""
        director = re.search(r"Regia:\s*</strong>\s*([^<]+)", block)
        director = director.group(1).strip() if director else None
        labels = [text(x) for x in re.findall(r"<div class='film-label small-label'>(.*?)</div>", block, re.S)]
        vos = bool(VOS_RE.search(title)) or "VOS" in labels or (lang and lang.lower() != "italiano")
        img = re.search(r"<img alt='[^']*' class='img-fluid[^']*' src='([^']+)'", block)
        tags = short_tags([x for x in labels if x and x.upper() not in ("VOS", "NOVITÀ", "NOVITA")])
        for a in re.finditer(r"<a data-time='(\d+)' href='([^']+)'>(.*?)</a>", block, re.S):
            ts = int(a.group(1)) / 1000
            start = dt.datetime.fromtimestamp(ts, TZ)
            li = text(a.group(3))
            sala = re.sub(r"^\d{1,2}:\d{2}\s*", "", li).strip() or None
            shows.append({
                "cinema": cid,
                "sala": sala if sala and sala.lower() != cid else None,
                "title": nice_title(clean_vos_title(title)),
                "director": director,
                "start": iso(start),
                "vos": bool(vos),
                "tags": tags,
                "buy": html.unescape(a.group(2)),
                "info": f"{base}/film/{fid}",
                "image": img.group(1) if img else None,
            })
    return shows


def scrape_popup() -> list[dict]:
    out = []
    for cid in ("jolly", "arlecchino", "medica", "bristol"):
        try:
            out += scrape_popup_one(cid)
        except RuntimeError as e:
            print("  popup:", e, file=sys.stderr)
    return out


# ---------------------------------------------------------------- Galliera

MESI = {m: i + 1 for i, m in enumerate(
    "gennaio febbraio marzo aprile maggio giugno luglio agosto settembre ottobre novembre dicembre".split())}


DIR_PARTICLES = {"e", "de", "del", "della", "di", "da", "van", "von", "der", "la", "le", "el", "y", "bin"}


def galliera_title(desc: str):
    """'IL TEMPO E L’ACQUA V.O.S. di Sara Dosa prima visione' -> ('IL TEMPO E L’ACQUA', 'Sara Dosa')."""
    words = desc.replace("V.O.S.*", "V.O.S.").split()
    title = []
    i = 0
    while i < len(words) and (is_caps(words[i]) or not re.search(r"[a-zà-ÿ]", words[i])):
        title.append(words[i])
        i += 1
    if not title:  # titolo non in maiuscolo (es. "RASSEGNAti – ... con OBSESSION di ...")
        con = re.search(r"\bcon\s+([A-ZÀ-Ý0-9][A-ZÀ-Ý0-9 ’'&:.!?-]{2,}?)\s+di\s+([A-ZÀ-Ý]\w+(?:\s+[A-ZÀ-Ý]\w+)?)", desc)
        if con:
            return con.group(1).strip(), con.group(2)
        m = re.match(r"(.+?)(?:\s+di\s+([A-ZÀ-Ý].*))?$", desc)
        t = m.group(1)
        t = re.sub(r"\s*\|.*$", "", t) if len(t) > 50 else t
        director = None
        if m.group(2):
            director = " ".join(w for w in m.group(2).split()[:3] if not is_caps(w) and w not in ("in",))
        return t.strip(" *|"), director or None
    director = None
    if i < len(words) and words[i] == "di":
        dw = []
        for w in words[i + 1:]:
            if w in ("|", "in") or (is_caps(w) and len(re.sub(r"\W", "", w)) >= 2) or \
               (w[:1].islower() and w not in DIR_PARTICLES):
                break
            dw.append(w)
        director = " ".join(dw).strip(" ,*") or None
    t = " ".join(title)
    t = re.sub(r"\s*\|?\s*V\.O\.S\.?\s*\*?", " ", t)
    t = re.sub(r"\s*\|\s*$", "", t).strip(" *|")
    return t, director


def scrape_galliera() -> list[dict]:
    home = fetch("https://www.cinemateatrogalliera.it/")
    # L'agenda è un post che cambia URL ogni anno (agenda-spettacoli-2026, ...): lo cerco in homepage.
    link = re.search(r'href="(https://www\.cinemateatrogalliera\.it/agenda-spettacoli[^"#]*)"', home)
    page = home
    if link:
        try:
            page = fetch(link.group(1))
        except RuntimeError:
            page = home
    m = re.search(r'<div class="entry-content">(.*?)<div class="entry-info">', page, re.S) or \
        re.search(r'<div class="entry-content">(.*)', page, re.S)
    if not m:
        raise RuntimeError("agenda Galliera non trovata")
    content = m.group(1)
    agenda_url = link.group(1) if link else "https://www.cinemateatrogalliera.it/"
    # link dei titoli: testo -> url
    links = {text(t).upper(): u for u, t in re.findall(r'<a[^>]+href="(https://www\.cinemateatrogalliera\.it/[^"]+)"[^>]*>(.*?)</a>', content, re.S)}
    plain = text(content)
    # dopo l'agenda il post contiene schede descrittive con altre date: mi fermo prima
    plain = re.split(r"PRENOTARE SI PU", plain)[0]
    plain = re.sub(r"[—-]{4,}", " ", plain)
    now = dt.datetime.now(TZ)
    shows = []
    day_re = (r"(?:●|\bin replica\s*>|>)?\s*(?:luned[iì]|marted[iì]|mercoled[iì]|gioved[iì]|venerd[iì]|sabato|domenica)"
              r"\s+(\d{1,2})°?\s+(gennaio|febbraio|marzo|aprile|maggio|giugno|luglio|agosto|settembre|ottobre|novembre|dicembre)")
    marks = list(re.finditer(day_re, plain, re.I))
    for n, day in enumerate(marks):
        rest = plain[day.end(): marks[n + 1].start() if n + 1 < len(marks) else len(plain)]
        dnum, mese = int(day.group(1)), day.group(2).lower()
        year = now.year + (1 if MESI[mese] < now.month - 2 else 0)
        try:
            d = dt.date(year, MESI[mese], dnum)
        except ValueError:
            continue
        head = re.match(r"\s*\|\s*([^|]*?)\s*(?=ore\s)", rest)
        day_tag = head.group(1).strip() if head else None
        for ev in re.finditer(r"ore\s+(\d{1,2})[:.](\d{2})\s+(.*?)(?=\bore\s+\d{1,2}[:.]\d{2}|$)", rest, re.S):
            hh, mm, desc = int(ev.group(1)), int(ev.group(2)), ev.group(3).strip()
            desc = re.sub(r"\bPROSSIMAMENTE\b.*$", "", desc).strip()
            title, director = galliera_title(desc)
            vos = "V.O.S" in desc.upper()
            tags = [day_tag.capitalize()] if day_tag else []
            ex = desc.lower()
            if "prima visione esclusiva" in ex:
                tags.append("Prima visione esclusiva")
            elif "prima visione" in ex:
                tags.append("Prima visione")
            if "ultima proiezione" in ex:
                tags.append("Ultima proiezione")
            if "salaopen" in ex:
                tags.append("SalaOpen")
            key = re.sub(r"[^A-Z0-9]", "", title.upper())
            info = next((u for t, u in links.items() if key and re.sub(r"[^A-Z0-9]", "", t) == key), None)
            shows.append({
                "cinema": "galliera",
                "sala": None,
                "title": nice_title(title[:120]),
                "director": director,
                "start": iso(dt.datetime(d.year, d.month, d.day, hh, mm, tzinfo=TZ)),
                "vos": vos,
                "tags": short_tags(tags),
                "buy": "https://linktr.ee/Galliera_Prenotazioni",
                "info": info or agenda_url,
                "image": None,
            })
    return shows


# ---------------------------------------------------------------- schede film

FILM_TTL_DAYS = 7
YT_RE = re.compile(r"(https?://(?:www\.)?(?:youtube\.com/(?:embed/|watch\?v=)|youtu\.be/)[\w-]{6,})")


def film_key(url):
    """La pagina scheda identifica il film (senza ?repeat= ecc.)."""
    return url.split("?")[0].split("#")[0].rstrip("/") if url else None


def yt(url):
    if not url:
        return None
    m = re.search(r"(?:embed/|v=|youtu\.be/)([\w-]{6,})", url)
    return f"https://www.youtube.com/watch?v={m.group(1)}" if m else None


def between(t, label, labels):
    """Valore dopo 'label:' fino alla prossima etichetta nota."""
    stop = "|".join(re.escape(x) for x in labels if x != label)
    m = re.search(r"\b" + re.escape(label) + r"\s*:\s*(.*?)\s*(?=\b(?:" + stop + r")\s*:|Prossime proiezioni|$)", t, re.S)
    return m.group(1).strip(" .,") if m else None


def minutes(v):
    m = re.search(r"(\d{2,3})", v or "")
    return int(m.group(1)) if m else None


def og_image(page):
    m = re.search(r'<meta property="og:image" content="([^"]+)"', page)
    return html.unescape(m.group(1)) if m and "gravatar" not in m.group(1) else None


def detail_ccb(url, page):
    main = page.split('id="proiezioni"')[0]
    t = text(main)
    labels = ["Con", "Paese", "Durata", "Età", "Lingua", "Genere", "Trama", "Trailer", "Prossime proiezioni"]
    d = {
        "cast": between(t, "Con", labels),
        "country": between(t, "Paese", labels),
        "duration": minutes(between(t, "Durata", labels)),
        "genre": between(t, "Genere", labels),
        "plot": None,
        "trailer": None,
        "poster": None,
    }
    m = re.search(r'Trama:\s*</p>\s*<p class="text item-desc[^"]*">(.*?)</p>', page, re.S)
    if m:
        d["plot"] = text(m.group(1))
    m = YT_RE.search(page)
    d["trailer"] = yt(m.group(1)) if m else None
    d["still"] = og_image(page)
    return d


def detail_cineteca(url, page):
    d = {}
    m = re.search(r'c-loop-show-movie__title-info[^>]*>(.*?)</p>', page, re.S)
    info = text(m.group(1)) if m else ""
    m = re.search(r"\(([^()]*?)/(\d{4})\)", info)
    if m:
        d["country"] = m.group(1).replace("-", ", ")
        d["year"] = int(m.group(2))
    m = re.search(r"\((\d{2,3})['’′]\)", info)
    d["duration"] = int(m.group(1)) if m else None
    m = re.search(r'c-loop-show-movie__cast[^>]*>(.*?)</p>', page, re.S)
    d["cast"] = re.sub(r"^Con:\s*", "", text(m.group(1))) if m else None
    m = re.search(r'c-show-single-description__content">(.*?)</div>', page, re.S)
    d["plot"] = text(m.group(1)) if m else None
    m = YT_RE.search(page)
    d["trailer"] = yt(m.group(1)) if m else None
    d["still"] = og_image(page)
    return d


def detail_popup(url, page):
    t = text(page)
    labels = ["Regia", "Anno", "Con", "Trama", "Info", "Genere", "Lingua"]
    d = {
        "year": None, "cast": None, "plot": None, "genre": None, "duration": None,
    }
    y = between(t, "Anno", labels)
    d["year"] = int(y) if y and y.isdigit() else None
    d["cast"] = (between(t, "Con", labels) or "").rstrip(".… ") or None
    m = re.search(r"Trama\s+(.*?)\s+Info\b", t, re.S)
    d["plot"] = m.group(1).strip() if m else None
    m = re.search(r"Info\s+(\d{2,3})\s*min", t)
    d["duration"] = int(m.group(1)) if m else None
    g = re.search(r"Genere:\s*(.*?)\s+Lingua:", t)
    d["genre"] = g.group(1).strip() if g else None
    m = YT_RE.search(page)
    d["trailer"] = yt(m.group(1)) if m else None
    m = re.search(r"<img alt='[^']*' class='img-fluid[^']*' src='([^']+)'", page)
    d["poster"] = m.group(1) if m else None
    return d


def detail_galliera(url, page):
    c = re.search(r'<div class="entry-content">(.*?)<div class="entry-(?:info|utility)', page, re.S)
    body = c.group(1) if c else page
    paras = [text(x) for x in re.findall(r"<p[^>]*>(.*?)</p>", body, re.S)]
    d = {}
    head = paras[0] if paras else ""
    m = re.search(r"\(([^|()]+)\|\s*(\d{4})\)", head)
    if m:
        d["country"] = m.group(1).strip()
        d["year"] = int(m.group(2))
    m = re.search(r"\)\s*([a-zà-ÿ ,/]+?)\s*\|\s*durata", head)
    d["genre"] = m.group(1).strip().capitalize() if m else None
    m = re.search(r"durata\s+(\d{2,3})", head)
    d["duration"] = int(m.group(1)) if m else None
    m = re.search(r"\bcon\s+(.+?)\.?$", head)
    d["cast"] = re.sub(r"(\s+[A-ZÀ-Ý]{2,}\b)+\s*$", "", m.group(1)).strip() if m else None
    skip = re.compile(r"^(agenda|prenotare|opzione|\*v\.o\.s|note tecniche|ingressi|proiezioni svolte)", re.I)
    plot = [x for x in paras[1:] if len(x) > 150 and not skip.search(x)]
    d["plot"] = plot[0] if plot else None
    m = YT_RE.search(body)
    d["trailer"] = yt(m.group(1)) if m else None
    m = re.search(r'<img[^>]+class="[^"]*wp-image-[^"]*"[^>]+src="([^"]+)"', body) or \
        re.search(r'<img[^>]+src="([^"]+)"[^>]+class="[^"]*wp-image-', body)
    d["still"] = m.group(1) if m else None
    return d


DETAIL_PARSERS = [
    ("circuitocinemabologna.it/film/", detail_ccb),
    ("cinetecadibologna.it/programmazione/proiezione/", detail_cineteca),
    ("popupcinema.18tickets.it/film/", detail_popup),
    ("cinemateatrogalliera.it/", detail_galliera),
]


def build_films(shows, previous):
    """Scarica (o riprende dalla cache) la scheda di ogni film in programmazione."""
    old = previous.get("films", {}) if isinstance(previous.get("films"), dict) else {}
    now = dt.datetime.now(TZ)
    films, fetched = {}, 0
    for s in shows:
        url = s.get("info")
        key = film_key(url)
        if not key or key in films:
            s["film"] = key
            continue
        s["film"] = key
        cached = old.get(key)
        if cached and cached.get("fetched_at"):
            age = now - dt.datetime.fromisoformat(cached["fetched_at"])
            if age.days < FILM_TTL_DAYS:
                films[key] = cached
                continue
        parser = next((f for pat, f in DETAIL_PARSERS if pat in key), None)
        if not parser or "agenda-spettacoli" in key:
            continue
        try:
            d = parser(url, fetch(url))
            fetched += 1
            time.sleep(0.3)
        except Exception as e:  # noqa: BLE001
            print(f"  scheda {key}: {e}", file=sys.stderr)
            if cached:
                films[key] = cached
            continue
        d = {k: v for k, v in d.items() if v}
        if d.get("plot") and len(d["plot"]) > 1500:
            d["plot"] = d["plot"][:1500].rsplit(" ", 1)[0] + "…"
        d["fetched_at"] = iso(now)
        films[key] = d
    # se la scheda non ha immagini uso quella della lista
    for s in shows:
        f = films.get(s.get("film"))
        if f is None or not s.get("image"):
            continue
        # CCB e Pop Up nella lista usano la locandina verticale; Cineteca un fotogramma
        if SOURCE_OF.get(s["cinema"]) in ("ccb", "popup"):
            f.setdefault("poster", s["image"])
        elif not (f.get("poster") or f.get("still")):
            f["still"] = s["image"]
    print(f"  schede film: {len(films)} ({fetched} scaricate ora)", file=sys.stderr)
    return films


# ---------------------------------------------------------------- main

SOURCES = {
    "ccb": scrape_ccb,
    "cineteca": scrape_cineteca,
    "popup": scrape_popup,
    "galliera": scrape_galliera,
}


def main() -> int:
    ap = argparse.ArgumentParser()
    ap.add_argument("--out", default="docs/data/showtimes.json")
    ap.add_argument("--only", nargs="*", help="solo queste fonti")
    args = ap.parse_args()

    out_path = Path(args.out)
    previous = {}
    if out_path.exists():
        try:
            previous = json.loads(out_path.read_text())
        except Exception:  # noqa: BLE001
            previous = {}

    now = dt.datetime.now(TZ)
    horizon_start = now.replace(hour=0, minute=0, second=0, microsecond=0)
    shows, status = [], {}
    for name, fn in SOURCES.items():
        if args.only and name not in args.only:
            continue
        print(f"→ {name}", file=sys.stderr)
        try:
            got = fn()
            status[name] = {"ok": True, "count": len(got)}
        except Exception as e:  # noqa: BLE001
            print(f"  ERRORE {name}: {e}", file=sys.stderr)
            status[name] = {"ok": False, "error": str(e)[:200]}
            # se una fonte fallisce tengo i suoi spettacoli precedenti
            cids = {c["id"] for c in CINEMAS if SOURCE_OF[c["id"]] == name}
            got = [s for s in previous.get("shows", []) if s.get("cinema") in cids]
        shows += got

    shows = [s for s in shows if dt.datetime.fromisoformat(s["start"]) >= horizon_start]
    shows.sort(key=lambda s: (s["start"], s["cinema"], s["title"]))
    films = build_films(shows, previous)
    data = {
        "generated_at": iso(now),
        "sources": status,
        "cinemas": CINEMAS,
        "shows": shows,
        "films": films,
    }
    out_path.parent.mkdir(parents=True, exist_ok=True)
    out_path.write_text(json.dumps(data, ensure_ascii=False, indent=1))
    print(f"✓ {len(shows)} spettacoli → {out_path}", file=sys.stderr)
    for k, v in status.items():
        print(f"  {k}: {v}", file=sys.stderr)
    return 0 if any(v["ok"] for v in status.values()) else 1


SOURCE_OF = {
    "europa": "ccb", "odeon": "ccb", "rialto": "ccb", "roma": "ccb",
    "lumiere": "cineteca", "cervi": "cineteca", "modernissimo": "cineteca",
    "galliera": "galliera",
    "jolly": "popup", "arlecchino": "popup", "medica": "popup", "bristol": "popup",
}

if __name__ == "__main__":
    sys.exit(main())
