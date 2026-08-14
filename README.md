# 🎫 Jira

Your Jira queue in workspacer — and one click from a ticket to an agent working it.

A [workspacer](https://github.com/DJTouchette/workspacer) plugin. Runs a JQL search against Jira Cloud, renders the result as a board of ticket cards, and puts a **Start agent** button on each one: it spawns an agent in the project the pane is open in and hands it a brief built from the ticket.

## What it does

- **Your tickets.** Whatever your JQL returns — by default your open assigned work, freshest first. Key, summary, status, type and priority per card; the key links back to Jira.
- **Ticket → agent.** *Start agent* spawns your chosen harness (Claude, Codex, OpenCode or Pi) in the pane's project and sends it a brief containing the ticket's key, title, type, status, priority, link, and its description flattened out of Atlassian Document Format into readable text.
- **Notifications** when a ticket *enters* your search that wasn't there before — a new assignment, or one moved into your filter. Never on the backlog that already existed when it started watching, so restarting the app doesn't produce a wall of toasts. One slot per issue: a re-notified ticket replaces its entry instead of stacking.
- **A widget** (*My tickets*) for the project's widget board: the open count and the first few keys. It reads the same `/state` the pane does, so however many tiles you pin there is still one sidecar and one upstream poll.

## The brief

The brief deliberately does **not** say "implement this". It states the ticket and then asks the agent to read the repo and tell you how it understands the work *before* writing code, and to say so if the ticket is underspecified. A ticket summary is not a spec, and an agent handed one as though it were will confidently build the wrong thing.

That's only the **default**. Hit the pencil in the pane header to edit it — a house style, a definition of done, "always run the linter", or a different shape entirely. The editor has:

- **Token chips** you click to insert: `{{key}}` `{{summary}}` `{{description}}` `{{type}}` `{{status}}` `{{priority}}` `{{assignee}}` `{{url}}`. Case-insensitive, and `{{ key }}` with spaces works too.
- **A live preview**, rendered *by the sidecar* against a real ticket from your queue — so what you're reading is exactly the text the agent will be sent, not a second substitution implementation that can drift from the real one.
- **Reset to default**, which also happens if you save something identical to the default. That means an edit-then-undo isn't pinned to today's wording forever, and you still pick up an improved default from a plugin update.

An unknown token like `{{summry}}` is left standing rather than blanked, so a typo shows up in the preview instead of silently deleting the line you cared about.

Your edit is stored per install (`.brief-template` beside the plugin, the one place a sandboxed sidecar may write) and is not committed — it's yours, not the package's.

## Setup

Settings → Plugins → Jira:

| Setting | What it is |
|---|---|
| **Jira base URL** | `https://your-org.atlassian.net` — no trailing slash. |
| **Atlassian account email** | The account the API token belongs to. |
| **Jira API token** | Create at [id.atlassian.com → Security → API tokens](https://id.atlassian.com/manage-profile/security/api-tokens). Stored as a secret: workspacer redacts it to `__WKS_SECRET__` on every read and only the sidecar sees the real value. |
| **JQL** | Which issues to show. Defaults to `assignee = currentUser() AND statusCategory != Done ORDER BY updated DESC`. |
| **Agent to spawn** | Which harness *Start agent* launches. |
| **Poll interval** | Seconds between searches (floored at 20 — Jira Cloud rate-limits). |
| **Notify on newly assigned tickets** | On by default. |

Until all three of base URL, email and token are set the pane says so rather than failing silently.

## Design

The pane is a **list, not a gallery**: rows separate with a single hairline on the base background rather than each drawing a border *and* a fill — twenty bordered rectangles is the density problem workspacer's own `Surface` rule exists to prevent. It inherits your theme for free (the host injects the full `--wks-*` token set into plugin webviews and re-injects on every theme change), so it follows the app through all 18 themes rather than hardcoding a palette.

A few deliberate choices:

- **Grouped by what you're in the middle of** — In progress, then To do, then Done. Order *within* a group is left alone; that belongs to your JQL's `ORDER BY`.
- **The meta line only says what the heading didn't.** A "To Do" pill under a TO DO heading is noise, so it's suppressed; "In Review" under IN PROGRESS survives, because that's the informative half. Priority is the coloured dot (with a tooltip for the exact value) and is spelled out only for High/Highest, where it changes what you'd pick up next.
- **Done tickets recede** rather than competing with live work, and the header count is open tickets only.
- **Start agent reserves its space but only fades in on hover**, so revealing it can never reflow the list under your pointer. In a narrow split pane it drops its label and keeps its glyph — a hidden button's width is otherwise paid for by the summary you're actually reading.
- **Every state is designed**, not an afterthought: first-run setup with the three fields numbered, a skeleton on first paint (never again — a poll can't blank a list you're reading), an empty queue, a 401 translated into "Jira rejected the credentials", and a transient 500 that keeps the last good list on screen. A failed fetch never claims your queue is empty, because it didn't read it.

## Notes

- **Jira Cloud only.** Auth is Basic `email:apiToken`, which is Cloud's REST scheme. Jira Server/Data Center uses bearer PATs — the `jiraGet` helper is the one place to change.
- **The search endpoint moved.** Jira Cloud replaced `GET /rest/api/3/search` with `/rest/api/3/search/jql`. The sidecar tries the current one and falls back once on 404/410, so you don't have to care which your instance is.
- **Start agent needs a project.** The button is disabled in a pane with no `cwd`. A spawn without one lands in `$HOME`, which is never where the ticket's code is, so it's refused rather than defaulted.
- **The brief is built server-side** from the issue the sidecar fetched, not from the request body — a pane can't hand an arbitrary description to a spawned agent.
- Zero dependencies, Node ≥ 22. `node test.js` covers the pure helpers (ADF flattening, normalization, the brief, config resolution, and the new-ticket baseline); `node test-ui.js` renders the pane and the widget against seven fixture states in a DOM shim, failing on anything that throws, renders empty, or leaks a placeholder.

## License

MIT
