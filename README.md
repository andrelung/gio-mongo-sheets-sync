# gio-mongo-sheets-sync

Small utility to aggregate `tasks` in MongoDB and write per-project, per-assignee hours to a Google Sheet. The project is TypeScript but kept minimal.

Quick start

```bash
npm install
# dev run (requires no build)
npm run dev

# or build and run
npm run build
npm start
```

Configuration

-   Place Google service account JSON at `credentials/google_sheets_client_secret.json`.
-   You can provide the MongoDB connection string via the environment variable `MONGO_URI` or by creating `credentials/mongodb-connection-uri.txt`. The code falls back to the hardcoded URI if neither is present (not recommended for production).

Notes

-   `main.ts` contains the core aggregation pipeline and sheet-writing logic.
-   The repo includes a `debugger;` statement to help attach a debugger during development.
