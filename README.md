# ClipGenius Studio (Real App)

This is the standalone Studio web app (opens in a new tab from Shopify).

## Run Locally

1. Install Node.js 20+.
2. From this folder:

```bash
npm install
npm run dev
```

Then open `http://localhost:3000/studio`.

## Notes

- Uploads are stored in `public/uploads/` for the MVP. For production, switch to S3/R2 storage.
- The AI endpoint currently supports a basic rules fallback. To connect a real model, set:
  - `OPENAI_API_KEY` (and update `app/api/assistant/route.ts` accordingly).

