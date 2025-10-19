# gio-mongo-sheets-sync

Small utility to aggregate `tasks` in MongoDB and write per-project, per-assignee hours to a Google Sheet. The project is TypeScript but kept minimal.

Quick start

```bash
git clone https://github.com/andrelung/gio-mongo-sheets-sync
cd gio-mongo-sheets-sync
npm install

# dev run (requires no build)
npm run dev

# or build and run
npm run build
npm start
```

Configuration

-   Create a personal env-file: `cp .env.example .env`
-   Fill in your google account data `nano .env`.
-   Provide the MongoDB connection string via the environment variable `MONGO_URI`
-   The code fails hard if neither is present (not recommended for production).

Notes

-   `main.ts` contains the core aggregation pipeline and sheet-writing logic.
-   This project relies on https://github.com/andrelung/asana-to-mongo-replicator

# Run with Docker

Build the image:

```bash
docker build -t gio-mongo-sheets-sync:latest .
```

Run with docker-compose:

```bash
docker compose up --build -d
```

Notes:

-   It's recommended to keep secrets out of the image. Use `.env` to load at runtime.
-   If your Google private key contains escaped newlines, keep it in `.env` as `GOOGLE_PRIVATE_KEY="-----BEGIN...\n...\n-----END..."` — the app replaces `\\n` with newlines when constructing the JWT.
