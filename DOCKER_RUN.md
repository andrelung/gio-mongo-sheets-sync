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
