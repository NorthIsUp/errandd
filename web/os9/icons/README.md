# /os9/ icons

Drop PNGs in this directory. The build copies anything here into
`dist/web/os9/icons/`; the app references them via `/os9/icons/<name>.png`.

Files are **gitignored** so nothing copyrighted ends up in the repo.

## Filenames the UI looks for

### View menu

- `home.png`
- `chats.png`
- `routines.png`
- `settings.png`

### Routine browser rows

- `folder.png` — generic folder
- `folder-open.png` — expanded folder (optional)
- `file.png` — generic document
- `markdown.png` — `.md` files (optional; falls back to `file.png`)
- `log.png` — run log files (optional; falls back to `file.png`)

### Chat / session rows

- `chat-web.png` — web channel sessions
- `chat-bot.png` — discord / telegram sessions

## Recommended size

20×20 to 32×32 PNG with transparent background. The UI sizes them to 14×14
in menus and ~16×16 in folder rows.

## Where to find classic Mac OS icons

Search for "Mac OS 9 system icons" — there are several open-source recreations
and icon packs hosted by hobby preservation sites. Place whichever you prefer
in this directory; the filenames above are all the app expects.
