#!/usr/bin/env python3
"""
Deploy WebRTC Signaling Server to Google Cloud Platform Always Free Tier.
- Free Tier Spec: e2-micro instance, 30GB pd-standard disk in an eligible US region (us-central1, us-west1, or us-east1).
- TLS / WSS: Configures Caddy reverse proxy with automated Let's Encrypt SSL via <IP>.sslip.io.
"""

import sys
import os
import shutil
import subprocess
import json
import base64
import time
import urllib.request
import webbrowser
import getpass
import tempfile
import hashlib
import secrets
from pathlib import Path

# Eligible Always Free regions and zones
FREE_REGIONS = {
    "1": ("us-central1", "us-central1-a", "Iowa (us-central1-a) [Recommended]"),
    "2": ("us-west1", "us-west1-b", "Oregon (us-west1-b)"),
    "3": ("us-east1", "us-east1-b", "South Carolina (us-east1-b)")
}

FIREWALL_RULE_NAME = "allow-webrtc-signaling"
FIREWALL_TAG = "webrtc-signaling-server"
SIGNAL_DOMAIN = "gcp.3rtc.me"  # the app connects to wss://gcp.3rtc.me (A record -> VM IP)
DEFAULT_INSTANCE_NAME = "webrtc-signaling-free"
DEFAULT_PORT = "443"
ALT_PORT = "8443"


# Force line buffering for interactive terminals (Git Bash, MSYS2, Windows Terminal)
if hasattr(sys.stdout, 'reconfigure'):
    sys.stdout.reconfigure(line_buffering=True)
if hasattr(sys.stderr, 'reconfigure'):
    sys.stderr.reconfigure(line_buffering=True)



# Everything the server needs on the VM (server.js imports the others)
SERVER_FILES = ["server.js", "signaling.js", "seats.js", "rateLimit.js", "quickPicks.js", "linkPreview.js", "log.js", "package.json"]
# The systemd unit (installed to /etc/systemd/system/, not /opt/webrtc-server)
SERVICE_FILE = "webrtc-signaling.service"
# Only Caddy's ports are public; Node (8080) listens on localhost behind it
PUBLIC_PORTS = "tcp:80,tcp:443,tcp:8443"
# The service's own user (not root); it owns /opt/webrtc-server
SERVICE_USER = "webrtc"


def update_command(server_files):
    """Shell command run on the VM: move the uploaded files into place, install new dependencies
    if package.json changed, (re)install the service as its own user, restart it. Safe to repeat;
    it also moves an older VM (service as root, Node open on all interfaces) to the current setup."""
    moves = " && ".join(f"sudo mv \"$STAGING_DIR/{f.name}\" /opt/webrtc-server/{f.name}" for f in server_files)
    return ('STAGING_DIR="$HOME/staging_3rtc" && '
            "sudo mkdir -p /opt/webrtc-server && "
            f"{moves} && cd /opt/webrtc-server"
            " && (sudo npm install --omit=dev --no-audit --no-fund --silent || echo 'npm install failed: keeping the installed modules')"
            f" && (id -u {SERVICE_USER} >/dev/null 2>&1 || sudo useradd --system --no-create-home --shell /usr/sbin/nologin {SERVICE_USER})"
            f" && sudo chown -R {SERVICE_USER}:{SERVICE_USER} /opt/webrtc-server"
            " && (sudo chmod 600 /opt/webrtc-server/.youtube-api-key 2>/dev/null || true)"
            f" && sudo mv \"$STAGING_DIR/{SERVICE_FILE}\" /etc/systemd/system/{SERVICE_FILE}"
            f" && sudo chown root:root /etc/systemd/system/{SERVICE_FILE}"
            " && sudo systemctl daemon-reload"
            " && sudo systemctl restart webrtc-signaling"
            ' && rm -rf "$STAGING_DIR"')

def print_step(title):
    print(f"\n{'=' * 60}")
    print(f" {title}")
    print(f"{'=' * 60}", flush=True)


def find_gcloud():
    """Find gcloud executable across PATH and standard Windows/Unix locations."""
    cmd = shutil.which("gcloud") or shutil.which("gcloud.cmd")
    if cmd:
        return cmd

    if sys.platform == "win32":
        possible_paths = [
            os.path.expandvars(r"%LOCALAPPDATA%\Google\Cloud SDK\google-cloud-sdk\bin\gcloud.cmd"),
            os.path.expandvars(r"%ProgramFiles(x86)%\Google\Cloud SDK\google-cloud-sdk\bin\gcloud.cmd"),
            os.path.expandvars(r"%ProgramFiles%\Google\Cloud SDK\google-cloud-sdk\bin\gcloud.cmd"),
            os.path.expanduser(r"~\AppData\Local\Google\Cloud SDK\google-cloud-sdk\bin\gcloud.cmd")
        ]
        for p in possible_paths:
            if os.path.exists(p):
                return p

    return None


def run_cmd(cmd_list, capture_output=True, check=True, text=True):
    """Execute a subprocess command cleanly."""
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
            print(f"[Error Output]: {e.stderr.strip()}")
        raise e


def check_prerequisites():
    print_step("Step 1: Checking Prerequisites")

    # 1. Python version
    if sys.version_info < (3, 8):
        print(f"[ERROR] Python 3.8+ is required. Found: {sys.version}")
        sys.exit(1)
    print(f"[OK] Python {sys.version.split()[0]} detected.")

    # 2. Local signaling server files
    script_dir = Path(__file__).resolve().parent
    server_files = [script_dir / name for name in SERVER_FILES]
    missing = [f.name for f in [*server_files, script_dir / SERVICE_FILE] if not f.exists()]
    if missing:
        print(f"[ERROR] Missing server files in {script_dir}: {', '.join(missing)}")
        sys.exit(1)
    print(f"[OK] Local server files found: {', '.join(SERVER_FILES)}")

    # 3. Check Google Cloud CLI (gcloud)
    gcloud_bin = find_gcloud()
    while not gcloud_bin:
        print("\n[!] Google Cloud CLI ('gcloud') is NOT installed or not in PATH.")
        print("The Google Cloud SDK is required to provision and manage your instance.")
        print("\nOptions:")
        if sys.platform == "win32":
            print("  1) Download and run Google Cloud SDK Installer for Windows")
        print("  2) Open Google Cloud SDK installation docs in browser")
        print("  3) Re-check PATH (if you just finished installing)")
        print("  4) Exit")

        choice = input("\nEnter choice [1-4]: ").strip()
        if choice == "1" and sys.platform == "win32":
            installer_url = "https://dl.google.com/dl/cloudsdk/channels/rapid/GoogleCloudSDKInstaller.exe"
            installer_path = Path(os.environ.get("TEMP", ".")) / "GoogleCloudSDKInstaller.exe"
            print(f"Downloading installer to {installer_path}...")
            urllib.request.urlretrieve(installer_url, str(installer_path))
            print("Launching installer... Please complete the installation wizard.")
            subprocess.run([str(installer_path)])
            input("Press Enter when installation completes to continue...")
        elif choice == "2":
            webbrowser.open("https://cloud.google.com/sdk/docs/install")
            input("Press Enter after installing gcloud to continue...")
        elif choice == "3":
            pass
        elif choice == "4":
            print("Exiting.")
            sys.exit(0)

        gcloud_bin = find_gcloud()

    print(f"[OK] Google Cloud CLI found at: {gcloud_bin}")
    return gcloud_bin, server_files


def authenticate_gcp(gcloud):
    print_step("Step 2: Google Cloud Authentication")

    # Check for active authenticated account
    res = run_cmd([gcloud, "auth", "list", "--filter=status:ACTIVE", "--format=value(account)"], check=False)
    active_account = res.stdout.strip() if res.returncode == 0 else ""

    if active_account:
        print(f"Active account found: {active_account}")
        use_current = input(f"Proceed with account '{active_account}'? [Y/n]: ").strip().lower()
        if use_current in ("", "y", "yes"):
            return active_account

    print("\nRequesting Google Cloud login...")
    print("A browser window will open for you to log in to your Google Cloud account.")
    run_cmd([gcloud, "auth", "login"], capture_output=False)

    res = run_cmd([gcloud, "auth", "list", "--filter=status:ACTIVE", "--format=value(account)"])
    account = res.stdout.strip()
    print(f"[OK] Successfully authenticated as: {account}")
    return account


def select_or_create_project(gcloud):
    print_step("Step 3: GCP Project Selection")

    # Current configured project
    current_proj_res = run_cmd([gcloud, "config", "get-value", "project"], check=False)
    current_proj = current_proj_res.stdout.strip() if current_proj_res.returncode == 0 else ""

    if current_proj and current_proj != "(unset)":
        print(f"Current configured project: {current_proj}", flush=True)
        use_current = input(f"Use current project '{current_proj}'? [Y/n]: ").strip().lower()
        if use_current in ("", "y", "yes"):
            selected_project = current_proj
        else:
            selected_project = None
    else:
        selected_project = None

    if not selected_project:
        print("Querying Google Cloud for available projects...", flush=True)
        res = run_cmd([gcloud, "projects", "list", "--format=json"])
        projects = json.loads(res.stdout or "[]")

        if projects:
            print("\nAvailable Google Cloud Projects:", flush=True)
            for idx, p in enumerate(projects, 1):
                is_curr = " (current)" if p["projectId"] == current_proj else ""
                print(f"  {idx}) {p.get('name', p['projectId'])} [{p['projectId']}]{is_curr}")
            print(f"  {len(projects) + 1}) Enter a custom or new Project ID", flush=True)

            while not selected_project:
                choice = input(f"\nSelect a project [1-{len(projects) + 1}]: ").strip()
                if choice.isdigit():
                    val = int(choice)
                    if 1 <= val <= len(projects):
                        selected_project = projects[val - 1]["projectId"]
                    elif val == len(projects) + 1:
                        selected_project = input("Enter Project ID: ").strip()
                elif choice:
                    selected_project = choice
        else:
            print("No existing projects found in this account.", flush=True)
            selected_project = input("Enter your GCP Project ID to use: ").strip()

    if not selected_project:
        print("[ERROR] No project selected. Exiting.", flush=True)
        sys.exit(1)

    print(f"\nSetting active project to: {selected_project}", flush=True)
    run_cmd([gcloud, "config", "set", "project", selected_project])

    # Enable Compute Engine API
    print("Checking Compute Engine API status...", flush=True)
    services_res = run_cmd([gcloud, "services", "list", "--enabled", "--filter=name:compute.googleapis.com", "--format=value(name)"])
    if "compute.googleapis.com" not in services_res.stdout:
        print("Enabling Compute Engine API (this can take 30-60 seconds)...", flush=True)
        run_cmd([gcloud, "services", "enable", "compute.googleapis.com"], capture_output=False)
        print("[OK] Compute Engine API enabled.", flush=True)
    else:
        print("[OK] Compute Engine API is already enabled.", flush=True)

    return selected_project


def choose_region_and_zone():
    print_step("Step 4: Select Always Free Tier Region & Zone")
    print("GCP Always Free provides 1 free 'e2-micro' VM instance in these US regions:")
    for k, (_, _, label) in FREE_REGIONS.items():
        print(f"  {k}) {label}")

    choice = input("\nSelect Region [1-3, default: 1]: ").strip() or "1"
    _, zone, desc = FREE_REGIONS.get(choice, FREE_REGIONS["1"])
    print(f"[OK] Selected: {desc} (Zone: {zone})")
    return zone


def ensure_firewall(gcloud):
    print_step("Step 5: Verifying Firewall Rules")
    print(f"Checking for firewall rule '{FIREWALL_RULE_NAME}'...")

    res = run_cmd([gcloud, "compute", "firewall-rules", "describe", FIREWALL_RULE_NAME], check=False)
    if res.returncode == 0:
        # Older deploys also opened 8080 (Node directly, without TLS): close it
        run_cmd([gcloud, "compute", "firewall-rules", "update", FIREWALL_RULE_NAME, f"--allow={PUBLIC_PORTS}"], capture_output=False)
        print(f"[OK] Firewall rule '{FIREWALL_RULE_NAME}' allows only {PUBLIC_PORTS} (Caddy).")
        return

    print("Creating firewall rule allowing ports 80, 443 and 8443 (Caddy)...")
    for attempt in range(1, 4):
        try:
            run_cmd([
                gcloud, "compute", "firewall-rules", "create", FIREWALL_RULE_NAME,
                "--network=default",
                f"--allow={PUBLIC_PORTS}",
                f"--target-tags={FIREWALL_TAG}",
                "--source-ranges=0.0.0.0/0",
                "--description=Allow incoming traffic for WebRTC signaling server"
            ], capture_output=False)
            print(f"[OK] Firewall rule '{FIREWALL_RULE_NAME}' created.")
            return
        except subprocess.CalledProcessError:
            # Check if created despite transient error
            check_again = run_cmd([gcloud, "compute", "firewall-rules", "describe", FIREWALL_RULE_NAME], check=False)
            if check_again.returncode == 0:
                print(f"[OK] Firewall rule '{FIREWALL_RULE_NAME}' exists.")
                return
            if attempt < 3:
                print(f"[!] GCP returned a transient error. Retrying firewall creation in 5 seconds (attempt {attempt}/3)...")
                time.sleep(5)
            else:
                raise



def build_startup_script(server_files):
    """Embed the server files into a cloud-init startup script with Node.js & Caddy TLS."""
    unpack_lines = []
    for path in server_files:
        with open(path, "r", encoding="utf-8") as f:
            b64 = base64.b64encode(f.read().encode("utf-8")).decode("utf-8")
        unpack_lines.append(f'echo "{b64}" | base64 -d > {path.name}')
    unpack = "\n".join(unpack_lines)
    service_path = Path(server_files[0]).parent / SERVICE_FILE
    service_b64 = base64.b64encode(service_path.read_bytes()).decode("utf-8")

    script = f"""#!/bin/bash
set -e

exec > >(tee -a /var/log/startup-script.log) 2>&1
echo "[Startup] Starting WebRTC Signaling Server initialization..."

# 1. Setup 2GB Swap file (critical for smooth operation on 1GB RAM e2-micro)
if [ ! -f /swapfile ]; then
    echo "[Swap] Setting up 2GB swap..."
    fallocate -l 2G /swapfile || dd if=/dev/zero of=/swapfile bs=1M count=2048
    chmod 600 /swapfile
    mkswap /swapfile
    swapon /swapfile
    echo '/swapfile none swap sw 0 0' >> /etc/fstab
fi

# 2. Install Node.js 20 & Caddy
echo "[Deps] Installing prerequisites..."
apt-get update -y
apt-get install -y curl ca-certificates gnupg debian-keyring debian-archive-keyring apt-transport-https

# Install Node.js 20.x
echo "[Node] Installing Node.js 20..."
mkdir -p /etc/apt/keyrings
curl -fsSL https://deb.nodesource.com/gpgkey/nodesource-repo.gpg.key | gpg --dearmor -o /etc/apt/keyrings/nodesource.gpg
echo "deb [signed-by=/etc/apt/keyrings/nodesource.gpg] https://deb.nodesource.com/node_20.x nodistro main" | tee /etc/apt/sources.list.d/nodesource.list
apt-get update -y
apt-get install -y nodejs

# Install Caddy
echo "[Caddy] Installing Caddy reverse proxy for automated TLS..."
curl -1sLf 'https://dl.cloudsmith.io/public/caddy/stable/gpg.key' | gpg --dearmor -o /usr/share/keyrings/caddy-stable-archive-keyring.gpg
curl -1sLf 'https://dl.cloudsmith.io/public/caddy/stable/debian.deb.txt' | tee /etc/apt/sources.list.d/caddy-stable.list
apt-get update -y
apt-get install -y caddy

# 3. Create app directory and unpack code
echo "[App] Writing application code..."
mkdir -p /opt/webrtc-server
cd /opt/webrtc-server

{unpack}

echo "[App] Installing npm dependencies..."
npm install --omit=dev

# 4. The service runs as its own unprivileged user, which owns the app folder
id -u {SERVICE_USER} >/dev/null 2>&1 || useradd --system --no-create-home --shell /usr/sbin/nologin {SERVICE_USER}
chown -R {SERVICE_USER}:{SERVICE_USER} /opt/webrtc-server

echo "[Systemd] Installing webrtc-signaling service..."
echo "{service_b64}" | base64 -d > /etc/systemd/system/webrtc-signaling.service

systemctl daemon-reload
systemctl enable webrtc-signaling
systemctl restart webrtc-signaling

# 5. Fetch external IP and configure Caddy
EXTERNAL_IP=$(curl -s -H "Metadata-Flavor: Google" http://metadata.google.internal/computeMetadata/v1/instance/network-interfaces/0/access-configs/0/external-ip)
DOMAIN="${{EXTERNAL_IP}}.sslip.io"

echo "[TLS] Configuring Caddy for domain: ${{DOMAIN}}"
cat <<EOF > /etc/caddy/Caddyfile
{{
    admin off
}}

# Automated Let's Encrypt TLS on standard HTTPS/WSS (443) and 8443 for gcp.3rtc.me, signal.3rtc.me, and sslip.io.
{SIGNAL_DOMAIN}:443, {SIGNAL_DOMAIN}:8443, signal.3rtc.me:443, signal.3rtc.me:8443, ${{DOMAIN}}:443, ${{DOMAIN}}:8443 {{
    reverse_proxy 127.0.0.1:8080
}}

# Automatically redirect all plain HTTP requests on port 80 to HTTPS while supporting health checks
:80 {{
    @health path /healthz /status
    handle @health {{
        respond "WebRTC Signaling Server Ready at wss://${{DOMAIN}}:443" 200
    }}
    handle {{
        redir https://{{host}}{{uri}} permanent
    }}
}}
EOF

systemctl restart caddy
echo "[Done] WebRTC Signaling Server initialization finished successfully!"
"""
    return script


def deploy_vm(gcloud, zone, server_files):
    print_step("Step 6: Deploying Forever Free e2-micro Instance")

    # Detect existing instances in the zone
    inst_list_res = run_cmd([gcloud, "compute", "instances", "list", f"--zones={zone}", "--format=value(name)"], check=False)
    existing_instances = [name.strip() for name in inst_list_res.stdout.splitlines() if name.strip()]
    default_name = existing_instances[0] if existing_instances else DEFAULT_INSTANCE_NAME

    instance_name = input(f"Enter instance name [default: {default_name}]: ").strip() or default_name

    # Check if instance already exists
    res = run_cmd([gcloud, "compute", "instances", "describe", instance_name, f"--zone={zone}"], check=False)
    if res.returncode == 0:
        ip_res = run_cmd([
            gcloud, "compute", "instances", "describe", instance_name,
            f"--zone={zone}",
            "--format=value(networkInterfaces[0].accessConfigs[0].natIP)"
        ])
        external_ip = ip_res.stdout.strip()

        print(f"\n[!] Instance '{instance_name}' already exists in zone '{zone}' (IP: {external_ip}).")
        print("  1) Update code on running instance (hot-update server.js and restart service) [Recommended]")
        print("  2) Just fetch existing wss:// URL without updating code")
        print("  3) Delete existing instance and recreate from scratch")
        print("  4) Cancel")
        c = input("Choose option [1-4, default: 1]: ").strip() or "1"
        if c == "1":
            print(f"\nUploading latest server files to '{instance_name}'...")
            run_cmd([
                gcloud, "compute", "ssh", instance_name, f"--zone={zone}",
                '--command=mkdir -p "$HOME/staging_3rtc" && chmod 700 "$HOME/staging_3rtc"',
                "--quiet"
            ], capture_output=False)
            run_cmd([
                gcloud, "compute", "scp", *[str(f) for f in server_files], str(Path(server_files[0]).parent / SERVICE_FILE), f"{instance_name}:staging_3rtc/",
                f"--zone={zone}", "--quiet"
            ], capture_output=False)
            print("Restarting webrtc-signaling service...")
            run_cmd([
                gcloud, "compute", "ssh", instance_name, f"--zone={zone}",
                f"--command={update_command(server_files)}",
                "--quiet"
            ], capture_output=False)
            print("[OK] Server updated and restarted successfully!")
            return instance_name, external_ip
        elif c == "2":
            return instance_name, external_ip
        elif c == "3":
            print(f"Deleting existing instance '{instance_name}'...")
            run_cmd([gcloud, "compute", "instances", "delete", instance_name, f"--zone={zone}", "--quiet"], capture_output=False)
        else:
            print("Cancelled.")
            sys.exit(0)

    # Generate startup script
    startup_script = build_startup_script(server_files)
    temp_script_path = Path(__file__).resolve().parent / "_startup_script.sh"
    with open(temp_script_path, "w", encoding="utf-8", newline="\n") as f:
        f.write(startup_script)

    print("\nCreating VM with GCP Always Free specs:")
    print(" - Machine Type: e2-micro (2 vCPUs, 1 GB RAM)")
    print(" - Boot Disk: 30 GB pd-standard (Standard Persistent Disk)")
    print(f" - Zone: {zone}")
    print(f" - Tags: {FIREWALL_TAG}, http-server, https-server")

    try:
        run_cmd([
            gcloud, "compute", "instances", "create", instance_name,
            f"--zone={zone}",
            "--network=default",
            "--machine-type=e2-micro",
            "--boot-disk-size=30GB",
            "--boot-disk-type=pd-standard",
            "--image-family=debian-12",
            "--image-project=debian-cloud",
            f"--tags={FIREWALL_TAG},http-server,https-server",
            f"--metadata-from-file=startup-script={temp_script_path}",
            "--description=Always Free WebRTC Signaling Server"
        ], capture_output=False)
    finally:
        if temp_script_path.exists():
            temp_script_path.unlink()

    # Get External IP
    ip_res = run_cmd([
        gcloud, "compute", "instances", "describe", instance_name,
        f"--zone={zone}",
        "--format=value(networkInterfaces[0].accessConfigs[0].natIP)"
    ])
    external_ip = ip_res.stdout.strip()
    print(f"\n[OK] Instance created! External IP: {external_ip}")
    return instance_name, external_ip


def wait_for_ready(external_ip):
    print_step("Step 7: Verifying Deployment & Obtaining wss:// URL")
    domain = f"{external_ip}.sslip.io"
    http_url = f"http://{external_ip}"
    wss_url = f"wss://{domain}:{DEFAULT_PORT}"
    wss_alt = f"wss://{domain}:{ALT_PORT}"

    print(f"Server domain: {domain}")
    print("Waiting for instance startup script, Node.js installation, and TLS provisioning...")
    print("(This typically takes ~90-120 seconds on a fresh e2-micro instance)")

    max_retries = 36  # ~3 minutes
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
        print(f"  [{i * 5}s] Initializing packages and SSL cert...", end="\r", flush=True)

    print()
    if ready:
        print("[OK] Signaling server and TLS reverse proxy are LIVE!")
    else:
        print("[Notice] Instance is still running startup script. URLs will be live shortly.")

    print("\n" + "=" * 60)
    print(" WebRTC Signaling Server Deployed Successfully (Always Free)")
    print("=" * 60)
    print(f"\n Secure WebSocket (WSS) URLs with Port:\n")
    print(f"  App URL (DNS)   : wss://{SIGNAL_DOMAIN}  (A record {SIGNAL_DOMAIN} -> {external_ip})")
    print(f"  Primary WSS URL : {wss_url}")
    print(f"  Alternative WSS : {wss_alt}")
    print("\n" + "-" * 60)
    print("Details:")
    print(f"  External IP  : {external_ip}")
    print(f"  SSL Domain   : {domain} (Valid Let's Encrypt Certificate)")
    print("  Tier         : Google Cloud Always Free (e2-micro, 30GB pd-standard)")
    print("=" * 60 + "\n")


def get_existing_gcp_youtube_key(gcloud, zone, instance_name):
    try:
        res = subprocess.run([
            gcloud, "compute", "ssh", instance_name, f"--zone={zone}",
            "--command=sudo cat /opt/webrtc-server/.youtube-api-key 2>/dev/null || true",
            "--quiet"
        ], capture_output=True, text=True, check=False)
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


def configure_quick_picks(gcloud, zone, instance_name):
    """Upload the YouTube Data API key that powers the quick-pick videos (optional).

    The server searches YouTube a few times a day and caches the result for every client, so the
    key is only ever used on the server. It is stored in /opt/webrtc-server/.youtube-api-key,
    readable only by the service's own user, and never embedded in instance metadata or sent to browsers.
    """
    print_step("Step 8: YouTube Quick Picks (optional)")
    print("Quick picks can be filled from live YouTube searches instead of the built-in list.")
    print("This needs a YouTube Data API v3 key: https://console.cloud.google.com/apis/credentials")
    print("(Enable 'YouTube Data API v3' for the project, create an API key, and restrict it to that API.)")

    existing_key = get_existing_gcp_youtube_key(gcloud, zone, instance_name)
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
                gcloud, "compute", "ssh", instance_name, f"--zone={zone}",
                "--command=sudo test -f /opt/webrtc-server/.youtube-api-key && echo 'EXISTS' || true",
                "--quiet"
            ], capture_output=True, text=True, check=False)
            if "EXISTS" in (check_remote.stdout or ""):
                return
            key_to_upload = existing_key
        else:
            print("Skipped. Quick picks keep their current source.")
            return
    else:
        key_to_upload = new_key
        try:
            local_key_file = Path(__file__).resolve().parent / ".youtube-api-key"
            local_key_file.write_text(key_to_upload + "\n", encoding="utf-8")
        except Exception:
            pass

    fd, local_path = tempfile.mkstemp(prefix="yt-key-")
    try:
        with os.fdopen(fd, "w", encoding="utf-8") as f:
            f.write(key_to_upload + "\n")
        os.chmod(local_path, 0o600)
        run_cmd([
            gcloud, "compute", "ssh", instance_name, f"--zone={zone}",
            '--command=mkdir -p "$HOME/staging_3rtc" && chmod 700 "$HOME/staging_3rtc"',
            "--quiet"
        ], capture_output=False)
        run_cmd([
            gcloud, "compute", "scp", local_path, f"{instance_name}:staging_3rtc/.youtube-api-key",
            f"--zone={zone}", "--quiet"
        ], capture_output=False)
    finally:
        os.remove(local_path)
    run_cmd([
        gcloud, "compute", "ssh", instance_name, f"--zone={zone}",
        f"--command=STAGING_DIR=\"$HOME/staging_3rtc\" && sudo install -m 600 -o {SERVICE_USER} -g {SERVICE_USER} \"$STAGING_DIR/.youtube-api-key\" /opt/webrtc-server/.youtube-api-key"
        ' && rm -f "$STAGING_DIR/.youtube-api-key" && sudo rm -f /opt/webrtc-server/quick-picks-cache.json'
        " && sudo systemctl restart webrtc-signaling",
        "--quiet"
    ], capture_output=False)
    print("[OK] Key saved on the server. Quick picks refresh now, then about every 3.5 hours.")


def local_signal_secret():
    """The signing secret every 3RTC signaling server must share (see seats.js), so a room keeps
    working when people move between servers (the app falls back from Oracle to GCP). Taken from
    SIGNAL_SECRET, else server/.signal-secret next to this script (made once, git-ignored). The
    Oracle deploy script uploads the same file."""
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
    print(f"[OK] Made a shared signing secret in {secret_file}. Keep this file: the Oracle deploy uses it too.")
    return secret


def sync_signal_secret(gcloud, zone, instance_name):
    """Install the shared signing secret as /opt/webrtc-server/.signal-secret (only if it differs)."""
    print_step("Step 7b: Shared signing secret (Oracle and GCP must match)")
    secret = local_signal_secret()
    want = hashlib.sha256(secret.encode("utf-8")).hexdigest()
    res = subprocess.run([
        gcloud, "compute", "ssh", instance_name, f"--zone={zone}",
        "--command=sudo cat /opt/webrtc-server/.signal-secret 2>/dev/null | tr -d '[:space:]' | sha256sum | cut -c1-64",
        "--quiet"
    ], capture_output=True, text=True, check=False)
    if (res.stdout or "").strip() == want:
        print("[OK] The server already uses the shared signing secret.")
        return
    fd, local_path = tempfile.mkstemp(prefix="signal-secret-")
    try:
        with os.fdopen(fd, "w", encoding="utf-8") as f:
            f.write(secret + "\n")
        os.chmod(local_path, 0o600)
        run_cmd([
            gcloud, "compute", "ssh", instance_name, f"--zone={zone}",
            '--command=mkdir -p "$HOME/staging_3rtc" && chmod 700 "$HOME/staging_3rtc"',
            "--quiet"
        ], capture_output=False)
        run_cmd([
            gcloud, "compute", "scp", local_path, f"{instance_name}:staging_3rtc/.signal-secret",
            f"--zone={zone}", "--quiet"
        ], capture_output=False)
    finally:
        os.remove(local_path)
    run_cmd([
        gcloud, "compute", "ssh", instance_name, f"--zone={zone}",
        f"--command=STAGING_DIR=\"$HOME/staging_3rtc\" && sudo install -m 600 -o {SERVICE_USER} -g {SERVICE_USER} \"$STAGING_DIR/.signal-secret\" /opt/webrtc-server/.signal-secret"
        ' && rm -f "$STAGING_DIR/.signal-secret" && sudo systemctl restart webrtc-signaling',
        "--quiet"
    ], capture_output=False)
    print("[OK] Shared signing secret installed; the service restarted.")


def main():
    print("""
============================================================
 WebRTC Signaling Server - GCP Always Free Tier Deployer
============================================================
""")
    gcloud, server_files = check_prerequisites()
    authenticate_gcp(gcloud)
    select_or_create_project(gcloud)
    zone = choose_region_and_zone()
    ensure_firewall(gcloud)
    instance_name, external_ip = deploy_vm(gcloud, zone, server_files)
    wait_for_ready(external_ip)
    sync_signal_secret(gcloud, zone, instance_name)
    configure_quick_picks(gcloud, zone, instance_name)


if __name__ == "__main__":
    try:
        main()
    except KeyboardInterrupt:
        print("\nDeployment cancelled by user.")
        sys.exit(0)
