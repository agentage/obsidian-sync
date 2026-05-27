#!/usr/bin/env bash
# Install the latest Obsidian .deb + the Xvfb / window-manager / Mesa stack
# Obsidian's renderer needs under headless CI.
set -euo pipefail

sudo apt-get update -qq
sudo apt-get install -y --no-install-recommends \
  xvfb herbstluftwm x11-xserver-utils xfonts-base xfonts-100dpi jq \
  libgl1-mesa-dri libglx-mesa0 libegl-mesa0

OBSIDIAN_VERSION=$(
  curl -fsSL https://api.github.com/repos/obsidianmd/obsidian-releases/releases/latest \
    | jq -r .tag_name | sed 's/^v//'
)
echo "Obsidian version: $OBSIDIAN_VERSION"

curl -fsSL -o /tmp/obsidian.deb \
  "https://github.com/obsidianmd/obsidian-releases/releases/download/v${OBSIDIAN_VERSION}/obsidian_${OBSIDIAN_VERSION}_amd64.deb"
sudo apt-get install -y --no-install-recommends /tmp/obsidian.deb
ls -la /opt/Obsidian/
