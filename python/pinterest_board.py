"""List the picture addresses on one public Pinterest board. Downloads nothing.

    python pinterest_board.py <board URL> <most pictures> <seconds>

Prints one JSON object on stdout and always exits 0 (the website reads the JSON, not the exit code):
    {"ok": true, "images": ["https://i.pinimg.com/...", ...]}
    {"ok": false, "reason": "not-found" | "blocked" | "empty" | "timeout" | "not-installed" | "failed"}

The website (server/lib/pinterestImport.js) has already checked that the address is a Pinterest board; this file asks gallery-dl for
the pictures' addresses only (-g prints them instead of downloading) and does not look at anything else.
"""
import json
import re
import subprocess
import sys

ADDRESS = re.compile(r"https://\S+")


def say(**fields):
    print(json.dumps(fields))
    return 0


def reason_for(text):
    """A coarse reason from gallery-dl's own message; the website words it for people."""
    low = text.lower()
    if "404" in low or "not found" in low or "does not exist" in low:
        return "not-found"
    if "403" in low or "401" in low or "429" in low or "login" in low or "authentication" in low or "forbidden" in low:
        return "blocked"
    return "failed"


def main(argv):
    if len(argv) != 4:
        return say(ok=False, reason="failed")
    url, most, seconds = argv[1], int(argv[2]), int(argv[3])
    # --config-ignore: never read a gallery-dl config from the server's home folder; --range: stop after the first pictures
    command = [sys.executable, "-s", "-m", "gallery_dl", "--config-ignore", "-g", "--range", f"1-{most}", url]
    try:
        done = subprocess.run(command, capture_output=True, text=True, timeout=seconds)
    except subprocess.TimeoutExpired:
        return say(ok=False, reason="timeout")
    if done.returncode != 0 and "No module named gallery_dl" in done.stderr:
        return say(ok=False, reason="not-installed")
    images = []
    for line in done.stdout.splitlines():
        found = ADDRESS.search(line)
        if found and found.group(0) not in images:
            images.append(found.group(0))
    if images:
        return say(ok=True, images=images[:most])
    return say(ok=False, reason=reason_for(done.stderr) if done.returncode != 0 else "empty")


if __name__ == "__main__":
    sys.exit(main(sys.argv))
