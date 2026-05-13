#!/usr/bin/env bash
# energeia-daemon installer
#
# Double-click this file in Finder (or run from Terminal) to install the
# energeia local daemon on this Mac. Installs to:
#   ~/Library/Application Support/energeia/energeia-daemon.py
#   ~/Library/LaunchAgents/com.cam.energeia-daemon.plist
#
# After install, the script prints a registration token.
# Paste it into energeia.skeptou.com → Settings → Connect daemon.

set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
ENERGEIA_SUPPORT="$HOME/Library/Application Support/energeia"
PLIST="$HOME/Library/LaunchAgents/com.cam.energeia-daemon.plist"
TOKEN_FILE="$HOME/.energeia-daemon-token"
LOG="$HOME/Library/Logs/energeia-daemon.log"
AGORA_PATH="$HOME/Documents/agora"
WORKTREES="$HOME/Documents/agora-worktrees/dunamis"
SCRIVENER_DIR="$HOME/Documents/agora-scriv"
ENERGEIA_API="https://energeia.skeptou.com"

# ── Utilities ──────────────────────────────────────────────────────────────
step() { echo; echo "── $1"; }
ok()   { echo "   ✓ $1"; }
fail() { echo "   ✗ $1" >&2; exit 1; }
notify() {
  osascript -e "display notification \"$2\" with title \"$1\"" 2>/dev/null || true
}

# ── Checks ─────────────────────────────────────────────────────────────────
step "Checking requirements"

command -v python3 >/dev/null 2>&1 || fail "Python 3 not found. Install from python.org or via Homebrew."
command -v git     >/dev/null 2>&1 || fail "git not found. Install Xcode Command Line Tools: xcode-select --install"
ok "python3 + git found"

PYTHON_VER=$(python3 -c 'import sys; print(sys.version_info[:2])' | tr -d "() ")
ok "Python $PYTHON_VER"

# ── Python dependencies ────────────────────────────────────────────────────
step "Installing Python dependencies"
python3 -m pip install --user --quiet watchdog requests && ok "watchdog + requests installed"

# ── Daemon script ──────────────────────────────────────────────────────────
step "Installing daemon script"
mkdir -p "$ENERGEIA_SUPPORT"
cp "$SCRIPT_DIR/energeia-daemon.py" "$ENERGEIA_SUPPORT/energeia-daemon.py"
chmod +x "$ENERGEIA_SUPPORT/energeia-daemon.py"
ok "Daemon installed to $ENERGEIA_SUPPORT"

# ── Auth token ─────────────────────────────────────────────────────────────
step "Generating daemon auth token"
if [ -f "$TOKEN_FILE" ]; then
  TOKEN=$(cat "$TOKEN_FILE")
  ok "Reusing existing token"
else
  TOKEN=$(python3 -c "import uuid; print(uuid.uuid4())")
  echo "$TOKEN" > "$TOKEN_FILE"
  chmod 600 "$TOKEN_FILE"
  ok "New token generated: $TOKEN"
fi

# ── Directories ────────────────────────────────────────────────────────────
step "Creating working directories"
mkdir -p "$WORKTREES" && ok "Worktrees: $WORKTREES"
mkdir -p "$SCRIVENER_DIR" && ok "Scrivener: $SCRIVENER_DIR"
mkdir -p "$(dirname "$LOG")" && ok "Logs: $(dirname "$LOG")"

# ── Agora clone ────────────────────────────────────────────────────────────
step "Setting up agora repository"
if [ -d "$AGORA_PATH/.git" ]; then
  ok "agora repo already cloned at $AGORA_PATH"
else
  echo "   Enter the agora repo SSH URL (e.g. git@github.com:cameronhubbard642-eng/agora.git):"
  read -r AGORA_REMOTE
  if [ -n "$AGORA_REMOTE" ]; then
    git clone "$AGORA_REMOTE" "$AGORA_PATH" && ok "Cloned agora to $AGORA_PATH"
    # Ensure energeia branch is tracked
    cd "$AGORA_PATH"
    git fetch origin energeia 2>/dev/null && \
      git checkout -b energeia origin/energeia 2>/dev/null || \
      git checkout energeia 2>/dev/null || true
    cd - >/dev/null
  else
    echo "   Skipping agora clone — run manually: git clone <url> $AGORA_PATH"
  fi
fi

# ── TEXINPUTS ──────────────────────────────────────────────────────────────
step "Configuring TEXINPUTS for local LaTeX"
# The recursive (//::) search lets xelatex find Cameron_Personal_Style.sty
# inside agora/templates/personal_style/ without specifying the full path.
#
# NOTE — local compilation from a paper directory also requires a symlink
# because Cameron_Personal_Style.sty uses relative paths for fonts and
# logos (./personal_style/fonts/). Before compiling a paper locally, run:
#
#   ln -sfn ~/Documents/agora/templates/personal_style \
#           ~/Documents/agora-worktrees/dunamis/<branch>/papers/<slug>/personal_style
#
# CI workflows (compile-draft, compile-canonical, promote-paper) create this
# symlink automatically before each latexmk invocation.
TEXINPUTS_LINE="export TEXINPUTS=\".:${AGORA_PATH}/templates//::\""
for RC in "$HOME/.zshrc" "$HOME/.bash_profile"; do
  if [ -f "$RC" ] && ! grep -q "agora/templates" "$RC" 2>/dev/null; then
    echo "" >> "$RC"
    echo "# energeia: find Cameron_Personal_Style templates" >> "$RC"
    echo "$TEXINPUTS_LINE" >> "$RC"
    ok "Added TEXINPUTS to $RC"
  fi
done

# ── launchd plist ─────────────────────────────────────────────────────────
step "Installing launchd job"

PYTHON_BIN=$(which python3)
MAC_ID=$(hostname)

cat > "$PLIST" <<PLIST_EOF
<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN"
  "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
  <key>Label</key>
  <string>com.cam.energeia-daemon</string>
  <key>ProgramArguments</key>
  <array>
    <string>${PYTHON_BIN}</string>
    <string>${ENERGEIA_SUPPORT}/energeia-daemon.py</string>
  </array>
  <key>EnvironmentVariables</key>
  <dict>
    <key>ENERGEIA_TOKEN</key>
    <string>${TOKEN}</string>
    <key>ENERGEIA_API_URL</key>
    <string>${ENERGEIA_API}</string>
    <key>AGORA_PATH</key>
    <string>${AGORA_PATH}</string>
    <key>WORKTREES_PATH</key>
    <string>${WORKTREES}</string>
    <key>SCRIVENER_PATH</key>
    <string>${SCRIVENER_DIR}</string>
  </dict>
  <key>RunAtLoad</key>
  <true/>
  <key>KeepAlive</key>
  <true/>
  <key>ThrottleInterval</key>
  <integer>10</integer>
  <key>StandardOutPath</key>
  <string>${LOG}</string>
  <key>StandardErrorPath</key>
  <string>${LOG}</string>
</dict>
</plist>
PLIST_EOF

ok "Plist written to $PLIST"

# ── Load launchd job ───────────────────────────────────────────────────────
step "Loading daemon"
launchctl unload "$PLIST" 2>/dev/null || true
launchctl load -w "$PLIST" && ok "Daemon loaded"

sleep 2
if launchctl list | grep -q "com.cam.energeia-daemon"; then
  ok "Daemon is running"
else
  echo "   Daemon may not be running — check $LOG for errors"
fi

# ── Registration instructions ──────────────────────────────────────────────
echo
echo "══════════════════════════════════════════════════════════════════"
echo "  Installation complete!"
echo
echo "  NEXT STEP — Register this Mac with the energeia site:"
echo
echo "  1. Open https://energeia.skeptou.com in your browser"
echo "  2. Navigate to Settings → Connect daemon"
echo "  3. Paste this token:"
echo
echo "     $TOKEN"
echo
echo "  (Token also saved to: $TOKEN_FILE)"
echo "══════════════════════════════════════════════════════════════════"
echo

notify "Energeia daemon installed" "Paste the token into energeia.skeptou.com → Settings → Connect daemon"
