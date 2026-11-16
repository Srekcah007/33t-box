# 33T-Box

A lightweight, self-hosted Progressive Web App (PWA) to manage your **vinyl & CD collection**, shared wishlists, and family spaces — featuring a mobile barcode scanner, Discogs & MusicBrainz metadata lookup, audio previews, and private read-only invite links.

## Features

- **Vinyl & CD Catalog**: Track your collection and wishlist with format filters (`All`, `33T / Vinyl`, `CD`), condition grading, custom notes, purchase prices, and a visual **Cover Wall** mode.
- **Mobile Barcode Scanner & Metadata Lookup**: Scan EAN/UPC barcodes directly in the record shop using your phone camera, or search releases via **Discogs** and **MusicBrainz** with automatic cover art caching and Deezer 30-second audio previews.
- **Multi-User Isolation**: Each member gets an isolated SQLite database (`data/<slug>.db`). A Super-Admin manages members and cross-space visibility permissions.
- **Private Read-Only Invite Links**: Members and admins can generate volatile token-based share links (`?invite=...`) granting read-only access to a single space (including the EAN barcode scanner so friends or family can check duplicates in-store without an account).
- **Local-First & Zero Cloud Lock-in**: Built on Node.js, Express, and SQLite with one-click JSON/ZIP backups.

## Quick Start with Docker

1. **Clone the repository:**
   ```bash
   git clone [https://github.com/Srekcah007/33t-box.git](https://github.com/Srekcah007/33t-box.git)
   cd 33t-box
   ```

2. **Create a `.env` file** (optional, for Discogs API search):
   ```env
   PORT=3000
   DISCOGS_TOKEN=your_discogs_personal_access_token
   ```

3. **Start the container:**
   ```bash
   docker compose up -d
   ```

4. Open `http://localhost:3000` in your browser and create your first Super-Admin account.

## Manual Installation (Node.js)

Requirements: **Node.js 20+**

```bash
git clone [https://github.com/Srekcah007/33t-box.git](https://github.com/Srekcah007/33t-box.git)
cd 33t-box
npm install
npm start
```

The server listens on port `3000` by default (`PORT=3000`).

## Data Persistence & Backups

All user data is stored in two directories (mapped as Docker volumes):
- `./data/` — Master `users.db` and individual member databases (`<slug>.db`).
- `./covers/` — Cached album cover images.

Back up these two folders regularly to preserve your entire library.

## License

MIT