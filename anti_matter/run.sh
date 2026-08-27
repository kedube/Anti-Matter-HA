#!/usr/bin/with-contenv bashio
# ============================================================
#  Anti-Matter add-on launcher
# ============================================================
log_line() {   # $1=LEVEL  $2=ANSI colour  $3=message
    printf '[%s] %s: %b%s\033[0m\n' "$(date '+%Y-%m-%d %H:%M:%S')" "$1" "$2" "$3"
}

log_line INFO '\033[32m' "Anti-Matter starting on port 8099 (ingress)..."

export ANTIMATTER_DATA="/data"
export ANTIMATTER_OPTIONS="/data/options.json"
export ANTIMATTER_PORT="8099"
export ADDON_VERSION="2.0.5"

# media:rw mounts HA's Media folder at /media. Downloaded label/QR images are
# also saved there (in anti_matter/ subfolder) if present.
if [ -d "/media" ]; then
    log_line INFO '\033[32m' "Media folder active: /media/anti_matter (downloaded images also saved there)"
    export ANTIMATTER_MEDIA="/media"
else
    log_line WARNING '\033[33m' "/media not mounted — downloaded images will only save to the browser"
fi

# app_config:rw mounts the add-on config folder at /config.
# On the SAMBA share this shows up as app_configs\<slug>. Store the vault there
# so backups are reachable over the network and included in HA backups.
if [ -d "/config" ]; then
    log_line INFO '\033[32m' "SAMBA storage active: /config (\\\\<HA-IP>\\app_configs\\<slug>)"
    export STORAGE_DIR="/config"
else
    log_line WARNING '\033[33m' "/config not mounted — falling back to /data"
    export STORAGE_DIR="$ANTIMATTER_DATA"
fi

exec python3 /app/main.py
