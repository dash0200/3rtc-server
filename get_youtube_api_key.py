#!/usr/bin/env python3
"""
Interactive & Automated YouTube Data API v3 Key Manager for 3RTC.
- Automatically enables YouTube Data API v3 in your Google Cloud Project.
- Automatically generates or retrieves API keys via gcloud CLI.
- Validates the API key against the live YouTube API endpoint.
- Saves the key locally to server/.youtube-api-key.
- Optionally deploys the key directly to your Oracle Cloud or GCP servers.
"""

import sys
import os
import shutil
import subprocess
import json
import urllib.request
import urllib.error
from pathlib import Path

# Force line buffering
if hasattr(sys.stdout, "reconfigure"):
    sys.stdout.reconfigure(line_buffering=True)
if hasattr(sys.stderr, "reconfigure"):
    sys.stderr.reconfigure(line_buffering=True)

SCRIPT_DIR = Path(__file__).resolve().parent
KEY_FILE = SCRIPT_DIR / ".youtube-api-key"
ORACLE_CACHE = SCRIPT_DIR / ".oracle_deploy_cache.json"


def print_step(title):
    print(f"\n{'=' * 65}")
    print(f" {title}")
    print(f"{'=' * 65}", flush=True)


def find_gcloud():
    found = shutil.which("gcloud") or (sys.platform == "win32" and shutil.which("gcloud.cmd"))
    if found:
        return found
    if sys.platform == "win32":
        local_app = os.environ.get("LOCALAPPDATA", "")
        candidates = [
            os.path.join(local_app, "Google", "Cloud SDK", "google-cloud-sdk", "bin", "gcloud.cmd"),
            os.path.join(os.environ.get("ProgramFiles(x86)", r"C:\Program Files (x86)"), "Google", "Cloud SDK", "google-cloud-sdk", "bin", "gcloud.cmd"),
            os.path.join(os.environ.get("ProgramFiles", r"C:\Program Files"), "Google", "Cloud SDK", "google-cloud-sdk", "bin", "gcloud.cmd"),
        ]
        for c in candidates:
            if os.path.isfile(c):
                return c
    return None


def run_cmd(cmd_list, capture_output=True, check=True):
    res = subprocess.run(cmd_list, capture_output=capture_output, text=True, check=check, shell=(sys.platform == "win32" and isinstance(cmd_list, str)))
    return res


def validate_youtube_key(api_key):
    """Test the key against YouTube Data API v3 mostPopular endpoint."""
    url = f"https://www.googleapis.com/youtube/v3/videos?part=snippet&chart=mostPopular&maxResults=1&key={api_key}"
    req = urllib.request.Request(url, headers={"User-Agent": "3RTC-Validator/1.0"})
    try:
        with urllib.request.urlopen(req, timeout=10) as resp:
            data = json.loads(resp.read().decode("utf-8"))
            items = data.get("items", [])
            title = items[0]["snippet"]["title"] if items else "OK"
            return True, f"Verified! Sample YouTube video: \"{title}\""
    except urllib.error.HTTPError as e:
        err_body = e.read().decode("utf-8")
        try:
            err_json = json.loads(err_body)
            msg = err_json.get("error", {}).get("message", str(e))
            return False, f"HTTP {e.code}: {msg}"
        except Exception:
            return False, f"HTTP {e.code}: {err_body[:200]}"
    except Exception as e:
        return False, str(e)


def save_key_locally(api_key):
    KEY_FILE.write_text(api_key.strip() + "\n", encoding="utf-8")
    try:
        if sys.platform != "win32":
            os.chmod(KEY_FILE, 0o600)
    except Exception:
        pass
    print(f"\n[OK] API Key saved locally to: {KEY_FILE}")


def get_key_via_gcloud(gcloud_bin):
    """Interact with Google Cloud to list, create, or modify YouTube API keys."""
    print("Checking active Google Cloud project...")
    p_res = run_cmd([gcloud_bin, "config", "get-value", "project"], check=False)
    project = p_res.stdout.strip() if p_res.returncode == 0 else ""

    if not project or project == "(unset)":
        print("[!] No Google Cloud project is currently active in gcloud.")
        print("Please run: gcloud init or gcloud config set project <PROJECT_ID>")
        return None

    print(f"[OK] Active Google Cloud Project: {project}")

    # 1. Enable YouTube Data API v3
    print("Ensuring YouTube Data API v3 is enabled...", end="", flush=True)
    en_res = run_cmd([gcloud_bin, "services", "enable", "youtube.googleapis.com", "--project", project], check=False)
    if en_res.returncode == 0:
        print(" [OK: Enabled]")
    else:
        print(" [Notice: Could not auto-enable, continuing...]")

    # 2. List existing API keys
    print("Scanning for existing API keys...", end="", flush=True)
    k_res = run_cmd([gcloud_bin, "services", "api-keys", "list", "--project", project, "--format=json"], check=False)
    keys = json.loads(k_res.stdout or "[]") if k_res.returncode == 0 else []
    print(f" [Found {len(keys)} key(s)]")

    matching_keys = []
    for k in keys:
        name = k.get("name", "")
        dname = k.get("displayName", "Unnamed Key")
        restrictions = k.get("restrictions", {})
        targets = [t.get("service") for t in restrictions.get("apiTargets", [])]
        allowed_ips = restrictions.get("serverKeyRestrictions", {}).get("allowedIps", [])

        # Check if targets youtube or unrestricted
        is_youtube = ("youtube.googleapis.com" in targets) or (not targets)
        matching_keys.append({
            "resource": name,
            "displayName": dname,
            "is_youtube": is_youtube,
            "allowed_ips": allowed_ips,
            "raw": k
        })

    if matching_keys:
        print("\nExisting Google Cloud API Keys:")
        for idx, k in enumerate(matching_keys, 1):
            ip_info = f"Allowed IPs: {', '.join(k['allowed_ips'])}" if k["allowed_ips"] else "No IP restrictions (Any server IP)"
            yt_info = "YouTube API targeted" if k["is_youtube"] else "Other API targets"
            print(f"  {idx}) {k['displayName']} [{yt_info}] - {ip_info}")

        print(f"  {len(matching_keys) + 1}) Create a brand new YouTube Data API key")
        print(f"  {len(matching_keys) + 2}) Enter key manually")

        choice = input(f"\nSelect key option [1-{len(matching_keys) + 2}, default: 1]: ").strip() or "1"
        if choice.isdigit() and 1 <= int(choice) <= len(matching_keys):
            chosen = matching_keys[int(choice) - 1]
            resource_name = chosen["resource"]

            # If it has IP restrictions, offer to clear or update
            if chosen["allowed_ips"]:
                print(f"\n[!] Note: This key is restricted to IP(s): {', '.join(chosen['allowed_ips'])}")
                print("If you run the signaling server on a different IP (like Oracle Cloud), YouTube calls from the new server will be blocked.")
                print("\nOptions for this key:")
                print("  1) Remove IP restrictions (Allow YouTube calls from any server IP) [Recommended]")
                print("  2) Keep existing IP restrictions as is")
                print("  3) Add an IP to the allowed list")
                ip_choice = input("Select option [1-3, default: 1]: ").strip() or "1"
                if ip_choice == "1":
                    print("Updating key to allow any server IP...", end="", flush=True)
                    # Updating without --allowed-ips removes the restriction
                    up_res = run_cmd([
                        gcloud_bin, "services", "api-keys", "update", resource_name,
                        "--api-target=service=youtube.googleapis.com",
                        "--no-check-existing-usage",
                        "--project", project
                    ], check=False)
                    if up_res.returncode == 0:
                        print(" [OK]")
                    else:
                        print(" [Failed to update restrictions, keeping existing]")
                elif ip_choice == "3":
                    new_ip = input("Enter new IP address to allow: ").strip()
                    if new_ip:
                        combined = list(set([*chosen["allowed_ips"], new_ip]))
                        print(f"Updating key allowed IPs to: {', '.join(combined)}...", end="", flush=True)
                        run_cmd([
                            gcloud_bin, "services", "api-keys", "update", resource_name,
                            f"--allowed-ips={','.join(combined)}",
                            "--no-check-existing-usage",
                            "--project", project
                        ], check=False)
                        print(" [OK]")

            # Get the key string
            s_res = run_cmd([gcloud_bin, "services", "api-keys", "get-key-string", resource_name, "--format=json", "--project", project], check=False)
            if s_res.returncode == 0:
                key_str = json.loads(s_res.stdout or "{}").get("keyString")
                if key_str:
                    return key_str

        elif choice == str(len(matching_keys) + 2):
            return None

    # Create new key
    print("\nCreating a new dedicated YouTube Data API key via gcloud...", end="", flush=True)
    c_res = run_cmd([
        gcloud_bin, "services", "api-keys", "create",
        "--display-name=3RTC YouTube Quick Picks",
        "--api-target=service=youtube.googleapis.com",
        "--project", project,
        "--format=json"
    ], check=False)

    if c_res.returncode == 0:
        c_data = json.loads(c_res.stdout or "{}")
        new_resource = c_data.get("name") or c_data.get("response", {}).get("name")
        print(" [Created!]")
        if new_resource:
            s_res = run_cmd([gcloud_bin, "services", "api-keys", "get-key-string", new_resource, "--format=json", "--project", project], check=False)
            if s_res.returncode == 0:
                key_str = json.loads(s_res.stdout or "{}").get("keyString")
                if key_str:
                    return key_str

    print(" [Notice: Automated creation failed. Switching to manual input.]")
    return None


def manual_key_prompt():
    """Guide the user to create a key in Google Cloud Console."""
    print("\n" + "-" * 65)
    print(" Google Cloud Console - Manual Key Setup")
    print("-" * 65)
    print("Follow these 3 quick steps in your browser:")
    print(" 1. Open Google Cloud Console Credentials page:")
    print("    https://console.cloud.google.com/apis/credentials")
    print(" 2. Click '+ CREATE CREDENTIALS' at the top -> select 'API key'.")
    print(" 3. Under 'API restrictions', select 'Restrict key' -> check 'YouTube Data API v3'.")
    print("    (Leave Application restrictions as 'None' so servers can access it).")
    print(" 4. Copy the generated API key string and paste it below.")
    print("-" * 65)
    raw = input("\nPaste your YouTube Data API key: ").strip()
    return raw


def deploy_key_to_oracle(api_key):
    """Deploy the key directly to an Oracle Cloud VM if cached or provided."""
    cache = {}
    if ORACLE_CACHE.exists():
        try:
            cache = json.loads(ORACLE_CACHE.read_text(encoding="utf-8"))
        except Exception:
            pass

    cached_host = cache.get("host", "")
    cached_user = cache.get("user", "ubuntu")
    cached_key = cache.get("key_path", "")

    print_step("Deploy API Key to Oracle Cloud Server (Optional)")
    ans = input(f"Do you want to upload this key to your Oracle Cloud server? [Y/n]: ").strip().lower()
    if ans and ans.startswith("n"):
        return

    host = input(f"Oracle VM Public IP [{cached_host}]: ").strip() or cached_host
    if not host:
        print("Skipped Oracle upload (no host IP provided).")
        return

    user = input(f"SSH Username [{cached_user}]: ").strip() or cached_user
    key_path = Path(input(f"Private Key Path [{cached_key}]: ").strip() or cached_key)

    if not key_path.exists():
        print(f"[ERROR] SSH key not found at {key_path}. Skipping remote upload.")
        return

    import tempfile
    fd, local_tmp = tempfile.mkstemp(prefix="yt-key-")
    try:
        with os.fdopen(fd, "w", encoding="utf-8") as f:
            f.write(api_key + "\n")

        print("Uploading key to Oracle VM...")
        scp_bin = shutil.which("scp") or r"C:\Windows\System32\OpenSSH\scp.exe"
        ssh_bin = shutil.which("ssh") or r"C:\Windows\System32\OpenSSH\ssh.exe"

        scp_cmd = [
            scp_bin, "-i", str(key_path),
            "-o", "StrictHostKeyChecking=no",
            "-o", "UserKnownHostsFile=/dev/null",
            local_tmp, f"{user}@{host}:/tmp/.youtube-api-key"
        ]
        run_cmd(scp_cmd)

        install_cmd = (
            "sudo install -m 600 -o webrtc -g webrtc /tmp/.youtube-api-key /opt/webrtc-server/.youtube-api-key && "
            "rm -f /tmp/.youtube-api-key && sudo rm -f /opt/webrtc-server/quick-picks-cache.json && "
            "sudo systemctl restart webrtc-signaling"
        )
        ssh_cmd = [
            ssh_bin, "-i", str(key_path),
            "-o", "StrictHostKeyChecking=no",
            "-o", "UserKnownHostsFile=/dev/null",
            f"{user}@{host}", install_cmd
        ]
        run_cmd(ssh_cmd)
        print("[SUCCESS] YouTube API key installed on Oracle server! Quick picks cache refreshed.")
    except Exception as e:
        print(f"[!] Failed to upload to Oracle server: {e}")
    finally:
        if os.path.exists(local_tmp):
            os.remove(local_tmp)


def main():
    print("""
=================================================================
       3RTC - YouTube Data API v3 Key Setup & Manager
=================================================================
This tool fetches or creates a valid YouTube Data API key
used by the signaling server to power trending YouTube Quick Picks.
""")

    api_key = None
    gcloud_bin = find_gcloud()

    if gcloud_bin:
        print(f"[OK] Google Cloud CLI (gcloud) detected: {gcloud_bin}")
        print("\nMethods to get YouTube Data API key:")
        print("  1) Automatic via Google Cloud CLI (Fetch or Create automatically) [Recommended]")
        print("  2) Manual via Google Cloud Console Web Browser")
        method = input("\nSelect method [1-2, default: 1]: ").strip() or "1"
        if method == "1":
            api_key = get_key_via_gcloud(gcloud_bin)

    if not api_key:
        api_key = manual_key_prompt()

    if not api_key:
        print("\n[ERROR] No API key provided. Exiting.")
        sys.exit(1)

    # Validate key
    print("\nValidating API key against YouTube API...", end="", flush=True)
    valid, message = validate_youtube_key(api_key)
    if valid:
        print(" [SUCCESS!]")
        print(f" {message}")
    else:
        print(" [FAILED]")
        print(f"\n[!] Validation warning: {message}")
        proceed = input("Do you still want to save this key? [y/N]: ").strip().lower()
        if not proceed.startswith("y"):
            sys.exit(1)

    # Save locally
    save_key_locally(api_key)

    # Display key
    print("\n" + "=" * 65)
    print(" YOUR YOUTUBE DATA API KEY:")
    print(f" {api_key}")
    print("=" * 65)

    # Option to deploy to Oracle
    deploy_key_to_oracle(api_key)
    print("\nSetup complete!")


if __name__ == "__main__":
    try:
        main()
    except KeyboardInterrupt:
        print("\nCancelled by user.")
        sys.exit(0)
