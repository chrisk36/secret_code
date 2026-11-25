# Secret Code

A real-time multiplayer browser puzzle game. Everyone sees the same 26 cards (A–Z, numbered 1–26, each with a random color and shape) and the same 5–6 rules. Exactly one set of 4 cards satisfies every rule. The first player to submit it wins the round.

- One shared room, no room codes, up to 8 players (more people can spectate).
- One guess per player per round. A wrong guess locks you out until the next round, and refreshing the page doesn't undo that.
- After a wrong guess, you (and only you) see your 4 cards outlined and each rule marked ✓ or ✗ for them, with the working. The correct cards stay hidden until the round ends. Then the results screen has a **Correct answer / Your guess** switch.
- No timer. Any player can choose **End round and reveal** (with a confirm step).
- Scores last for the session and are kept in memory only. **Reset game** (between rounds, with a confirm step) sets every score to 0, restarts at round 1, and sends everyone back to the lobby.

## Run it locally

Requires Node.js 20 or newer.

```bash
npm install
npm start            # http://localhost:3000
```

Open a few browser windows to play against yourself. Each private/incognito window, or each different browser, counts as a separate player. If you open a second tab in the **same** window, the game asks whether to continue there as the same player or join as a new player.

```bash
npm test             # unit tests (puzzle engine) + multiplayer server tests
```

## Deploy to Render (free tier)

### 1. Put the project on GitHub

Create an empty repository on GitHub (for example `secret-code`), then from **inside this folder**:

```bash
git init
git add .
git commit -m "Secret Code"
git branch -M main
git remote add origin https://github.com/<your-username>/secret-code.git
git push -u origin main
```

> Run `git init` inside the `secret_code` folder so the project gets its own repository. If a parent folder (for example your home directory) is already a git repository, committing from there would push the wrong files.

### 2. Create the web service

**Option A: Blueprint (uses `render.yaml`)**

1. Sign in at [dashboard.render.com](https://dashboard.render.com) and connect your GitHub account.
2. Click **New → Blueprint** and pick your `secret-code` repository.
3. Render reads `render.yaml` and creates a free Node web service. Click **Apply**.

**Option B: by hand**

1. Click **New → Web Service** and pick your repository.
2. Use these settings:
   - **Language / Runtime:** Node
   - **Build command:** `npm ci --omit=dev`
   - **Start command:** `npm start`
   - **Instance type:** Free
   - **Health check path** (under Advanced): `/healthz`
3. Click **Create Web Service**.

The first deploy takes a few minutes. The server listens on the `PORT` that Render provides.

### 3. Share the link

When the deploy shows **Live**, your URL appears at the top of the service page, for example `https://secret-code-xxxx.onrender.com`. Send that link to your friends. Everyone who opens it is in the same room.

Every push to `main` redeploys automatically.

### Free-tier limits

- **Sleeps when idle.** A free instance spins down after 15 minutes without traffic. The next visitor wakes it, which can take up to a minute. The page shows "Waking up the server…" while it waits.
- **Scores are not saved.** All state lives in memory, so scores, players, and the current round are lost whenever the instance restarts: after it sleeps, on every deploy, or when Render restarts it.
- Free instances have a monthly usage allowance. That's plenty for casual games with friends.

## How it works

```
server.js          Express (static files + /healthz) and Socket.IO. Holds no game logic.
src/room.js        Room state: players, rounds, scores, validation. Authoritative.
src/puzzle.js      Pure puzzle engine: board, rule templates, evaluator, generator.
public/            Plain HTML/CSS/JS client (no build step).
test/              node:test suites.
```

**Server authority.** The server generates every puzzle and checks every submission. It validates that the sender is a seated, active player who hasn't guessed yet and that the guess is exactly 4 distinct letters A–Z. Clients receive only the board and the rule text. The solution leaves the server only after the round ends.

**Identity.** On join, the server issues a secret player token, which the browser stores in `localStorage` (and in `sessionStorage` for the current tab). After a refresh or reconnect, the client presents the token and gets back the same player: name, score, and round status, including a lockout. Other clients only ever see a separate public ID.

**Disconnects.** The player list shows each player's connection status. When the server checks whether everyone has answered, it ignores players who have been disconnected for more than 10 seconds. A quick refresh doesn't end a round. Players who stay disconnected for 3 minutes are removed between rounds.

### Puzzle generation

1. Randomize colors and shapes on all 26 cards. Every color and shape appears at least twice.
2. Pick a hidden 4-card solution.
3. Build every rule from the template library that the solution satisfies. The library covers sums, numbers of different colors or shapes, sums and differences of two cards, range, most or least common color or shape, color and shape counts, even/odd/prime/multiples of 3, adjacent letters, letter positions, and "the Nth card is …". Rules that rely on "most/least common" are skipped when the board has a tie.
4. Drop any rule that alone matches fewer than 150 of the 14,950 combinations (it would nearly give the answer away) or more than about 85% of them (it would say almost nothing).
5. Search for 5–6 rules from **different families** whose combination leaves exactly one of the 14,950 combinations. Each rule must be **necessary**: removing any one of them leaves more than one solution.
6. Confirm the result by brute force over all 14,950 combinations. If any check fails, start over.

A puzzle takes about 5–10 ms to generate. `test/puzzle.test.js` generates 500 puzzles and checks every property above for each.
