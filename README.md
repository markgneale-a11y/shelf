# Shelf

Browse your saved Spotify albums like a shelf of CDs: artists A–Z, each artist's albums in release order, and a Favourites row you pick yourself. Click a cover to play it; click it again to pause.

Playback runs in the browser using Spotify's Web Playback SDK, so it needs Spotify Premium.

## Run it locally

Double-click `Start Shelf.command`, or run:

```bash
python3 -m http.server 8765 --bind 127.0.0.1
```

then open http://127.0.0.1:8765.

## Spotify setup

The app uses Spotify's PKCE login, so there is no secret in the code. The Client ID lives at the top of `app.js`. In the Spotify developer dashboard, the app's Redirect URIs must include:

- `http://127.0.0.1:8765/callback` (local)
- `https://markgneale-a11y.github.io/shelf/callback` (GitHub Pages)

`mockup.html` is the original design mock-up with sample albums.
