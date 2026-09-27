# Movies

Tonight's Film: https://markmark5.github.io/Movies/

## New this week / New this month

A GitHub Action (`.github/workflows/snapshot.yml`) runs every morning at 05:15 UTC. It records which films are on each UK service and writes the first date each film appeared to `data/arrivals.json`. The app reads that file for the **New this week** and **New this month** sort options.

### One-off setup

1. Repo → **Settings → Secrets and variables → Actions → New repository secret**. Name: `TMDB_API_KEY`, value: your TMDB key (v3 key or v4 read-access token both work).
2. **Actions** tab → enable workflows if prompted → pick **snapshot** → **Run workflow**.
3. Check that `data/arrivals.json` and `data/seen.json` appeared in the repo.

The first run is a baseline: everything already on each service is marked as "baseline", not new. Real arrivals show from the next day's run.

### Notes

- **Tracked services:** Netflix, Amazon Prime Video, BBC iPlayer, ITVX, Channel 4 and Disney Plus. To track more, add their TMDB provider IDs to `data/providers.json`, e.g. `{ "extra": [350, 531] }`. Each new service gets its own baseline on its first run.
- **Flicker protection:** a film that disappears for under 14 days and comes back is not listed as new.
- **If the schedule stops:** GitHub can pause scheduled workflows on public repos after 60 days without activity (you'll get an email). The daily data commits normally prevent this. If it happens, go to **Actions → snapshot → Enable workflow**, then **Run workflow**.
- **Manual run:** Actions → snapshot → Run workflow. Locally: `TMDB_API_KEY=... node scripts/snapshot.mjs` (Node 20+).
