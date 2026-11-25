# AI Studio

A node-based canvas for planning and visualising AI generation workflows: image, video, 3D and audio pipelines across tools like Higgsfield, ChatGPT, Tripo or Meshy.

Lay out prompts, reference images, branching lists and outputs as connected nodes. Paste or drop results back in, keep versions, star the best ones on a board and export them. Everything runs on your machine. The app makes no external API calls, and your images and workflows stay in a local `data/` folder.

## Run it

You need [Node.js](https://nodejs.org) 18 or newer.

```bash
git clone https://github.com/Neferchipss/ai-studio.git
cd ai-studio
npm install
npm run dev
```

Then open **http://localhost:5180** (set `PORT` to change it).

## Nodes

| Node | What it's for |
|---|---|
| **Prompt** | Text plus reference sockets, for an image, video or 3D generation |
| **Reference** | Images that feed a prompt |
| **Output** | What you got back (image, video, 3D model, audio or text), with version history |
| **List** | Values that branch the flow, such as views, shots or props |
| **Batch prompt** | A template with `{variables}` and one result slot per branch |
| **Board** | Collect results, star favourites, export them |
| **Custom step** | Any manual or tool step, such as a Blender lineup or a remesh |
| **Note** | Sticky note |

A starter "3D pipeline" workflow loads on first run to show how the pieces fit together.

## Where your data goes

- `data/files/`: uploaded and pasted media, stored by content hash
- `data/workflows/`: saved workflows as JSON
- `data/exports/`: board exports with readable file names
- `data/live.json`: the canvas that's currently open

`data/` is git-ignored, so your work never ends up in the repo.

## Live canvas API (optional)

The server owns the open canvas, so every open tab, and any script or agent, sees changes as they happen:

- `GET /api/live`: the current document
- `POST /api/live/ops` with `{ "ops": [...] }`: apply edits (`add-node`, `update-node`, `remove-node`, `link`, `unlink`, `add-version`, `set`, `replace`)
- `POST /api/live/cmd` with `{ "cmd": "status" | "focus" | "arrange" | "fit" }`

The server listens on `127.0.0.1` only.
