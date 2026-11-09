# Connection Intelligence

Upload your LinkedIn `Connections.csv`, let it enrich, then ask questions about your network in plain English.

Static site (HTML + CSS + ES modules, no build step), hosted on GitHub Pages.

## How it works
1. **Upload**: `create-linkedin-dataset` (Supabase edge function) stores the CSV and creates the `li_datasets` row.
2. **Enrich**: the site calls the **Unified** Apex flow with `{"dataset_id": "…"}` until it reports `WAITING_FOR_QUERY`.
3. **Ask**: each question goes to the **05A** Apex flow; results render as cards.

All endpoints are in `config.js`.

## Run locally
```bash
python -m http.server 5190
```
Then open http://localhost:5190 (opening `index.html` directly from disk will not work).

## Edge function
`supabase/functions/create-linkedin-dataset` — deploy with JWT verification **off**.
