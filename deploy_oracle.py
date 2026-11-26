#!/usr/bin/env python3
"""
Deploy WebRTC Signaling Server to Oracle Cloud Infrastructure (OCI) Always Free Tier.
- Free Tier Specs:
    * Ampere A1 (ARM): up to 4 OCPUs, 24 GB RAM, or
    * AMD Micro (x86_64): VM.Standard.E2.1.Micro (1 OCPU, 1 GB RAM).
    * 200 GB Total Block Volume Storage (Free Forever).
    * 10 TB / Month Outbound Data Transfer (Egress).
- Features:
    * Fully Automated OCI Cloud Provisioner: creates VCN, Subnet, Firewall & VM directly from terminal.
    * Auto-Detects Home Region: solves Oracle IAM region mismatch errors automatically.
    * Reuses Existing VCN & Subnet: uses existing network or creates clean new one.
    * Automated SSH Deployment: configures any existing Oracle VM with 1 click.
    * Unlocks Oracle Host Firewall (iptables / firewalld / ufw) for ports 80, 443, 8443.
    * Configures Caddy reverse proxy with automated Let's Encrypt SSL via <IP>.sslip.io.
    * Instant Hot-Updates: re-run anytime to update server code in ~2 seconds.

Usage (run from PowerShell with `python`; see `python deploy_oracle.py --help`):
    python deploy_oracle.py                # interactive; shows OCI VM status first
    python deploy_oracle.py --skip-check   # interactive, without the slow status check
    python deploy_oracle.py --quick        # hot-reload the cached VM now, no prompts
    python deploy_oracle.py --ip <ADDR>    # hot-reload the VM at <ADDR> now
The status check is informational; only the fully automated deploy can create a
VM, and it always checks OCI for an existing 3RTC VM first.
"""

import sys
import os
import argparse
import shutil
import subprocess
import json
import base64
import time
import glob
import re
import urllib.request
import getpass
import tempfile
import hashlib
import secrets
from pathlib import Path

# Force line buffering for interactive terminals
if hasattr(sys.stdout, 'reconfigure'):
    sys.stdout.reconfigure(line_buffering=True)
if hasattr(sys.stderr, 'reconfigure'):
    sys.stderr.reconfigure(line_buffering=True)

SIGNAL_DOMAIN = "orc.3rtc.me"
DEFAULT_PORT = "443"
ALT_PORT = "8443"
SERVICE_USER = "webrtc"
SERVICE_FILE = "webrtc-signaling.service"
SERVER_FILES = ["server.js", "signaling.js", "seats.js", "rateLimit.js", "quickPicks.js", "linkPreview.js", "log.js", "package.json"]
CACHE_FILE_NAME = ".oracle_deploy_cache.json"
DEFAULT_CHECK_TIMEOUT = 30  # seconds the startup VM status check may take

PROBE_REGIONS = [
    "ap-hyderabad-1", "ap-mumbai-1", "us-ashburn-1", "us-phoenix-1",
    "eu-frankfurt-1", "uk-london-1", "ap-singapore-1", "ap-tokyo-1",
    "ap-sydney-1", "ca-toronto-1"
]


def print_step(title):
    print(f"\n{'=' * 65}")
    print(f" {title}")
    print(f"{'=' * 65}", flush=True)


def find_executable(name, extra_paths=None):
    found = shutil.which(name) or (sys.platform == "win32" and shutil.which(f"{name}.exe"))
    if found:
        return found
    if extra_paths and sys.platform == "win32":
        for p in extra_paths:
            expanded = os.path.expandvars(p)
            if os.path.isfile(expanded):
                return expanded
    return None


def find_ssh():
    win_paths = [
        r"%SystemRoot%\System32\OpenSSH\ssh.exe",
        r"%ProgramFiles%\Git\usr\bin\ssh.exe"
    ]
    return find_executable("ssh", win_paths)


def find_scp():
    win_paths = [
        r"%SystemRoot%\System32\OpenSSH\scp.exe",
        r"%ProgramFiles%\Git\usr\bin\scp.exe"
    ]
    return find_executable("scp", win_paths)


def find_ssh_keygen():
    win_paths = [
        r"%SystemRoot%\System32\OpenSSH\ssh-keygen.exe",
        r"%ProgramFiles%\Git\usr\bin\ssh-keygen.exe"
    ]
    return find_executable("ssh-keygen", win_paths)


def find_oci():
    """Find OCI CLI executable, including Windows Store Python package directories."""
    found = shutil.which("oci") or (sys.platform == "win32" and shutil.which("oci.exe"))
    if found:
        return found

    if sys.platform == "win32":
        local_app = os.environ.get("LOCALAPPDATA", "")
        if local_app:
            patterns = [
                os.path.join(local_app, "Packages", "PythonSoftwareFoundation.Python*", "LocalCache", "local-packages", "Python*", "Scripts", "oci.exe"),
                os.path.join(local_app, "Programs", "Python", "Python*", "Scripts", "oci.exe"),
                os.path.expandvars(r"%USERPROFILE%\lib\oracle-cli\bin\oci.exe")
            ]
            for pat in patterns:
                matches = glob.glob(pat)
                if matches and os.path.isfile(matches[0]):
                    return matches[0]
    return None


def run_cmd(cmd_list, capture_output=True, check=True, text=True):
    try:
        res = subprocess.run(
            cmd_list,
            capture_output=capture_output,
            check=check,
            text=text,
            shell=(sys.platform == "win32" and isinstance(cmd_list, str))
        )
        return res
    except subprocess.CalledProcessError as e:
        if capture_output and e.stderr:
            print(f"[Error Output]: {e.stderr.strip()}", flush=True)
        raise e


def get_oci_auth_flags():
    config_path = Path.home() / ".oci" / "config"
    if config_path.exists():
        try:
            content = config_path.read_text(encoding="utf-8")
            if "security_token_file" in content:
                return ["--auth", "security_token"]
        except Exception:
            pass
    return []


def read_oci_config_section(section="DEFAULT"):
    config_path = Path.home() / ".oci" / "config"
    data = {}
    if not config_path.exists():
        return data
    current_sec = None
    try:
        for line in config_path.read_text(encoding="utf-8").splitlines():
            line = line.strip()
            if line.startswith("[") and line.endswith("]"):
                current_sec = line[1:-1]
                continue
            if current_sec == section and "=" in line:
                k, v = line.split("=", 1)
                data[k.strip()] = v.strip()
    except Exception:
        pass
    return data


def update_oci_config_region(new_region):
    config_file = Path.home() / ".oci" / "config"
    if config_file.exists():
        try:
            text = config_file.read_text(encoding="utf-8")
            new_text = re.sub(r"region\s*=\s*[^\r\n]+", f"region={new_region}", text)
            config_file.write_text(new_text, encoding="utf-8")
        except Exception:
            pass


def load_cache(script_dir):
    cache_path = script_dir / CACHE_FILE_NAME
    if cache_path.exists():
        try:
            with open(cache_path, "r", encoding="utf-8") as f:
                return json.load(f)
        except Exception:
            return None
    return None


def save_cache(script_dir, data):
    """Merge `data` into the local deploy cache (host, user, key_path, region, vm_id)."""
    cache_path = script_dir / CACHE_FILE_NAME
    merged = load_cache(script_dir) or {}
    merged.update({k: v for k, v in data.items() if v})
    try:
        with open(cache_path, "w", encoding="utf-8") as f:
            json.dump(merged, f, indent=2)
    except Exception:
        pass


def check_prerequisites():
    print_step("Step 1: Checking Prerequisites")

    if sys.version_info < (3, 8):
        print(f"[ERROR] Python 3.8+ required. Found: {sys.version}")
        sys.exit(1)
    print(f"[OK] Python {sys.version.split()[0]} detected.")

    script_dir = Path(__file__).resolve().parent
    server_files = [script_dir / name for name in SERVER_FILES]
    missing = [f.name for f in [*server_files, script_dir / SERVICE_FILE] if not f.exists()]
    if missing:
        print(f"[ERROR] Missing server files in {script_dir}: {', '.join(missing)}")
        sys.exit(1)
    print(f"[OK] Local server files verified: {', '.join(SERVER_FILES)}")

    ssh_bin = find_ssh()
    scp_bin = find_scp()
    if not ssh_bin or not scp_bin:
        print("[ERROR] OpenSSH client ('ssh' and 'scp') was not found in PATH.")
        sys.exit(1)
    print(f"[OK] SSH tools detected.")

    oci_bin = find_oci()
    if not oci_bin:
        print("\n[Notice] Oracle Cloud CLI ('oci') not found. Installing via pip...")
        subprocess.run([sys.executable, "-m", "pip", "install", "oci-cli"])
        oci_bin = find_oci()

    if oci_bin:
        print(f"[OK] Oracle Cloud CLI (oci) ready: {oci_bin}")
    else:
        print("[INFO] Oracle Cloud CLI not installed. Direct SSH mode available.")

    return script_dir, server_files, ssh_bin, scp_bin, oci_bin


def build_remote_bootstrap_script():
    script = f"""#!/bin/bash
set -e

exec > >(tee -a /var/log/oracle-3rtc-setup.log) 2>&1
echo "[3RTC] Starting WebRTC Signaling Server bootstrap on Oracle Cloud..."

# 1. Unlock Oracle Cloud Host Firewall (iptables / firewalld / ufw)
echo "[Firewall] Configuring host firewall for ports 80, 443, 8443..."
if command -v iptables >/dev/null 2>&1; then
    sudo iptables -I INPUT 1 -p tcp --dport 80 -j ACCEPT 2>/dev/null || true
    sudo iptables -I INPUT 1 -p tcp --dport 443 -j ACCEPT 2>/dev/null || true
    sudo iptables -I INPUT 1 -p tcp --dport 8443 -j ACCEPT 2>/dev/null || true
    if command -v netfilter-persistent >/dev/null 2>&1; then
        sudo netfilter-persistent save || true
    fi
fi

if command -v ufw >/dev/null 2>&1; then
    sudo ufw allow 80/tcp || true
    sudo ufw allow 443/tcp || true
    sudo ufw allow 8443/tcp || true
fi

if command -v firewall-cmd >/dev/null 2>&1; then
    sudo firewall-cmd --zone=public --permanent --add-port=80/tcp || true
    sudo firewall-cmd --zone=public --permanent --add-port=443/tcp || true
    sudo firewall-cmd --zone=public --permanent --add-port=8443/tcp || true
    sudo firewall-cmd --reload || true
fi

# 2. Setup 2GB Swap (prevents OOM on smaller/shared instances)
if [ ! -f /swapfile ]; then
    echo "[Swap] Setting up 2GB swap space..."
    sudo fallocate -l 2G /swapfile 2>/dev/null || sudo dd if=/dev/zero of=/swapfile bs=1M count=2048
    sudo chmod 600 /swapfile
    sudo mkswap /swapfile
    sudo swapon /swapfile
    echo '/swapfile none swap sw 0 0' | sudo tee -a /etc/fstab
fi

# 3. Detect Package Manager & Install Node.js 20 & Caddy
if command -v apt-get >/dev/null 2>&1; then
    echo "[Deps] Debian/Ubuntu detected. Installing Node.js 20 & Caddy..."
    export DEBIAN_FRONTEND=noninteractive
    sudo apt-get update -y
    sudo apt-get install -y curl ca-certificates gnupg debian-keyring debian-archive-keyring apt-transport-https iptables-persistent

    # Node.js 20
    sudo mkdir -p /etc/apt/keyrings
    curl -fsSL https://deb.nodesource.com/gpgkey/nodesource-repo.gpg.key | sudo gpg --dearmor -o /etc/apt/keyrings/nodesource.gpg --yes
    echo "deb [signed-by=/etc/apt/keyrings/nodesource.gpg] https://deb.nodesource.com/node_20.x nodistro main" | sudo tee /etc/apt/sources.list.d/nodesource.list
    sudo apt-get update -y
    sudo apt-get install -y nodejs

    # Caddy
    curl -1sLf 'https://dl.cloudsmith.io/public/caddy/stable/gpg.key' | sudo gpg --dearmor -o /usr/share/keyrings/caddy-stable-archive-keyring.gpg --yes
    curl -1sLf 'https://dl.cloudsmith.io/public/caddy/stable/debian.deb.txt' | sudo tee /etc/apt/sources.list.d/caddy-stable.list
    sudo apt-get update -y
    sudo apt-get install -y caddy

elif command -v dnf >/dev/null 2>&1 || command -v yum >/dev/null 2>&1; then
    echo "[Deps] Oracle Linux / RHEL detected. Installing Node.js 20 & Caddy..."
    PKG_MGR="dnf"
    command -v dnf >/dev/null 2>&1 || PKG_MGR="yum"

    sudo $PKG_MGR install -y curl tar bzip2
    curl -fsSL https://rpm.nodesource.com/setup_20.x | sudo bash -
    sudo $PKG_MGR install -y nodejs

    sudo $PKG_MGR install -y 'dnf-command(copr)' 2>/dev/null || true
    sudo $PKG_MGR copr enable -y @caddy/caddy 2>/dev/null || true
    sudo $PKG_MGR install -y caddy
fi

# 4. Service User & App Directory
echo "[App] Preparing application directory..."
sudo mkdir -p /opt/webrtc-server
id -u {SERVICE_USER} >/dev/null 2>&1 || sudo useradd --system --no-create-home --shell /usr/sbin/nologin {SERVICE_USER}
sudo chown -R {SERVICE_USER}:{SERVICE_USER} /opt/webrtc-server

# 5. Discover External IP & Configure Caddy Reverse Proxy
EXTERNAL_IP=$(curl -s -m 5 https://api.ipify.org || curl -s -m 5 http://checkip.amazonaws.com || hostname -I | awk '{{print $1}}')
DOMAIN="${{EXTERNAL_IP}}.sslip.io"

echo "[TLS] Configuring Caddy for domain: ${{DOMAIN}}"
sudo tee /etc/caddy/Caddyfile >/dev/null <<EOF
{{
    admin off
}}

# Automated Let's Encrypt TLS on standard HTTPS/WSS (443) and 8443 for orc.3rtc.me and sslip.io
orc.3rtc.me:443, orc.3rtc.me:8443, ${{DOMAIN}}:443, ${{DOMAIN}}:8443 {{
    reverse_proxy 127.0.0.1:8080
}}

# Automatically redirect all plain HTTP requests on port 80 to HTTPS while supporting health checks
:80 {{
    @health path /healthz /status
    handle @health {{
        respond "3RTC WebRTC Signaling Server Ready" 200
    }}
    handle {{
        redir https://{{host}}{{uri}} permanent
    }}
}}
EOF

sudo systemctl daemon-reload
sudo systemctl enable caddy
sudo systemctl restart caddy

echo "[Done] Oracle Cloud OS bootstrap finished successfully!"
"""
    return script


def build_update_command(server_files):
    moves = " && ".join(f"sudo mv \"$STAGING_DIR/{f.name}\" /opt/webrtc-server/{f.name}" for f in server_files)
    caddy_check = (
        "if [ ! -f /etc/caddy/Caddyfile ] || ! grep -q 'orc.3rtc.me' /etc/caddy/Caddyfile 2>/dev/null; then "
        "EXT_IP=$(curl -s -m 5 https://api.ipify.org || hostname -I | awk '{print $1}'); "
        "printf '{\\n    admin off\\n}\\norc.3rtc.me:443, orc.3rtc.me:8443, %s.sslip.io:443, %s.sslip.io:8443 {\\n    reverse_proxy 127.0.0.1:8080\\n}\\n:80 {\\n    @health path /healthz /status\\n    handle @health {\\n        respond \"3RTC Ready\" 200\\n    }\\n    handle {\\n        redir https://{host}{uri} permanent\\n    }\\n}\\n' \"$EXT_IP\" \"$EXT_IP\" | sudo tee /etc/caddy/Caddyfile >/dev/null && "
        "sudo systemctl daemon-reload && sudo systemctl enable caddy && sudo systemctl restart caddy; fi"
    )
    return (
        'STAGING_DIR="$HOME/staging_3rtc" && '
        "sudo mkdir -p /opt/webrtc-server && "
        f"{moves} && cd /opt/webrtc-server"
        " && (sudo npm install --omit=dev --no-audit --no-fund --silent || echo 'Dependencies unchanged')"
        f" && (id -u {SERVICE_USER} >/dev/null 2>&1 || sudo useradd --system --no-create-home --shell /usr/sbin/nologin {SERVICE_USER})"
        f" && sudo chown -R {SERVICE_USER}:{SERVICE_USER} /opt/webrtc-server"
        " && (sudo chmod 600 /opt/webrtc-server/.youtube-api-key 2>/dev/null || true)"
        f" && sudo mv \"$STAGING_DIR/{SERVICE_FILE}\" /etc/systemd/system/{SERVICE_FILE}"
        f" && sudo chown root:root /etc/systemd/system/{SERVICE_FILE}"
        " && sudo systemctl daemon-reload"
        " && sudo systemctl enable webrtc-signaling"
        " && sudo systemctl restart webrtc-signaling"
        f" && {caddy_check}"
        " && sudo systemctl restart caddy 2>/dev/null || true"
        ' && rm -rf "$STAGING_DIR"'
    )


def wait_for_ready(external_ip):
    print_step("Verifying Deployment & Obtaining wss:// URL")
    domain = f"{external_ip}.sslip.io"
    http_url = f"http://{external_ip}"
    wss_url = f"wss://{domain}:{DEFAULT_PORT}"
    wss_alt = f"wss://{domain}:{ALT_PORT}"

    print(f"Server domain: {domain}")
    print("Waiting for Caddy reverse proxy and SSL certificate to initialize...")
    print("(This typically takes ~20-45 seconds)")

    max_retries = 30
    ready = False
    for i in range(1, max_retries + 1):
        try:
            req = urllib.request.Request(http_url, headers={"User-Agent": "Mozilla/5.0"})
            with urllib.request.urlopen(req, timeout=4) as response:
                if response.status == 200:
                    ready = True
                    break
        except Exception:
            pass

        time.sleep(5)
        print(f"  [{i * 5}s] Checking HTTP & TLS connectivity...", end="\r", flush=True)

    print()
    if ready:
        print("[OK] Signaling server and TLS reverse proxy are LIVE!")
    else:
        print("[Notice] Setup complete. If Let's Encrypt is still provisioning, URLs will become active in a moment.")

    print("\n" + "=" * 65)
    print(" 3RTC WebRTC Signaling Server Live (Oracle Always Free)")
    print("=" * 65)
    print(f"\n Secure WebSocket (WSS) URLs for Testing:\n")
    print(f"  Oracle Test URL : {wss_url}")
    print(f"  Alternative WSS : {wss_alt}")
    print(f"  Production DNS  : wss://{SIGNAL_DOMAIN} (Kept on GCP until you decide to switch)")
    print("\n" + "-" * 65)
    print("Server Details:")
    print(f"  External IP  : {external_ip}")
    print(f"  SSL Domain   : {domain} (Valid Let's Encrypt Certificate)")
    print("  Host Cloud   : Oracle Cloud Infrastructure (Always Free Tier)")
    print("=" * 65 + "\n")


def get_known_hosts_path():
    ssh_dir = Path.home() / ".ssh"
    ssh_dir.mkdir(parents=True, exist_ok=True)
    return str(ssh_dir / "oracle_3rtc_known_hosts")


def prepare_remote_staging(ssh_bin, user, host, key_path):
    cmd = 'mkdir -p "$HOME/staging_3rtc" && chmod 700 "$HOME/staging_3rtc"'
    execute_remote_ssh(ssh_bin, user, host, key_path, cmd)


def get_existing_remote_youtube_key(ssh_bin, user, host, key_path):
    cmd = [
        ssh_bin,
        "-i", str(key_path),
        "-o", "StrictHostKeyChecking=accept-new",
        "-o", f"UserKnownHostsFile={get_known_hosts_path()}",
        "-o", "ConnectTimeout=10",
        f"{user}@{host}",
        "sudo cat /opt/webrtc-server/.youtube-api-key 2>/dev/null || true"
    ]
    try:
        res = subprocess.run(cmd, capture_output=True, text=True, check=False)
        key = (res.stdout or "").strip()
        if key:
            return key
    except Exception:
        pass

    env_key = os.environ.get("YOUTUBE_API_KEY", "").strip()
    if env_key:
        return env_key
    local_key_file = Path(__file__).resolve().parent / ".youtube-api-key"
    if local_key_file.exists():
        try:
            fkey = local_key_file.read_text(encoding="utf-8").strip()
            if fkey:
                return fkey
        except Exception:
            pass
    return None


def configure_quick_picks(ssh_bin, user, host, key_path):
    print_step("YouTube Quick Picks Setup (Optional)")
    print("Quick picks can fetch trending and search videos using a YouTube Data API v3 key.")
    print("The key is stored securely in /opt/webrtc-server/.youtube-api-key.")

    existing_key = get_existing_remote_youtube_key(ssh_bin, user, host, key_path)
    if existing_key:
        print(f"\nExisting YouTube Data API Key: {existing_key}")
        prompt = "Enter new YouTube Data API key (or press Enter to keep existing): "
    else:
        print("\nExisting YouTube Data API Key: No API key")
        prompt = "Enter YouTube Data API key (or press Enter to skip): "

    new_key = input(prompt).strip()
    if not new_key:
        if existing_key:
            print("[OK] Keeping existing YouTube Data API key.")
            check_remote = subprocess.run([
                ssh_bin, "-i", str(key_path),
                "-o", "StrictHostKeyChecking=accept-new",
                "-o", f"UserKnownHostsFile={get_known_hosts_path()}",
                "-o", "ConnectTimeout=10",
                f"{user}@{host}",
                "sudo test -f /opt/webrtc-server/.youtube-api-key && echo 'EXISTS' || true"
            ], capture_output=True, text=True, check=False)
            if "EXISTS" in (check_remote.stdout or ""):
                return
            key_to_upload = existing_key
        else:
            print("Skipped. Built-in video presets remain active.")
            return
    else:
        key_to_upload = new_key
        try:
            local_key_file = Path(__file__).resolve().parent / ".youtube-api-key"
            local_key_file.write_text(key_to_upload + "\n", encoding="utf-8")
        except Exception:
            pass

    prepare_remote_staging(ssh_bin, user, host, key_path)

    fd, local_path = tempfile.mkstemp(prefix="yt-key-")
    try:
        with os.fdopen(fd, "w", encoding="utf-8") as f:
            f.write(key_to_upload + "\n")
        copy_remote_scp(find_scp(), user, host, key_path, [local_path], "staging_3rtc/.youtube-api-key")
    finally:
        os.remove(local_path)

    cmd = (
        'STAGING_DIR="$HOME/staging_3rtc" && '
        f"sudo install -m 600 -o {SERVICE_USER} -g {SERVICE_USER} \"$STAGING_DIR/.youtube-api-key\" /opt/webrtc-server/.youtube-api-key"
        ' && rm -f "$STAGING_DIR/.youtube-api-key" && sudo rm -f /opt/webrtc-server/quick-picks-cache.json'
        " && sudo systemctl restart webrtc-signaling"
    )
    execute_remote_ssh(ssh_bin, user, host, key_path, cmd)
    print("[OK] YouTube API key installed. Quick picks will refresh from YouTube API.")


def local_signal_secret():
    """The signing secret every 3RTC signaling server must share (see seats.js), so a room keeps
    working when people move between servers (the app falls back from Oracle to GCP). Taken from
    SIGNAL_SECRET, else server/.signal-secret next to this script (made once, git-ignored). The
    GCP deploy script uploads the same file."""
    env_secret = os.environ.get("SIGNAL_SECRET", "").strip()
    if env_secret:
        return env_secret
    secret_file = Path(__file__).resolve().parent / ".signal-secret"
    try:
        saved = secret_file.read_text(encoding="utf-8").strip()
        if len(saved) >= 32:
            return saved
    except FileNotFoundError:
        pass
    secret = secrets.token_hex(32)
    secret_file.write_text(secret + "\n", encoding="utf-8")
    try:
        os.chmod(secret_file, 0o600)
    except OSError:
        pass
    print(f"[OK] Made a shared signing secret in {secret_file}. Keep this file: the GCP deploy uses it too.")
    return secret


def sync_signal_secret(ssh_bin, user, host, key_path):
    """Install the shared signing secret as /opt/webrtc-server/.signal-secret (only if it differs)."""
    print_step("Shared signing secret (Oracle and GCP must match)")
    secret = local_signal_secret()
    want = hashlib.sha256(secret.encode("utf-8")).hexdigest()
    res = subprocess.run([
        ssh_bin, "-i", str(key_path),
        "-o", "StrictHostKeyChecking=accept-new",
        "-o", f"UserKnownHostsFile={get_known_hosts_path()}",
        "-o", "ConnectTimeout=10",
        f"{user}@{host}",
        "sudo cat /opt/webrtc-server/.signal-secret 2>/dev/null | tr -d '[:space:]' | sha256sum | cut -c1-64"
    ], capture_output=True, text=True, check=False)
    if (res.stdout or "").strip() == want:
        print("[OK] The server already uses the shared signing secret.")
        return
    prepare_remote_staging(ssh_bin, user, host, key_path)
    fd, local_path = tempfile.mkstemp(prefix="signal-secret-")
    try:
        with os.fdopen(fd, "w", encoding="utf-8") as f:
            f.write(secret + "\n")
        os.chmod(local_path, 0o600)
        copy_remote_scp(find_scp(), user, host, key_path, [local_path], "staging_3rtc/.signal-secret")
    finally:
        os.remove(local_path)
    cmd = (
        'STAGING_DIR="$HOME/staging_3rtc" && '
        f"sudo install -m 600 -o {SERVICE_USER} -g {SERVICE_USER} \"$STAGING_DIR/.signal-secret\" /opt/webrtc-server/.signal-secret"
        ' && rm -f "$STAGING_DIR/.signal-secret" && sudo systemctl restart webrtc-signaling'
    )
    execute_remote_ssh(ssh_bin, user, host, key_path, cmd)
    print("[OK] Shared signing secret installed; the service restarted.")


def copy_remote_scp(scp_bin, user, host, key_path, local_files, remote_dest):
    cmd = [
        scp_bin,
        "-i", str(key_path),
        "-o", "StrictHostKeyChecking=accept-new",
        "-o", f"UserKnownHostsFile={get_known_hosts_path()}",
        "-q",
        *[str(f) for f in local_files],
        f"{user}@{host}:{remote_dest}"
    ]
    return run_cmd(cmd, capture_output=False)


def execute_remote_ssh(ssh_bin, user, host, key_path, command):
    cmd = [
        ssh_bin,
        "-i", str(key_path),
        "-o", "StrictHostKeyChecking=accept-new",
        "-o", f"UserKnownHostsFile={get_known_hosts_path()}",
        "-o", "ConnectTimeout=15",
        f"{user}@{host}",
        command
    ]
    return run_cmd(cmd, capture_output=False)


# =====================================================================
# FULLY AUTOMATED OCI CLOUD PROVISIONING (No Browser Console Needed)
# =====================================================================

def detect_home_region(oci_bin, tenancy_id, auth_flags):
    """Detect the tenancy's real Home Region where Always Free resources reside."""
    print("Auto-detecting your Oracle Cloud Home Region...", end="", flush=True)

    # 1. Try currently configured region
    cfg = read_oci_config_section("DEFAULT")
    curr_region = cfg.get("region")
    if curr_region:
        res = run_cmd([oci_bin, "iam", "region-subscription", "list", "--tenancy-id", tenancy_id, "--region", curr_region, *auth_flags, "--output", "json"], check=False)
        if res.returncode == 0:
            subs = json.loads(res.stdout or "{}").get("data", [])
            for s in subs:
                if s.get("is-home-region"):
                    home = s.get("region-name")
                    print(f" [OK: {home}]")
                    return home

    # 2. Probe popular candidate regions
    for r in PROBE_REGIONS:
        res = run_cmd([oci_bin, "iam", "region-subscription", "list", "--tenancy-id", tenancy_id, "--region", r, *auth_flags, "--output", "json"], check=False)
        if res.returncode == 0:
            subs = json.loads(res.stdout or "{}").get("data", [])
            for s in subs:
                if s.get("is-home-region"):
                    home = s.get("region-name")
                    print(f" [OK: {home}]")
                    update_oci_config_region(home)
                    return home

    print(" [Fallback to ap-hyderabad-1]")
    return "ap-hyderabad-1"


def authenticate_oci(oci_bin):
    """Ensure OCI CLI is authenticated with active session or API key."""
    print_step("Step 2: Oracle Cloud Authentication")

    auth_flags = get_oci_auth_flags()
    config = read_oci_config_section("DEFAULT")

    if config and config.get("tenancy"):
        # Auto-detect real home region
        home_region = detect_home_region(oci_bin, config["tenancy"], auth_flags)
        config["region"] = home_region
        update_oci_config_region(home_region)
        print(f"[OK] Authenticated for Tenancy in Home Region: {home_region}")
        return config, auth_flags, home_region

    # If unauthenticated, trigger login
    print("\nOCI CLI requires authentication.")
    print("A browser window will open to sign into your Oracle Cloud account once.")
    run_cmd([oci_bin, "session", "authenticate"], capture_output=False)

    auth_flags = get_oci_auth_flags()
    config = read_oci_config_section("DEFAULT")
    home_region = detect_home_region(oci_bin, config["tenancy"], auth_flags)
    config["region"] = home_region
    update_oci_config_region(home_region)
    return config, auth_flags, home_region


def ensure_ssh_key():
    """Ensure an SSH key pair exists in ~/.ssh/oracle_3rtc_key for the VM."""
    ssh_dir = Path.home() / ".ssh"
    ssh_dir.mkdir(parents=True, exist_ok=True)
    priv_key = ssh_dir / "oracle_3rtc_key"
    pub_key = ssh_dir / "oracle_3rtc_key.pub"

    if not priv_key.exists() or not pub_key.exists():
        print(f"\nGenerating dedicated SSH key pair at: {priv_key}...")
        keygen = find_ssh_keygen()
        if keygen:
            run_cmd([keygen, "-t", "ed25519", "-N", "", "-f", str(priv_key), "-C", "3rtc-signaling"], capture_output=True)
        else:
            run_cmd([keygen, "-t", "rsa", "-b", "2048", "-N", "", "-f", str(priv_key), "-C", "3rtc-signaling"], capture_output=True)

    if sys.platform == "win32":
        try:
            username = os.environ.get("USERNAME")
            if username:
                subprocess.run(["icacls", str(priv_key), "/inheritance:r", "/grant:r", f"{username}:(R,W)"], capture_output=True)
        except Exception:
            pass

    return priv_key, pub_key


def get_oci_instances(oci_bin, compartment_id, region, auth_flags, timeout=None):
    """Retrieve all compute instances in the compartment and region.

    Returns a list (possibly empty) when OCI answered, or None when the query
    failed or timed out. Callers must treat None as "unknown", never as
    "no VM exists", so a failed query can never lead to a duplicate VM.
    """
    try:
        res = subprocess.run([
            oci_bin, "compute", "instance", "list",
            "--compartment-id", compartment_id,
            "--region", region,
            *auth_flags,
            "--output", "json"
        ], capture_output=True, text=True, check=False, timeout=timeout)
        if res.returncode == 0:
            return json.loads(res.stdout or "{}").get("data", [])
        if res.stderr:
            print(f"\n[Error Output]: {res.stderr.strip()}", flush=True)
    except subprocess.TimeoutExpired:
        print(f" [Timed out after {timeout}s]", end="", flush=True)
    except Exception:
        pass
    return None


def get_instance_public_ip(oci_bin, instance_id, region, auth_flags):
    """Retrieve public IP for an instance via its VNIC attachments."""
    try:
        vnic_res = run_cmd([
            oci_bin, "compute", "instance", "list-vnics",
            "--instance-id", instance_id,
            "--region", region,
            *auth_flags,
            "--output", "json"
        ], capture_output=True, check=False)
        if vnic_res.returncode == 0:
            vnics = json.loads(vnic_res.stdout or "{}").get("data", [])
            for vnic in vnics:
                pub = vnic.get("public-ip")
                if pub:
                    return pub
    except Exception:
        pass
    return None


def find_existing_3rtc_instance(instances):
    """Find existing 3RTC signaling instance, preferring running/starting ones."""
    active = [
        i for i in instances
        if i.get("lifecycle-state") not in ("TERMINATED", "TERMINATING")
    ]
    if not active:
        return None

    # 1. Exact match on standard display name "3rtc-signaling-server" that is running
    for inst in active:
        if inst.get("display-name") == "3rtc-signaling-server" and inst.get("lifecycle-state") in ("RUNNING", "STARTING", "PROVISIONING"):
            return inst

    # 2. Match on name containing "3rtc" or "signaling" that is running
    for inst in active:
        name = inst.get("display-name", "").lower()
        if ("3rtc" in name or "signaling" in name) and inst.get("lifecycle-state") in ("RUNNING", "STARTING", "PROVISIONING"):
            return inst

    # 3. Any running instance if only 1 active instance exists in tenancy
    running = [i for i in active if i.get("lifecycle-state") in ("RUNNING", "STARTING", "PROVISIONING")]
    if len(running) == 1:
        return running[0]

    # 4. Check stopped 3rtc instance that can be started
    for inst in active:
        if inst.get("display-name") == "3rtc-signaling-server":
            return inst

    for inst in active:
        name = inst.get("display-name", "").lower()
        if "3rtc" in name or "signaling" in name:
            return inst

    return None


def format_vm_hardware(vm):
    """Format VM shape, CPU cores, memory and processor description cleanly."""
    shape = vm.get("shape", "unknown")
    cfg = vm.get("shape-config") or {}
    ocpus = cfg.get("ocpus")
    vcpus = cfg.get("vcpus")
    memory_gb = cfg.get("memory-in-gbs")
    proc = cfg.get("processor-description")

    parts = []
    if ocpus is not None:
        cpu_text = f"{int(ocpus) if ocpus == int(ocpus) else ocpus} OCPU"
        if vcpus and vcpus != ocpus:
            cpu_text += f" ({vcpus} vCPUs)"
        parts.append(cpu_text)
    if memory_gb is not None:
        ram_text = f"{int(memory_gb) if memory_gb == int(memory_gb) else memory_gb} GB RAM"
        parts.append(ram_text)

    spec_summary = ", ".join(parts) if parts else "Default Specs"
    if proc:
        return f"{shape} ({spec_summary} | {proc})"
    return f"{shape} ({spec_summary})"


def ensure_security_rules(oci_bin, auth_flags, compartment_id, region, vcn_id=None):
    """Ensure Ingress Security Rules allow ports 22, 80, 443, 8443 on the VCN."""
    print("Ensuring Ingress Security Rules allow ports 22, 80, 443, 8443...", end="", flush=True)
    try:
        if not vcn_id:
            vcns_res = run_cmd([oci_bin, "network", "vcn", "list", "--compartment-id", compartment_id, "--region", region, *auth_flags, "--output", "json"], check=False)
            if vcns_res.returncode != 0:
                print(" [Skipped: VCN list query failed]")
                return
            vcns = json.loads(vcns_res.stdout or "{}").get("data", [])
            if not vcns:
                print(" [Skipped: No VCN found]")
                return
            vcn_id = vcns[0]["id"]

        sec_res = run_cmd([oci_bin, "network", "security-list", "list", "--compartment-id", compartment_id, "--vcn-id", vcn_id, "--region", region, *auth_flags, "--output", "json"], check=False)
        if sec_res.returncode != 0:
            print(" [Skipped: Security list query failed]")
            return
        sec_lists = json.loads(sec_res.stdout or "{}").get("data", [])
        if not sec_lists:
            print(" [Skipped: No Security list found]")
            return

        sec_id = sec_lists[0]["id"]
        existing_rules = sec_lists[0].get("ingress-security-rules", [])
        required_ports = [22, 80, 443, 8443]
        modified = False
        for p in required_ports:
            has_port = any(
                r.get("tcpOptions", {}).get("destinationPortRange", {}).get("min") == p
                for r in existing_rules
            )
            if not has_port:
                existing_rules.append({
                    "protocol": "6",
                    "source": "0.0.0.0/0",
                    "tcpOptions": {"destinationPortRange": {"min": p, "max": p}},
                    "description": f"3RTC port {p}"
                })
                modified = True

        if modified:
            run_cmd([
                oci_bin, "network", "security-list", "update",
                "--security-list-id", sec_id,
                "--ingress-security-rules", json.dumps(existing_rules),
                "--region", region,
                "--force",
                *auth_flags, "--output", "json"
            ], capture_output=True, check=False)
            print(" [Updated rules]")
        else:
            print(" [OK: Ports already open]")
    except Exception as e:
        print(f" [Notice: {e}]")


def provision_network(oci_bin, auth_flags, compartment_id, region):
    """Automatically ensure VCN, Subnet, and Security List exist with open ports."""
    print_step("Step 4: Provisioning Cloud Network & Firewall")

    # 1. Check for Existing VCN
    print(f"Checking for Virtual Cloud Network in {region}...", end="", flush=True)
    vcns_res = run_cmd([oci_bin, "network", "vcn", "list", "--compartment-id", compartment_id, "--region", region, *auth_flags, "--output", "json"])
    vcns = json.loads(vcns_res.stdout or "{}").get("data", [])
    
    if vcns:
        target_vcn = vcns[0]
        vcn_id = target_vcn["id"]
        print(f" [Using existing VCN: {target_vcn.get('display-name')}]")
    else:
        print(" [Creating new VCN: 3rtc-signaling-vcn]")
        create_vcn = run_cmd([
            oci_bin, "network", "vcn", "create",
            "--compartment-id", compartment_id,
            "--cidr-block", "10.0.0.0/16",
            "--display-name", "3rtc-signaling-vcn",
            "--dns-label", "rtc3vcn",
            "--region", region,
            *auth_flags, "--output", "json"
        ])
        vcn_id = json.loads(create_vcn.stdout)["data"]["id"]

    # 2. Check or Create Internet Gateway
    ig_res = run_cmd([oci_bin, "network", "internet-gateway", "list", "--compartment-id", compartment_id, "--vcn-id", vcn_id, "--region", region, *auth_flags, "--output", "json"])
    igs = json.loads(ig_res.stdout or "{}").get("data", [])
    if igs:
        ig_id = igs[0]["id"]
    else:
        print("Creating Internet Gateway...")
        create_ig = run_cmd([
            oci_bin, "network", "internet-gateway", "create",
            "--compartment-id", compartment_id,
            "--vcn-id", vcn_id,
            "--is-enabled", "true",
            "--display-name", "3rtc-ig",
            "--region", region,
            *auth_flags, "--output", "json"
        ])
        ig_id = json.loads(create_ig.stdout)["data"]["id"]

    # 3. Route Table: Route 0.0.0.0/0 to Internet Gateway
    rt_res = run_cmd([oci_bin, "network", "route-table", "list", "--compartment-id", compartment_id, "--vcn-id", vcn_id, "--region", region, *auth_flags, "--output", "json"])
    rts = json.loads(rt_res.stdout or "{}").get("data", [])
    if rts:
        rt_id = rts[0]["id"]
        route_rules = [
            {"destination": "0.0.0.0/0", "destinationType": "CIDR_BLOCK", "networkEntityId": ig_id}
        ]
        run_cmd([
            oci_bin, "network", "route-table", "update",
            "--rt-id", rt_id,
            "--route-rules", json.dumps(route_rules),
            "--region", region,
            "--force",
            *auth_flags, "--output", "json"
        ], capture_output=True)

    # 4. Security List: Allow Ingress on 22, 80, 443, 8443
    ensure_security_rules(oci_bin, auth_flags, compartment_id, region, vcn_id=vcn_id)

    # 5. Check or Create Public Subnet
    sub_res = run_cmd([oci_bin, "network", "subnet", "list", "--compartment-id", compartment_id, "--vcn-id", vcn_id, "--region", region, *auth_flags, "--output", "json"])
    subs = json.loads(sub_res.stdout or "{}").get("data", [])
    if subs:
        subnet_id = subs[0]["id"]
        print(f"[OK] Using subnet: {subs[0].get('display-name')}")
    else:
        print("Creating Public Subnet...")
        create_sub = run_cmd([
            oci_bin, "network", "subnet", "create",
            "--compartment-id", compartment_id,
            "--vcn-id", vcn_id,
            "--cidr-block", "10.0.0.0/24",
            "--display-name", "3rtc-subnet",
            "--dns-label", "rtc3sub",
            "--region", region,
            *auth_flags, "--output", "json"
        ])
        subnet_id = json.loads(create_sub.stdout)["data"]["id"]

    print("[OK] Virtual Cloud Network & Firewall ready.")
    return subnet_id


def find_ubuntu_image(oci_bin, auth_flags, compartment_id, shape, region):
    """Find latest Canonical Ubuntu image compatible with chosen shape in region."""
    print(f"Finding latest Canonical Ubuntu image for {shape}...", end="", flush=True)
    res = run_cmd([
        oci_bin, "compute", "image", "list",
        "--compartment-id", compartment_id,
        "--shape", shape,
        "--operating-system", "Canonical Ubuntu",
        "--region", region,
        *auth_flags, "--output", "json"
    ], check=False)

    images = json.loads(res.stdout or "{}").get("data", []) if res.returncode == 0 else []
    # Standard 22.04 or 24.04 preferred
    standard_imgs = [img for img in images if "22.04" in img.get("display-name", "") and "Minimal" not in img.get("display-name", "")]
    if standard_imgs:
        chosen = sorted(standard_imgs, key=lambda x: x.get("time-created", ""), reverse=True)[0]
        print(f" [OK: {chosen['display-name']}]")
        return chosen["id"]

    candidates = [img for img in images if "22.04" in img.get("display-name", "") or "24.04" in img.get("display-name", "")]
    if candidates:
        chosen = sorted(candidates, key=lambda x: x.get("time-created", ""), reverse=True)[0]
        print(f" [OK: {chosen['display-name']}]")
        return chosen["id"]

    if images:
        chosen = sorted(images, key=lambda x: x.get("time-created", ""), reverse=True)[0]
        print(f" [OK: {chosen['display-name']}]")
        return chosen["id"]

    raise RuntimeError(f"No Canonical Ubuntu images found for {shape} in region {region}.")


def get_ampere_available_limits(oci_bin, compartment_id, selected_ad, region, auth_flags):
    """Query tenancy's available Ampere A1 OCPUs and RAM to prevent LimitExceeded errors."""
    avail_cores = 4
    avail_ram = 24
    try:
        core_res = run_cmd([
            oci_bin, "limits", "resource-availability", "get",
            "--compartment-id", compartment_id,
            "--service-name", "compute",
            "--limit-name", "standard-a1-core-count",
            "--availability-domain", selected_ad,
            "--region", region,
            *auth_flags,
            "--output", "json"
        ], capture_output=True, check=False)
        if core_res.returncode == 0:
            c_data = json.loads(core_res.stdout or "{}").get("data", {})
            if "available" in c_data and c_data["available"] is not None:
                avail_cores = int(c_data["available"])

        mem_res = run_cmd([
            oci_bin, "limits", "resource-availability", "get",
            "--compartment-id", compartment_id,
            "--service-name", "compute",
            "--limit-name", "standard-a1-memory-count",
            "--availability-domain", selected_ad,
            "--region", region,
            *auth_flags,
            "--output", "json"
        ], capture_output=True, check=False)
        if mem_res.returncode == 0:
            m_data = json.loads(mem_res.stdout or "{}").get("data", {})
            if "available" in m_data and m_data["available"] is not None:
                avail_ram = int(m_data["available"])
    except Exception:
        pass

    return avail_cores, avail_ram


def launch_oci_vm_automated(script_dir, server_files, oci_bin, ssh_bin, scp_bin=None):
    """End-to-end automated VM creation or existing VM detection and hot-reload."""
    config, auth_flags, region = authenticate_oci(oci_bin)
    compartment_id = config.get("tenancy")
    if not compartment_id:
        print("[ERROR] Tenancy OCID not found in OCI configuration.")
        sys.exit(1)

    # Check for existing VM FIRST! NEVER create a new VM if one is already running!
    print_step("Step 3: Checking for Existing 3RTC VM")
    instances = get_oci_instances(oci_bin, compartment_id, region, auth_flags)
    if instances is None:
        print("[ERROR] Could not list compute instances in Oracle Cloud, so it is unknown whether a 3RTC VM already exists.")
        print("        Not creating a VM (that could duplicate an existing one). Fix OCI access and re-run,")
        print("        or hot-reload a known VM directly:  python deploy_oracle.py --ip <PUBLIC_IP>")
        sys.exit(1)
    existing_vm = find_existing_3rtc_instance(instances)

    if existing_vm:
        vm_name = existing_vm.get("display-name", "3rtc-signaling-server")
        vm_id = existing_vm.get("id")
        vm_state = existing_vm.get("lifecycle-state")
        vm_hw = format_vm_hardware(existing_vm)
        print(f"[OK] Detected existing VM in Oracle Cloud: '{vm_name}' [{vm_state}]")
        print(f"     Provisioned Hardware: {vm_hw}")

        if vm_state == "STOPPED":
            print(f"\nInstance '{vm_name}' is currently STOPPED. Starting instance...", end="", flush=True)
            run_cmd([oci_bin, "compute", "instance", "action", "--action", "START", "--instance-id", vm_id, "--region", region, *auth_flags, "--output", "json"], check=False)
            for _ in range(30):
                time.sleep(5)
                print(".", end="", flush=True)
                inst_get = run_cmd([oci_bin, "compute", "instance", "get", "--instance-id", vm_id, "--region", region, *auth_flags, "--output", "json"], check=False)
                if inst_get.returncode == 0:
                    st = json.loads(inst_get.stdout).get("data", {}).get("lifecycle-state")
                    if st == "RUNNING":
                        break
            print(" [RUNNING!]")

        print("Fetching Public IP for existing VM...", end="", flush=True)
        public_ip = None
        for _ in range(6):
            public_ip = get_instance_public_ip(oci_bin, vm_id, region, auth_flags)
            if public_ip:
                break
            time.sleep(3)

        if not public_ip:
            cached = load_cache(script_dir)
            if cached and cached.get("host"):
                public_ip = cached["host"]
                print(f" [Using cached IP: {public_ip}]")
            else:
                print(" [Unable to query IP via API]")
                public_ip = input("Enter Public IP for this VM: ").strip()
        else:
            print(f" [Public IP: {public_ip}]")

        ensure_security_rules(oci_bin, auth_flags, compartment_id, region)
        priv_key, pub_key = ensure_ssh_key()
        save_cache(script_dir, {"host": public_ip, "user": "ubuntu", "key_path": str(priv_key), "region": region, "vm_id": vm_id})

        print(f"\n[HOT RELOAD] Existing VM is already active! Updating server code on {public_ip} without creating a new VM...")
        reloaded = hot_reload_instance(
            script_dir, server_files, ssh_bin, scp_bin or find_scp(), public_ip, "ubuntu", priv_key,
            oci_bin=oci_bin, region=region, auth_flags=auth_flags, vm_id=vm_id
        )
        if reloaded:
            return
        print("\n[Notice] Inaccessible VM was terminated. Proceeding to create a fresh Always Free VM...")

    print("\nNo existing 3RTC VM detected. Proceeding to create a new Always Free instance.")
    # 1. Availability Domain
    print_step("Step 4: Availability Domain & VM Shape")
    ad_res = run_cmd([oci_bin, "iam", "availability-domain", "list", "--compartment-id", compartment_id, "--region", region, *auth_flags, "--output", "json"])
    ads = json.loads(ad_res.stdout or "{}").get("data", [])
    if not ads:
        print(f"[ERROR] No Availability Domains found in region '{region}'.")
        sys.exit(1)

    if len(ads) == 1:
        selected_ad = ads[0]["name"]
        print(f"[OK] Availability Domain: {selected_ad}")
    else:
        print("Available Availability Domains:")
        for idx, ad in enumerate(ads, 1):
            print(f"  {idx}) {ad['name']}")
        ad_choice = input(f"\nSelect Availability Domain [1-{len(ads)}, default: 1]: ").strip() or "1"
        ad_idx = int(ad_choice) - 1 if ad_choice.isdigit() and 1 <= int(ad_choice) <= len(ads) else 0
        selected_ad = ads[ad_idx]["name"]

    # 2. Shape Selection (Always Free)
    print("Checking tenancy compute resource availability...", end="", flush=True)
    avail_cores, avail_ram = get_ampere_available_limits(oci_bin, compartment_id, selected_ad, region, auth_flags)
    print(f" [Ampere Limit: {avail_cores} OCPUs, {avail_ram} GB RAM]")

    print("\nSelect Always Free VM Shape:")
    if avail_cores >= 2:
        print(f"  1) Ampere A1 (ARM): {avail_cores} OCPUs, {avail_ram} GB RAM (Your Account Limit) [Recommended]")
        if avail_cores > 1:
            print("  2) Ampere A1 (ARM): 1 OCPU, 6 GB RAM (Minimal ARM)")
            print("  3) AMD Micro: 1 OCPU, 1 GB RAM (VM.Standard.E2.1.Micro) [Always Free Micro]")
        else:
            print("  2) AMD Micro: 1 OCPU, 1 GB RAM (VM.Standard.E2.1.Micro) [Always Free Micro]")

        shape_choice = input("\nSelect shape [1-3, default: 1]: ").strip() or "1"
        if shape_choice == "2" and avail_cores > 1:
            shape = "VM.Standard.A1.Flex"
            ocpus, ram = 1, 6
        elif shape_choice == "3" or (shape_choice == "2" and avail_cores <= 1):
            shape = "VM.Standard.E2.1.Micro"
            ocpus, ram = None, None
        else:
            shape = "VM.Standard.A1.Flex"
            ocpus, ram = avail_cores, avail_ram
    elif avail_cores == 1:
        print(f"  1) Ampere A1 (ARM): 1 OCPU, {avail_ram} GB RAM (Your Account Limit) [Recommended]")
        print("  2) AMD Micro: 1 OCPU, 1 GB RAM (VM.Standard.E2.1.Micro) [Always Free Micro]")
        shape_choice = input("\nSelect shape [1-2, default: 1]: ").strip() or "1"
        if shape_choice == "2":
            shape = "VM.Standard.E2.1.Micro"
            ocpus, ram = None, None
        else:
            shape = "VM.Standard.A1.Flex"
            ocpus, ram = 1, avail_ram
    else:
        print("  (Note: Ampere A1 service limit is 0 in your account for this region.)")
        print("  1) AMD Micro: 1 OCPU, 1 GB RAM (VM.Standard.E2.1.Micro) [Always Free Micro] [Recommended]")
        shape_choice = input("\nSelect shape [default: 1]: ").strip() or "1"
        shape = "VM.Standard.E2.1.Micro"
        ocpus, ram = None, None

    # 3. Network & Security
    subnet_id = provision_network(oci_bin, auth_flags, compartment_id, region)

    # 4. SSH Keypair
    priv_key, pub_key = ensure_ssh_key()
    print(f"[OK] Using SSH Key: {priv_key}")

    # 5. OS Image
    image_id = find_ubuntu_image(oci_bin, auth_flags, compartment_id, shape, region)

    # 6. Startup Script (Cloud-Init Bootstrap)
    print_step("Step 5: Launching Always Free Instance")
    startup_content = build_remote_bootstrap_script()
    temp_script = script_dir / "_oracle_startup.sh"
    try:
        with open(temp_script, "w", encoding="utf-8", newline="\n") as f:
            f.write(startup_content)

        launch_args = [
            oci_bin, "compute", "instance", "launch",
            "--availability-domain", selected_ad,
            "--compartment-id", compartment_id,
            "--shape", shape,
            "--image-id", image_id,
            "--subnet-id", subnet_id,
            "--display-name", "3rtc-signaling-server",
            "--assign-public-ip", "true",
            "--ssh-authorized-keys-file", str(pub_key),
            "--user-data-file", str(temp_script),
            "--region", region,
            *auth_flags,
            "--output", "json"
        ]
        if ocpus and ram:
            launch_args.extend(["--shape-config", json.dumps({"ocpus": ocpus, "memoryInGBs": ram})])

        print(f"Launching instance in {selected_ad} ({region})...")
        while True:
            try:
                launch_res = run_cmd(launch_args)
                instance_data = json.loads(launch_res.stdout)["data"]
                instance_id = instance_data["id"]
                break
            except subprocess.CalledProcessError as e:
                err_text = str(e)
                if hasattr(e, "stderr") and e.stderr:
                    err_text += " " + e.stderr
                err_lower = err_text.lower()

                if "limitexceeded" in err_lower or "limits were exceeded" in err_lower or "limit exceeded" in err_lower:
                    print(f"\n[!] Oracle Cloud Service Limit exceeded for {shape}.")
                    if shape == "VM.Standard.A1.Flex" and ocpus and (ocpus > 1 or ram > 6):
                        print("Options:")
                        print("  1) Downscale to 1 OCPU, 6 GB RAM and retry")
                        print("  2) Switch to AMD Micro instance (VM.Standard.E2.1.Micro) [Always Free]")
                        print("  3) Cancel")
                        lim_choice = input("Select option [1-3, default: 1]: ").strip() or "1"
                        if lim_choice == "1":
                            ocpus, ram = 1, 6
                            launch_args = [
                                oci_bin, "compute", "instance", "launch",
                                "--availability-domain", selected_ad,
                                "--compartment-id", compartment_id,
                                "--shape", shape,
                                "--image-id", image_id,
                                "--subnet-id", subnet_id,
                                "--display-name", "3rtc-signaling-server",
                                "--assign-public-ip", "true",
                                "--ssh-authorized-keys-file", str(pub_key),
                                "--user-data-file", str(temp_script),
                                "--region", region,
                                *auth_flags,
                                "--output", "json",
                                "--shape-config", json.dumps({"ocpus": ocpus, "memoryInGBs": ram})
                            ]
                            print("Retrying with 1 OCPU, 6 GB RAM...")
                            continue
                        elif lim_choice == "2":
                            shape = "VM.Standard.E2.1.Micro"
                            ocpus, ram = None, None
                            image_id = find_ubuntu_image(oci_bin, auth_flags, compartment_id, shape, region)
                            launch_args = [
                                oci_bin, "compute", "instance", "launch",
                                "--availability-domain", selected_ad,
                                "--compartment-id", compartment_id,
                                "--shape", shape,
                                "--image-id", image_id,
                                "--subnet-id", subnet_id,
                                "--display-name", "3rtc-signaling-server",
                                "--assign-public-ip", "true",
                                "--ssh-authorized-keys-file", str(pub_key),
                                "--user-data-file", str(temp_script),
                                "--region", region,
                                *auth_flags,
                                "--output", "json"
                            ]
                            print("Retrying with AMD Micro...")
                            continue
                        else:
                            sys.exit(0)
                    else:
                        print("Options:")
                        print("  1) Switch to AMD Micro instance (VM.Standard.E2.1.Micro) [Always Free]")
                        print("  2) Cancel")
                        lim_choice = input("Select option [1-2, default: 1]: ").strip() or "1"
                        if lim_choice == "1":
                            shape = "VM.Standard.E2.1.Micro"
                            ocpus, ram = None, None
                            image_id = find_ubuntu_image(oci_bin, auth_flags, compartment_id, shape, region)
                            launch_args = [
                                oci_bin, "compute", "instance", "launch",
                                "--availability-domain", selected_ad,
                                "--compartment-id", compartment_id,
                                "--shape", shape,
                                "--image-id", image_id,
                                "--subnet-id", subnet_id,
                                "--display-name", "3rtc-signaling-server",
                                "--assign-public-ip", "true",
                                "--ssh-authorized-keys-file", str(pub_key),
                                "--user-data-file", str(temp_script),
                                "--region", region,
                                *auth_flags,
                                "--output", "json"
                            ]
                            print("Retrying with AMD Micro...")
                            continue
                        else:
                            sys.exit(0)

                elif "toomanyrequests" in err_lower or "too many requests" in err_lower or "status: 429" in err_lower:
                    print("\n[!] Oracle API rate limit reached (HTTP 429: Too Many Requests).")
                    print("Waiting 45 seconds for API rate limits to reset before retrying...")
                    time.sleep(45)
                    continue

                elif "out of host capacity" in err_lower or "out of capacity" in err_lower:
                    print("\n[!] Oracle Cloud returned: Out of host capacity for Ampere A1 ARM in ap-hyderabad-1.")
                    print("Free Tier Ampere slots in this datacenter are currently full.")
                    print("\nOptions:")
                    print("  1) Switch to AMD Micro instance (VM.Standard.E2.1.Micro) [Always Free, Available Now] (Recommended)")
                    print("  2) Retry Ampere A1 (wait 45 seconds and retry)")
                    print("  3) Cancel")
                    cap_choice = input("Select option [1-3, default: 1]: ").strip() or "1"
                    if cap_choice == "2":
                        print("Waiting 45 seconds before retry to prevent rate limits... (Ctrl+C to abort)")
                        time.sleep(45)
                        continue
                    elif cap_choice == "1":
                        shape = "VM.Standard.E2.1.Micro"
                        ocpus, ram = None, None
                        image_id = find_ubuntu_image(oci_bin, auth_flags, compartment_id, shape, region)
                        launch_args = [
                            oci_bin, "compute", "instance", "launch",
                            "--availability-domain", selected_ad,
                            "--compartment-id", compartment_id,
                            "--shape", shape,
                            "--image-id", image_id,
                            "--subnet-id", subnet_id,
                            "--display-name", "3rtc-signaling-server",
                            "--assign-public-ip", "true",
                            "--ssh-authorized-keys-file", str(pub_key),
                            "--user-data-file", str(temp_script),
                            "--region", region,
                            *auth_flags,
                            "--output", "json"
                        ]
                        print("Switching to AMD Micro (VM.Standard.E2.1.Micro)...")
                        continue
                    else:
                        sys.exit(0)
                else:
                    raise

    finally:
        if temp_script.exists():
            temp_script.unlink()

    # 7. Wait for RUNNING and Public IP
    print(f"\n[OK] Instance created! ID: {instance_id}")
    print("Waiting for VM state to transition to 'RUNNING'...", end="", flush=True)

    public_ip = None
    for _ in range(30):
        time.sleep(5)
        print(".", end="", flush=True)
        inst_get = run_cmd([oci_bin, "compute", "instance", "get", "--instance-id", instance_id, "--region", region, *auth_flags, "--output", "json"], check=False)
        if inst_get.returncode == 0:
            state = json.loads(inst_get.stdout).get("data", {}).get("lifecycle-state")
            if state == "RUNNING":
                break

    print(" [RUNNING!]")
    print("Fetching assigned Public IP...")
    for _ in range(6):
        vnic_res = run_cmd([oci_bin, "compute", "instance", "list-vnics", "--instance-id", instance_id, "--region", region, *auth_flags, "--output", "json"])
        vnics = json.loads(vnic_res.stdout or "{}").get("data", [])
        if vnics and vnics[0].get("public-ip"):
            public_ip = vnics[0].get("public-ip")
            break
        time.sleep(5)

    if not public_ip:
        print("[ERROR] Could not retrieve Public IP. Check OCI Console.")
        sys.exit(1)

    print(f"\n[SUCCESS] Public IP: {public_ip}")
    save_cache(script_dir, {"host": public_ip, "user": "ubuntu", "key_path": str(priv_key)})

    # 8. Wait for SSH & cloud-init OS bootstrap
    print(f"\nWaiting for SSH and OS packages on {public_ip}...", end="", flush=True)
    actual_scp = scp_bin or find_scp()
    ssh_ready = False
    for attempt in range(60):
        check_res = subprocess.run([
            ssh_bin,
            "-i", str(priv_key),
            "-o", "StrictHostKeyChecking=accept-new",
            "-o", f"UserKnownHostsFile={get_known_hosts_path()}",
            "-o", "ConnectTimeout=5",
            "-o", "BatchMode=yes",
            f"ubuntu@{public_ip}",
            "which cloud-init >/dev/null 2>&1 && cloud-init status --wait || true"
        ], capture_output=True, text=True)
        if check_res.returncode == 0:
            ssh_ready = True
            print(" [Ready!]")
            break
        time.sleep(5)
        print(".", end="", flush=True)

    if not ssh_ready:
        print("\n[Notice] Proceeding with file upload and service setup...")

    # 9. Upload application files & start service
    hot_reload_instance(script_dir, server_files, ssh_bin, actual_scp, public_ip, "ubuntu", priv_key)


def terminate_instance_and_wait(oci_bin, vm_id, region, auth_flags):
    """Terminate an inaccessible VM and wait for it to free Always Free compute quota."""
    print(f"\nTerminating inaccessible VM ({vm_id})...", end="", flush=True)
    run_cmd([
        oci_bin, "compute", "instance", "terminate",
        "--instance-id", vm_id,
        "--preserve-boot-volume", "false",
        "--region", region,
        "--force",
        *auth_flags,
        "--output", "json"
    ], check=False)
    for _ in range(30):
        time.sleep(5)
        print(".", end="", flush=True)
        check = run_cmd([oci_bin, "compute", "instance", "get", "--instance-id", vm_id, "--region", region, *auth_flags, "--output", "json"], check=False)
        if check.returncode == 0:
            st = json.loads(check.stdout).get("data", {}).get("lifecycle-state")
            if st == "TERMINATED":
                break
    print(" [TERMINATED! Always Free slot freed]")


def verify_ssh_access(ssh_bin, user, host, key_path, oci_bin=None, region=None, auth_flags=None, vm_id=None):
    """Verify that the SSH private key can authenticate with the remote VM."""
    key = Path(key_path)
    print(f"Testing SSH connection to {user}@{host}...", end="", flush=True)
    while True:
        res = subprocess.run([
            ssh_bin,
            "-i", str(key),
            "-o", "StrictHostKeyChecking=accept-new",
            "-o", f"UserKnownHostsFile={get_known_hosts_path()}",
            "-o", "ConnectTimeout=8",
            "-o", "BatchMode=yes",
            f"{user}@{host}",
            "echo 'OK'"
        ], capture_output=True, text=True)
        if res.returncode == 0:
            print(" [Connected!]")
            return key

        print(" [Auth Failed]")
        print(f"\n[!] SSH Authentication failed for {user}@{host}")
        print("    The VM did not accept this SSH key.")
        print(f"    Key checked: {key}")

        pub_key_path = Path.home() / ".ssh" / "oracle_3rtc_key.pub"
        pub_key_content = pub_key_path.read_text(encoding="utf-8").strip() if pub_key_path.exists() else ""

        print("\nIf you are on a new laptop and DO NOT have the old key file, you have 2 options:")
        print("-" * 65)
        print("Option 1: Add this laptop's public key via Oracle Cloud Console (Keeps your VM & IP)")
        print("  1. In browser, open Oracle Cloud Console -> Compute -> Instances -> 3rtc-signaling-server")
        print("  2. Under 'Resources' on the bottom-left, click 'Console Connections'")
        print("  3. Click 'Launch Cloud Shell Connection'")
        if pub_key_content:
            print("  4. In the Cloud Shell terminal, paste and run this command:")
            print(f'     echo "{pub_key_content}" >> ~/.ssh/authorized_keys')
        else:
            print("  4. Paste this laptop's public key (~/.ssh/oracle_3rtc_key.pub) into ~/.ssh/authorized_keys")
        print("  5. Return here and press Enter to retry!")
        print("-" * 65)

        if oci_bin and vm_id and region and auth_flags:
            print("Option 2: Terminate inaccessible VM & create a fresh Always Free VM with this laptop's key")
            print("  (3RTC signaling servers are stateless; a new VM takes ~1 minute to launch)")
            print("-" * 65)
            print("Choices:")
            print("  1) Retry SSH connection (or specify path to private key)")
            print("  2) Terminate inaccessible VM and create a fresh one")
            print("  3) Exit")
            opt = input("\nSelect choice [1-3, default: 1]: ").strip() or "1"
            if opt == "2":
                confirm = input("Are you sure you want to terminate the inaccessible VM and create a fresh one? [y/N]: ").strip().lower()
                if confirm == "y":
                    terminate_instance_and_wait(oci_bin, vm_id, region, auth_flags)
                    return None
            elif opt == "3":
                sys.exit(0)

        choice = input("\nEnter path to private key (or press Enter to retry): ").strip()
        if choice:
            alt_path = Path(choice).expanduser().resolve()
            if alt_path.exists():
                key = alt_path
            else:
                print(f"[!] File not found: {alt_path}")
        print(f"Retrying SSH connection to {user}@{host}...", end="", flush=True)


def hot_reload_instance(script_dir, server_files, ssh_bin, scp_bin, host, user, key_path, oci_bin=None, region=None, auth_flags=None, vm_id=None):
    """Deploy updated server files to an existing VM and reload the service."""
    key_path = verify_ssh_access(ssh_bin, user, host, key_path, oci_bin=oci_bin, region=region, auth_flags=auth_flags, vm_id=vm_id)
    if not key_path:
        return False
    print_step(f"Hot-Reloading Signaling Server on {user}@{host}")
    print("Uploading latest server files to staging directory...")
    all_files = [*server_files, script_dir / SERVICE_FILE]
    prepare_remote_staging(ssh_bin, user, host, key_path)
    copy_remote_scp(scp_bin, user, host, key_path, all_files, "staging_3rtc/")

    print("Applying updates and reloading systemd service...")
    execute_remote_ssh(ssh_bin, user, host, key_path, build_update_command(server_files))
    save_cache(script_dir, {"host": host, "user": user, "key_path": str(key_path)})
    wait_for_ready(host)
    sync_signal_secret(ssh_bin, user, host, key_path)
    configure_quick_picks(ssh_bin, user, host, key_path)
    return True


def display_oci_running_status(oci_bin, script_dir, timeout=DEFAULT_CHECK_TIMEOUT):
    """Show the VMs in Oracle Cloud at startup (informational only).

    This check never decides whether a VM gets created: the automated deploy
    re-queries OCI itself and refuses to create a VM when that query fails.
    So it is safe to skip it (--skip-check / --quick / --ip, or Ctrl+C while
    it runs) and it is bounded by `timeout` seconds.
    """
    if not oci_bin:
        return None, []

    config = read_oci_config_section("DEFAULT")
    auth_flags = get_oci_auth_flags()
    tenancy_id = config.get("tenancy")
    if not tenancy_id:
        return None, []

    try:
        # Region lookup order: OCI config, then the region cached by an earlier
        # run. Probing regions one by one (detect_home_region) costs one OCI
        # CLI call per region, so it is only a last resort and its answer is cached.
        region = config.get("region") or (load_cache(script_dir) or {}).get("region")
        if not region:
            try:
                region = detect_home_region(oci_bin, tenancy_id, auth_flags)
                save_cache(script_dir, {"region": region})
            except Exception:
                region = "ap-hyderabad-1"

        print("Checking Oracle Cloud for active compute instances (Ctrl+C to skip)...", end="", flush=True)
        instances = get_oci_instances(oci_bin, tenancy_id, region, auth_flags, timeout=timeout)
    except KeyboardInterrupt:
        print(" [Skipped]")
        return None, []
    if instances is None:
        print(" [Unavailable: status check skipped]")
        return region, []
    running_vms = [i for i in instances if i.get("lifecycle-state") in ("RUNNING", "STARTING", "PROVISIONING")]
    stopped_vms = [i for i in instances if i.get("lifecycle-state") in ("STOPPED", "STOPPING")]
    print(" [Done]")

    print(f"\n{'-' * 65}")
    print(f" Oracle Cloud Infrastructure Status (Region: {region})")
    print(f" Currently Running VMs: {len(running_vms)}")
    if running_vms:
        for idx, vm in enumerate(running_vms, 1):
            name = vm.get("display-name", "unnamed")
            state = vm.get("lifecycle-state", "RUNNING")
            hw = format_vm_hardware(vm)
            print(f"   {idx}) {name} [{state}]")
            print(f"      Specs: {hw}")
    else:
        print("   (No compute instances currently running in this region)")

    if stopped_vms:
        print(f" Stopped VMs: {len(stopped_vms)}")
        for idx, vm in enumerate(stopped_vms, 1):
            name = vm.get("display-name", "unnamed")
            hw = format_vm_hardware(vm)
            print(f"   • {name} [STOPPED] - {hw}")
    print(f"{'-' * 65}\n")

    # If an existing 3RTC instance is running and cache is missing or stale, auto-seed cache
    existing_3rtc = find_existing_3rtc_instance(instances)
    if existing_3rtc and existing_3rtc.get("lifecycle-state") in ("RUNNING", "STARTING", "PROVISIONING"):
        cached = load_cache(script_dir)
        if not cached or not cached.get("host"):
            print("Auto-discovering public IP for running 3RTC instance...", end="", flush=True)
            pub_ip = get_instance_public_ip(oci_bin, existing_3rtc["id"], region, auth_flags)
            if pub_ip:
                print(f" [{pub_ip}]")
                priv_key, _ = ensure_ssh_key()
                cached_data = {"host": pub_ip, "user": "ubuntu", "key_path": str(priv_key), "region": region, "vm_id": existing_3rtc.get("id")}
                save_cache(script_dir, cached_data)
            else:
                print(" [No public IP yet]")

    return region, running_vms


def deploy_via_ssh(script_dir, server_files, ssh_bin, scp_bin, cached_info=None, host=None, user=None, key=None):
    """Direct SSH deployment for existing instances (never creates a VM).

    When `host` is given (--ip / --quick) nothing is prompted for: the user
    defaults to the cached one (or 'ubuntu') and the key to `key`, the cached
    key or ~/.ssh/oracle_3rtc_key.
    """
    print_step("Connect to Oracle Cloud VM via SSH")

    cached_host = cached_info.get("host", "") if cached_info else ""
    cached_user = cached_info.get("user", "ubuntu") if cached_info else "ubuntu"
    cached_key = cached_info.get("key_path", "") if cached_info else ""

    if host:
        user = user or cached_user
    else:
        host_prompt = f"Enter Oracle VM Public IP [{cached_host}]: " if cached_host else "Enter Oracle VM Public IP: "
        host = input(host_prompt).strip() or cached_host
        if not host:
            print("[ERROR] Public IP is required. Exiting.")
            sys.exit(1)
        user = user or input(f"SSH Username [default: {cached_user}]: ").strip() or cached_user

    if key:
        key_path = Path(key).expanduser().resolve()
    else:
        key_path = Path(cached_key) if cached_key and Path(cached_key).exists() else None

    if not key_path:
        default_priv = Path.home() / ".ssh" / "oracle_3rtc_key"
        if default_priv.exists():
            key_path = default_priv
        else:
            raw_p = input("Enter path to your SSH private key (.key/.pem): ").strip()
            key_path = Path(raw_p).expanduser().resolve()

    if not key_path.exists():
        print(f"[ERROR] SSH private key not found at '{key_path}'. Exiting.")
        sys.exit(1)

    hot_reload_instance(script_dir, server_files, ssh_bin, scp_bin, host, user, key_path)


def parse_args(argv=None):
    parser = argparse.ArgumentParser(
        prog="deploy_oracle.py",
        description="Deploy or hot-reload the 3RTC signaling server on an Oracle Cloud Always Free VM.",
        formatter_class=argparse.RawDescriptionHelpFormatter,
        epilog="""\
The startup "Checking Oracle Cloud for active compute instances" step only
shows status; skipping it is safe. Whatever you choose, a VM is only ever
created by the fully automated deploy, which always queries OCI for an
existing 3RTC VM first and refuses to create one if that query fails.

Examples:
  python deploy_oracle.py                 # interactive, with the status check
  python deploy_oracle.py --skip-check    # interactive menu straight away
  python deploy_oracle.py --quick         # hot-reload the cached VM, no prompts
  python deploy_oracle.py --ip 203.0.113.7 [--user ubuntu] [--key ~/.ssh/oracle_3rtc_key]
""")
    parser.add_argument("-s", "--skip-check", action="store_true",
                        help="skip the startup OCI status check and go to the menu")
    parser.add_argument("-q", "--quick", action="store_true",
                        help="skip the check and hot-reload the last deployed VM (from the local cache) "
                             "without prompts; falls back to the normal flow if nothing is cached")
    parser.add_argument("--ip", metavar="ADDR",
                        help="skip the check and hot-reload the VM at this public IP over SSH")
    parser.add_argument("--user", metavar="NAME", help="SSH user for --ip/--quick (default: cached or 'ubuntu')")
    parser.add_argument("--key", metavar="PATH", help="SSH private key for --ip/--quick (default: cached or ~/.ssh/oracle_3rtc_key)")
    parser.add_argument("--check-timeout", metavar="SECONDS", type=int, default=DEFAULT_CHECK_TIMEOUT,
                        help=f"give up on the startup status check after this many seconds (default: {DEFAULT_CHECK_TIMEOUT})")
    return parser.parse_args(argv)


def main():
    args = parse_args()
    print("""
=================================================================
  WebRTC Signaling Server - Oracle Cloud Always Free Deployer
=================================================================
""")
    script_dir, server_files, ssh_bin, scp_bin, oci_bin = check_prerequisites()
    cached_info = load_cache(script_dir)

    # Fast paths: SSH hot-reload of a known VM. These never call OCI and never create a VM.
    if args.ip:
        deploy_via_ssh(script_dir, server_files, ssh_bin, scp_bin, cached_info=cached_info,
                       host=args.ip.strip(), user=args.user, key=args.key)
        return
    if args.quick:
        if cached_info and cached_info.get("host"):
            print(f"[Quick] Hot-reloading cached deployment {cached_info.get('user', 'ubuntu')}@{cached_info['host']} (status check skipped)")
            deploy_via_ssh(script_dir, server_files, ssh_bin, scp_bin, cached_info=cached_info,
                           host=cached_info["host"], user=args.user, key=args.key)
            return
        print("[Quick] No cached deployment found; running the normal flow (with the status check) instead.")

    if args.skip_check and not args.quick:
        print("Skipping Oracle Cloud status check (--skip-check).")
    else:
        display_oci_running_status(oci_bin, script_dir, timeout=args.check_timeout)
        cached_info = load_cache(script_dir)  # the check may have discovered the IP

    if cached_info and cached_info.get("host"):
        print(f"Found active deployment: {cached_info.get('user', 'ubuntu')}@{cached_info.get('host')}")
        print("  1) Quick Hot-Update & Reload (Deploy latest code to running VM) [Recommended / Default]")
        print("  2) Fully Automated OCI Deploy (Detect Existing VM & Reload / Provision)")
        print("  3) Connect to a different Oracle VM via SSH")
        print("  4) Exit")
        print("  (Tip: `python deploy_oracle.py --quick` runs option 1 directly, without the status check.)")
        c = input("\nSelect choice [1-4, default: 1]: ").strip() or "1"
        if c == "1":
            deploy_via_ssh(script_dir, server_files, ssh_bin, scp_bin, cached_info=cached_info)
            return
        elif c == "2":
            launch_oci_vm_automated(script_dir, server_files, oci_bin, ssh_bin, scp_bin)
            return
        elif c == "3":
            deploy_via_ssh(script_dir, server_files, ssh_bin, scp_bin, cached_info=None)
            return
        else:
            sys.exit(0)

    print("Select Deployment Mode:")
    print("  1) Fully Automated OCI Deploy (Detect Existing VM & Reload / Create VM from Terminal) [Recommended]")
    print("  2) Connect to an Existing Oracle VM via SSH (Public IP + Key)")
    print("  3) Exit")
    choice = input("\nSelect option [1-3, default: 1]: ").strip() or "1"

    if choice == "1":
        if not oci_bin:
            print("[ERROR] Oracle Cloud CLI (oci) is required for full cloud automation.")
            print("Please run: pip install oci-cli")
            sys.exit(1)
        launch_oci_vm_automated(script_dir, server_files, oci_bin, ssh_bin, scp_bin)
    elif choice == "2":
        deploy_via_ssh(script_dir, server_files, ssh_bin, scp_bin)
    else:
        print("Exiting.")
        sys.exit(0)


if __name__ == "__main__":
    try:
        main()
    except KeyboardInterrupt:
        print("\nDeployment cancelled by user.")
        sys.exit(0)
