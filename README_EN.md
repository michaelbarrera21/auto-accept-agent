# Auto Accept for Antigravity

**English** | [中文](README.md)

## Run 3 AI agents in parallel. Zero babysitting.

Stop watching tabs. Auto Accept keeps every Antigravity conversation moving — accepting file edits, terminal commands, and recovery prompts automatically.

---

![background mode](https://raw.githubusercontent.com/MunKhin/auto-accept-agent/master/media/background-mode.png)

---

## Why Auto Accept?

Antigravity's multi-agent workflow is powerful, but it stops every time the agent needs approval. 

**That's dozens of interruptions per hour.**

Auto Accept eliminates the wait:
- ✅ **File edits** — Auto-applied
- ✅ **Terminal commands** — Auto-executed
- ✅ **Retry prompts** — Auto-confirmed
- ✅ **Stuck agents** — Auto-recovered

---

## Features

### Background Mode (Pro)
Run multiple Antigravity tabs simultaneously. Every conversation auto-accepts in the background — no tab-switching required.

### Dangerous Command Blocking
Built-in protection against destructive commands like `rm -rf /`. Pro users can customize the blocklist.

### Real-time Status Overlay
Visual indicators show conversation state:
- **Purple** — In progress, actively polling
- **Green** — Task completed

### Works Everywhere
- ✅ Antigravity
- ✅ Cursor
- ✅ Multiple windows
- ✅ Minimized/unfocused
- ✅ Multi-instance (Smart Port Detection)

### Internationalization
- 🇺🇸 **English** (Default)
- 🇨🇳 **Simplified Chinese** (简体中文)

Auto-detects IDE language. Force specific language via `Auto Accept: Language Override` setting.

---

## Quick Start

1. **Install** the extension
2. **Click** `Auto Accept: OFF` in the status bar
3. **Allow** the one-time shortcut update if prompted
4. **Done** — Auto Accept activates automatically

The extension runs silently. Check the status bar for `Auto Accept: ON`.

---

## Pro Features

| Feature | Free | Pro |
|---------|------|-----|
| Auto-accept in active tab | ✅ | ✅ |
| Background mode (all tabs) | — | ✅ |
| Custom banned commands | — | ✅ |
| Adjustable polling speed | — | ✅ |
| Stuck agent recovery | — | ✅ |
| Stuck agent recovery | — | ✅ |
| Multi-window support | — | ✅ |
| Smart Port Detection | ✅ | ✅ |


---

## Troubleshooting

### "Could not configure automatically" Error

**Symptom**: When clicking `Auto Accept: OFF`, you see:
```
Auto Accept: Could not configure automatically. Please add --remote-debugging-port=9000 to your Antigravity shortcut manually, then restart.
```

**Causes**:
1. The shortcut is not in a standard location (Desktop, Start Menu, Taskbar)
2. No write permission to the shortcut file
3. IDE was installed via non-standard method (portable, custom path)
4. Custom-named shortcuts that don't match the IDE executable

**Manual Fix**:

#### Windows
1. Find your IDE shortcut (Desktop or Start Menu)
2. Right-click → **Properties**
3. In the **Target** field, add `--remote-debugging-port=9000` after the `.exe` path:
   ```
   "C:\...\Antigravity.exe" --remote-debugging-port=9000
   ```
4. Click **OK** and restart the IDE

#### macOS
Launch your IDE from the terminal with the debug flag:
```bash
# For Antigravity
open -a "Antigravity.app" --args --remote-debugging-port=9000

# For Cursor
open -a "Cursor.app" --args --remote-debugging-port=9000
```
*Tip: You can create an alias in your `.zshrc`: `alias antigravity='open -a "Antigravity" --args --remote-debugging-port=9000'`*

#### Linux
Edit your URL/Desktop entry (usually in `/usr/share/applications` or `~/.local/share/applications`):
1. Open the `.desktop` file (e.g., `antigravity.desktop`)
2. Find the `Exec=` line
3. Append `--remote-debugging-port=9000` to the end
4. Save and relaunch

---

## Requirements

- Antigravity or Cursor IDE
- One-time relaunch after install

---

## License

MIT
