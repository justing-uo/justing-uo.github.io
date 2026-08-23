# Walnut Engine

A browser port of your Python negamax chess engine — playable directly on
GitHub Pages, no server or Colab required. Same search ideas as the
original (negamax, alpha–beta, principal variation search, a transposition
table, quiescence search on captures, killer-move and history-heuristic
move ordering, piece-square tables), reimplemented in JavaScript on top of
[chess.js](https://github.com/jhlywa/chess.js) for move generation and
[chessboard.js](https://chessboardjs.com) for the board UI. The search runs
in a Web Worker so the page never freezes while it's thinking.

## Files

```
index.html          the page
css/styles.css       styling
js/engine-core.js    the engine itself (evaluation + search) — this is the
                      real port of your Python code
js/worker.js          loads engine-core.js in a background thread
js/main.js            board wiring: drag/drop, move list, eval bar, controls
```

## Run it locally

Open `index.html` with a local server (not `file://`, since Web Workers and
module-style script loading need `http(s)://`):

```bash
cd chess-web
python3 -m http.server 8000
# then visit http://localhost:8000
```

## Deploy to GitHub Pages

Since your GitHub Pages URL is `https://justing-uo.github.io/`, that means
you already have (or need to create) a repository literally named
**`justing-uo.github.io`** — GitHub treats that exact name as your user
site and serves it at the root domain.

1. Create that repo on GitHub if it doesn't exist yet (public, no need for
   a license or `.gitignore` — you can add those after).
2. Copy the contents of this `chess-web` folder into the repo root (so
   `index.html` sits at the top level, not inside a subfolder).
3. Commit and push:
   ```bash
   git init
   git add .
   git commit -m "Add Walnut Engine chess app"
   git branch -M main
   git remote add origin https://github.com/justing-uo/justing-uo.github.io.git
   git push -u origin main
   ```
4. In the repo's **Settings → Pages**, set the source to the `main` branch,
   root folder (`/`). GitHub Pages usually auto-detects this for a
   `<username>.github.io` repo.
5. Give it a minute, then visit `https://justing-uo.github.io/`.

If you'd rather keep it as a project page under a different repo name
(e.g. `chess-engine`), the same steps work — it'll just be served at
`https://justing-uo.github.io/chess-engine/` instead, and everything in
this project uses relative paths so no code changes are needed.

## Notes on the port

- **Evaluation**: material + your exact piece-square tables (mirrored the
  same way, via `square XOR 56`) + the doubled-pawn penalty. It's a full
  recompute each node rather than the incrementally-updated version in
  your Python script — simpler to keep correct, and fast enough at the
  depths below.
- **Search depth**: `chess.js`'s move generator is much slower than
  `python-chess`'s bitboards, so browser depth 5–6 in a few seconds (what
  your Colab script targets) isn't realistic. "Engine strength" instead
  maps to a depth **and** a time budget, and iterative deepening returns
  the best move found once time runs out:
  - Casual: depth 3, ~1.2s
  - Club: depth 5, ~3s
  - Tough: depth 7, ~6s (often won't finish depth 7, but will comfortably
    finish depth 5–6, which already plays a solid game)
- **Promotions** always auto-queen (no promotion-choice dialog) — the
  simplest thing that covers the vast majority of real games. Easy to add
  a picker later if you want under-promotion.
- **Draws**: stalemate, insufficient material, threefold repetition, and
  the 50-move rule are all detected via chess.js and scored as 0, same as
  your Python `evaluate()`.

## Extending it

- Swap `pieceTheme` in `js/main.js` for a different chessboard.js piece set
  (see [chessboardjs.com](https://chessboardjs.com) for the built-in
  themes).
- The strength presets are just numbers in `STRENGTH` in `js/main.js` —
  raise `timeLimitMs` for a stronger but slower engine.
- `js/engine-core.js` is plain, dependency-light JS (only `chess.js`), so
  it's also usable outside the browser — e.g. `node` for testing, as done
  during development.
