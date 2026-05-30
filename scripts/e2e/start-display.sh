#!/usr/bin/env bash
# Boot Xvfb + herbstluftwm on :99. Exports DISPLAY=:99 into $GITHUB_ENV when
# run inside a GitHub Actions step. Without a real window manager Obsidian's
# renderer never paints under bare Xvfb.
set -euo pipefail

Xvfb :99 -screen 0 1280x1024x24 +extension GLX +extension RANDR -noreset &
sleep 1

# Suppress herbstluftwm's panel.sh autostart — it tries to size from xrandr
# which returns nothing under Xvfb, and the panel crashes with BadDrawable.
mkdir -p "$HOME/.config/herbstluftwm"
printf '#!/usr/bin/env bash\nexit 0\n' > "$HOME/.config/herbstluftwm/autostart"
chmod +x "$HOME/.config/herbstluftwm/autostart"

DISPLAY=:99 herbstluftwm &
sleep 1

if [[ -n "${GITHUB_ENV:-}" ]]; then
  echo "DISPLAY=:99" >> "$GITHUB_ENV"
fi
DISPLAY=:99 xdpyinfo | head -5 || true
