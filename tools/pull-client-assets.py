#!/usr/bin/env python3
"""Rebuild compendium/assets/img from a local Meridian 59 client.

The compendium's 5,355 sprite PNGs are decoded from the client's own .bgf files.
They are not committed -- they are the client's art, and 40 MB of it. This script
finds a client on the machine and regenerates them, so a fresh clone becomes a
complete site without anything being redistributed.

    python tools/pull-client-assets.py              # find a client, decode everything
    python tools/pull-client-assets.py --check      # say what it found, decode nothing
    python tools/pull-client-assets.py --resource "D:/Meridian 59/resource" \
                                       --palette   "D:/Meridian59/blakston.pal"

Two things are needed and they do not always live together:

  .bgf files   the sprites. A shipped client (Steam, GOG) keeps them in
               resource/ beside Meridian.exe; a source checkout keeps them in
               run/localclient/resource/.
  blakston.pal the 256-entry palette every .bgf indexes into. This ships only
               with the source tree -- https://github.com/Meridian59/Meridian59.
               A retail client alone is not enough.

Set M59_ROOT to point at a source checkout and both are found automatically.
"""

import argparse
import os
import shutil
import subprocess
import sys

HERE = os.path.dirname(os.path.abspath(__file__))
REPO = os.path.dirname(HERE)
BGF = os.path.join(REPO, "compendium", "tools", "bgf.mjs")
OUT = os.path.join(REPO, "compendium", "assets", "img")

# Ordered guesses, best first. A source checkout wins because it carries the
# palette too.
SOURCE_TREES = [
    os.environ.get("M59_ROOT"),
    "C:/code/Meridian59",
    "C:/Meridian59",
    os.path.expanduser("~/Meridian59"),
    os.path.expanduser("~/src/Meridian59"),
    "/opt/Meridian59",
]

CLIENT_INSTALLS = [
    os.environ.get("M59_CLIENT"),
    "C:/Program Files (x86)/Steam/steamapps/common/Meridian 59",
    "C:/Program Files/Steam/steamapps/common/Meridian 59",
    "C:/Program Files (x86)/GOG Galaxy/Games/Meridian 59",
    "C:/Program Files (x86)/Meridian 59",
    "C:/Program Files/Meridian 59",
]


def count_bgf(d):
    """How many .bgf files are directly in d (0 if it is not a usable dir)."""
    if not d or not os.path.isdir(d):
        return 0
    try:
        return sum(1 for f in os.listdir(d) if f.lower().endswith(".bgf"))
    except OSError:
        return 0


def find_resource_dir():
    """First directory that actually holds .bgf files, and where it came from."""
    for root in SOURCE_TREES:
        if not root:
            continue
        cand = os.path.join(root, "run", "localclient", "resource")
        if count_bgf(cand):
            return cand, "source tree %s" % root
    for root in CLIENT_INSTALLS:
        if not root:
            continue
        for sub in ("resource", os.path.join("run", "localclient", "resource")):
            cand = os.path.join(root, sub)
            if count_bgf(cand):
                return cand, "client install %s" % root
    return None, None


def find_palette():
    """blakston.pal, which only the source tree has."""
    for root in SOURCE_TREES + CLIENT_INSTALLS:
        if not root:
            continue
        for rel in ("blakston.pal", "run/server/blakston.pal", "resource/blakston.pal"):
            cand = os.path.join(root, rel)
            if os.path.isfile(cand):
                return cand
    return None


def die(msg, *hints):
    print("error: %s" % msg, file=sys.stderr)
    for h in hints:
        print("  %s" % h, file=sys.stderr)
    return 1


def main():
    ap = argparse.ArgumentParser(description=__doc__.split("\n")[0])
    ap.add_argument("--resource", help="directory holding the client's .bgf files")
    ap.add_argument("--palette", help="path to blakston.pal")
    ap.add_argument("--check", action="store_true",
                    help="report what was found and exit without decoding")
    ap.add_argument("--force", action="store_true",
                    help="decode even if assets/img already looks populated")
    args = ap.parse_args()

    resource, why = (args.resource, "--resource") if args.resource else find_resource_dir()
    palette = args.palette or find_palette()

    n = count_bgf(resource)
    print("resource : %s" % (resource or "NOT FOUND"))
    if resource:
        print("           %d .bgf files, from %s" % (n, why))
    print("palette  : %s" % (palette or "NOT FOUND"))
    print("output   : %s" % OUT)

    if not resource or not n:
        return die(
            "no .bgf files found",
            "Install the client, or clone https://github.com/Meridian59/Meridian59",
            "then set M59_ROOT, or pass --resource <dir>.",
        )
    if not palette:
        return die(
            "blakston.pal not found",
            "The palette ships with the source tree, not with a retail client:",
            "  git clone https://github.com/Meridian59/Meridian59",
            "then set M59_ROOT to it, or pass --palette <path to blakston.pal>.",
        )

    existing = len([f for f in os.listdir(OUT) if f.endswith(".png")]) if os.path.isdir(OUT) else 0
    if existing and not args.force and not args.check:
        print("\n%d PNGs already present; re-run with --force to decode again." % existing)
        return 0

    if args.check:
        print("\nlooks runnable; drop --check to decode.")
        return 0

    node = shutil.which("node")
    if not node:
        return die("node is not on PATH", "The decoder is compendium/tools/bgf.mjs.")

    env = dict(os.environ, M59_RESOURCE=resource, M59_PALETTE=palette)
    print("\ndecoding %d files -- takes a minute or two...\n" % n)
    rc = subprocess.call([node, BGF, "all"], cwd=os.path.join(REPO, "compendium"), env=env)
    if rc != 0:
        return die("bgf.mjs exited %d" % rc)

    made = len([f for f in os.listdir(OUT) if f.endswith(".png")]) if os.path.isdir(OUT) else 0
    print("\n%d PNGs in compendium/assets/img" % made)
    print("compendium/data/images.json was rewritten to match.")
    print("Open the site with:  cd compendium && node tools/serve.mjs")
    return 0


if __name__ == "__main__":
    sys.exit(main())
