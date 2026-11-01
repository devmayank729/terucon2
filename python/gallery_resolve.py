"""Ask gallery-dl which pictures an address holds. Downloads nothing.

    python gallery_resolve.py '<request as one JSON object>'
    python gallery_resolve.py --find <address>

The request (written by server/lib/inspiration/gallery.js, from the site registry in site/inspiration/sources.js):
    {"url": "https://www.pinterest.com/pin/123/",       the canonical address
     "allow": ["pinterest:pin", ...],                    the only extractors that may run for it ("category:subcategory")
     "follow": ["pinterest:pin", "pinterest:board"],     a short link only: the extractors of the one address it may lead to
     "options": {"videos": false, ...},                  gallery-dl options for this site (gallery-dl.conf: extractor > <site>)
     "thumbs": "pinterest",                              how to find a small picture for the chooser (THUMBS below), or null
     "limit": 40, "seconds": 50}

Prints one JSON object on stdout and always exits 0 (the website reads the JSON, not the exit code):
    {"ok": true, "extractor": "pinterest:board", "title": "Kitchen ideas",
     "items": [{"url": "https://i.pinimg.com/originals/..jpg", "width": 1080, "height": 1620, "title": "...", "thumb": "https://..."}, ...]}
    {"ok": false, "reason": "unsupported" | "not-found" | "private" | "blocked" | "empty" | "timeout" | "not-installed" | "failed"}
`--find` prints {"extractor": "category:subcategory"} or {"extractor": null}, from gallery-dl's address patterns alone (no network).

What this file guarantees, and why:
  * only an extractor named in "allow" ever runs. gallery-dl also has extractors that fetch whatever address they are given (a direct
    link, a generic page, a video downloader); asking `extractor.find` first and refusing everything else keeps it to the site the
    registry meant;
  * `-j` (dump the metadata) is used, never a download: no file is written, and the program reads the picture's address, size and
    title from gallery-dl's own answer instead of guessing from the address;
  * only http(s) addresses of picture files come back. gallery-dl also reports story text ("text:..."), video playlists
    ("ytdl:...") and audio, which are dropped;
  * its own configuration files and cache are never read or written (--config-ignore, cache off), and it runs with the clean environment
    the website gives it.
"""
import json
import os
import re
import subprocess
import sys
import tempfile
from urllib.parse import urlsplit

PICTURES = {"jpg", "jpeg", "png", "webp", "gif", "avif"}
ADDRESS = re.compile(r"^https?://", re.I)
MAX_ITEMS = 100
MAX_QUEUE_HOPS = 1  # a short link (pin.it) names the real address; follow it once, and only to an extractor the request lists in "follow"


def say(**fields):
    print(json.dumps(fields, ensure_ascii=False))
    return 0


def extension_of(url, meta):
    ext = str(meta.get("extension") or "").lower().lstrip(".")
    if not ext:
        ext = os.path.splitext(urlsplit(url).path)[1].lower().lstrip(".")
    return ext


def number(meta, *names):
    for name in names:
        value = meta.get(name)
        if isinstance(value, bool):
            continue
        if isinstance(value, (int, float)) and value > 0:
            return int(value)
        if isinstance(value, str) and value.isdigit() and int(value) > 0:
            return int(value)
    return None


def clean(text, limit=140):
    text = re.sub(r"[\x00-\x1f\x7f]+", " ", str(text))
    return re.sub(r"\s+", " ", text).strip()[:limit]


def title_of(meta):
    for key in ("title", "description", "caption", "alt", "name"):
        value = meta.get(key)
        if isinstance(value, str) and clean(value):
            return clean(value)
    return ""


# ---- small pictures for the chooser. Each takes (url, metadata) and returns an address or None. Only what the site is known to give.
def thumb_pinterest(url, meta):
    images = meta.get("images")
    if isinstance(images, dict):
        for key in ("474x", "236x", "237x", "170x"):
            entry = images.get(key)
            if isinstance(entry, dict) and isinstance(entry.get("url"), str):
                return entry["url"]
    return None


def thumb_unsplash(url, meta):
    urls = meta.get("urls")
    if isinstance(urls, dict) and isinstance(urls.get("small"), str):
        return urls["small"]
    return None


def thumb_imgur(url, meta):
    # imgur serves a medium thumbnail when "m" is put before the file ending: i.imgur.com/AbCdEfG.jpg -> AbCdEfGm.jpg
    match = re.match(r"^(https://i\.imgur\.com/[A-Za-z0-9]{7})(\.\w+)$", url)
    return match.group(1) + "m" + match.group(2) if match else None


def thumb_pexels(url, meta):
    if urlsplit(url).hostname == "images.pexels.com":
        return url.split("?")[0] + "?auto=compress&cs=tinysrgb&w=400"
    return None


THUMBS = {"pinterest": thumb_pinterest, "unsplash": thumb_unsplash, "imgur": thumb_imgur, "pexels": thumb_pexels}


def reason_for(text):
    """A coarse reason from gallery-dl's own message; the website words it for people."""
    low = text.lower()
    if "notfounderror" in low or "404" in low or "not found" in low or "does not exist" in low:
        return "not-found"
    if "authenticationerror" in low or "authorizationerror" in low or "login" in low or "log in" in low or "sign in" in low or "401" in low or "private" in low or "cookies" in low:
        return "private"
    if "403" in low or "429" in low or "forbidden" in low or ("rate" in low and "limit" in low) or "captcha" in low or "too many" in low:
        return "blocked"
    return "failed"


def run_gallery(url, options, category, limit, seconds, config_dir):
    config = {
        "extractor": {"retries": 2, "timeout": 20.0, category: options},
        "downloader": {"retries": 1, "timeout": 20.0},
        "cache": {"file": None},
    }
    path = os.path.join(config_dir, "gallery-dl.json")
    with open(path, "w", encoding="utf-8") as handle:
        json.dump(config, handle)
    command = [sys.executable, "-s", "-m", "gallery_dl", "--config-ignore", "-c", path, "-j", "--range", f"1-{limit}", url]
    return subprocess.run(command, capture_output=True, text=True, timeout=seconds)


def read_messages(stdout):
    """gallery-dl -j prints one JSON list of [type, ...] messages: 2 = a folder (its metadata), 3 = a file, 6 = another address to follow."""
    try:
        data = json.loads(stdout)
    except ValueError:
        return None
    return data if isinstance(data, list) else None


def folder_title(folder):
    """The name of the board / album / project the pictures are in, if gallery-dl says one."""
    for key, inner in (("board", "name"), ("album", "title")):
        value = folder.get(key)
        if isinstance(value, dict) and clean(value.get(inner, "")):
            return clean(value[inner])
    return clean(folder.get("title", "") or "")


def items_from(messages, thumbs, limit):
    title, items, seen, queue = "", [], set(), []
    for message in messages:
        if not isinstance(message, list) or not message:
            continue
        kind = message[0]
        if kind == 2 and len(message) >= 2 and isinstance(message[1], dict) and not title:
            title = folder_title(message[1])
        elif kind == 6 and len(message) >= 2 and isinstance(message[1], str):
            queue.append(message[1])
        elif kind == 3 and len(message) >= 3 and isinstance(message[1], str) and isinstance(message[2], dict):
            url, meta = message[1], message[2]
            if not ADDRESS.match(url) or extension_of(url, meta) not in PICTURES or url in seen:
                continue
            seen.add(url)
            item = {"url": url, "width": number(meta, "width"), "height": number(meta, "height"), "title": title_of(meta)}
            make_thumb = THUMBS.get(thumbs)
            thumb = make_thumb(url, meta) if make_thumb else None
            if thumb and ADDRESS.match(thumb):
                item["thumb"] = thumb
            items.append(item)
            if len(items) >= limit:
                break
    return title, items, queue


def resolve(request):
    from gallery_dl import extractor  # noqa: E402  (imported here so a missing install is reported, not raised)

    url, allow = request["url"], set(request["allow"])
    follow = set(request.get("follow") or [])
    options = request.get("options") or {}
    thumbs = request.get("thumbs")
    limit = max(1, min(int(request.get("limit", 40)), MAX_ITEMS))
    seconds = max(5, min(int(request.get("seconds", 50)), 170))
    hops = 0
    allowed = allow  # what may run now: the request's `allow`, and after a short link's hop only `follow`
    with tempfile.TemporaryDirectory(prefix="terucon-gdl-") as config_dir:
        while True:
            found = extractor.find(url)
            key = f"{found.category}:{found.subcategory}" if found else None
            if key not in allowed:
                return say(ok=False, reason="unsupported", extractor=key)
            try:
                done = run_gallery(url, options, found.category, limit, seconds, config_dir)
            except subprocess.TimeoutExpired:
                return say(ok=False, reason="timeout")
            messages = read_messages(done.stdout)
            if messages is None:
                return say(ok=False, reason=reason_for(done.stderr) if done.returncode else "empty")
            title, items, queue = items_from(messages, thumbs, limit)
            if items:
                return say(ok=True, extractor=key, title=title, items=items)
            if queue and hops < MAX_QUEUE_HOPS:
                url, hops, allowed = queue[0], hops + 1, follow
                continue
            return say(ok=False, reason=reason_for(done.stderr) if done.returncode else "empty", extractor=key)


def main(argv):
    try:
        import gallery_dl  # noqa: F401
    except ImportError:
        return say(ok=False, reason="not-installed")
    try:
        if len(argv) == 3 and argv[1] == "--find":
            from gallery_dl import extractor

            found = extractor.find(argv[2])
            return say(extractor=f"{found.category}:{found.subcategory}" if found else None)
        if len(argv) != 2:
            return say(ok=False, reason="failed")
        request = json.loads(argv[1])
        if not isinstance(request, dict) or not isinstance(request.get("url"), str) or not isinstance(request.get("allow"), list):
            return say(ok=False, reason="failed")
        return resolve(request)
    except Exception:  # whatever went wrong inside gallery-dl, the website gets a plain "failed" and no traceback
        return say(ok=False, reason="failed")


if __name__ == "__main__":
    sys.exit(main(sys.argv))
