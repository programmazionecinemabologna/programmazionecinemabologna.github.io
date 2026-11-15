# Cinema Bologna

App per il telefono che raccoglie in un'unica lista gli spettacoli di:

- **Circuito Cinema Bologna**: Europa, Odeon, Rialto, Roma d'Essai
- **Cineteca di Bologna**: Lumière, Cervi, Modernissimo
- **Pop Up Cinema**: Jolly, Arlecchino, Medica, Bristol
- **Cinema Teatro Galliera**

## Come funziona

- `scraper/scrape.py` legge i siti dei cinema e scrive `docs/data/showtimes.json` (solo libreria standard di Python).
  Per ogni film scarica anche la scheda (locandina o fotogramma, trama, cast, durata, genere, trailer);
  le schede restano in cache nel JSON per 7 giorni, così ogni aggiornamento scarica solo i film nuovi.
- `.github/workflows/update.yml` lo esegue su GitHub ogni 3 ore e salva il JSON aggiornato.
- `docs/` è l'app (HTML/CSS/JS statici), pubblicata gratis con GitHub Pages e installabile sulla schermata Home.

## Pubblicazione su GitHub (una volta sola)

1. Crea un repository (anche privato va bene solo con GitHub Pro; altrimenti pubblico) e carica questi file.
2. **Settings → Pages**: Source "Deploy from a branch", branch `main`, cartella `/docs`.
3. **Actions → Aggiorna orari → Run workflow** per il primo aggiornamento.
4. Apri `https://<utente>.github.io/<repo>/` dal telefono:
   - iPhone (Safari): Condividi → *Aggiungi alla schermata Home*
   - Android (Chrome): menu ⋮ → *Installa app*

## Provare in locale

```bash
python3 scraper/scrape.py --out docs/data/showtimes.json
python3 -m http.server -d docs 8000
```

## Se un cinema smette di funzionare

I siti cambiano: se una fonte fallisce, l'app mostra un avviso e lo scraper tiene gli
ultimi orari noti di quella fonte. Il risultato di ogni fonte è in `sources` dentro il JSON.
