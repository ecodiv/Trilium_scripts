#!/usr/bin/env python3
"""
Markdown Table of Contents generator (local files only).

Just edit the CONFIG section below and run the script — no command-line args needed.
"""

import re
import sys
from pathlib import Path

# ============================================================================
# CONFIG — edit these values, then run the script
# ============================================================================

# Path to the markdown file you want a TOC for.
INPUT_FILE = "/home/paulo/dev/Trilium_weekly_planner/knowledgedebt/README.md"

# Where to write the TOC. Options:
#   None              -> print to stdout only
#   "toc.md"          -> write the TOC to this file
#   INPUT_FILE        -> insert the TOC into the file between <!--ts--> and <!--te--> markers
OUTPUT_FILE = INPUT_FILE

# Spaces per indent level in the bullet list.
INDENT = 2

# Heading levels to include. 1 = #, 2 = ##, etc. Anything outside this range is skipped.
MIN_LEVEL = 2
MAX_LEVEL = 3

# Skip the very first heading (typically the document title).
SKIP_FIRST_HEADING = False

# Collapsible sections:
#   None or 0 -> no collapsing, plain bullet list
#   N (1-6)   -> every heading at level <= N becomes a <details>/<summary> block
#                with its child headings folded inside.
# Example: COLLAPSE_LEVEL = 2 makes H1 and H2 sections collapsible.
# Renders correctly on GitHub, GitLab, VS Code preview, and most markdown viewers.
COLLAPSE_LEVEL = 0

# Whether top-level <details> blocks start open. Deeper levels always start closed.
COLLAPSE_TOP_OPEN = True

# Add a "Table of Contents" header above the output.
ADD_TITLE = True

# Backup the original file before insertion (only used when inserting into INPUT_FILE).
BACKUP_ON_INSERT = True

# ============================================================================
# Implementation
# ============================================================================


def parse_headings(text: str):
    """Yield (level, title) for each ATX heading, skipping fenced code blocks
    and any region between <!--ts--> and <!--te--> markers (a previously
    inserted TOC) so it doesn't show up in the new one."""
    in_fence = False
    fence_marker = ""
    in_toc_block = False
    heading_re = re.compile(r"^(#{1,6})\s+(.*?)\s*#*\s*$")

    for line in text.splitlines():
        stripped = line.strip()

        # Skip everything inside a previously inserted TOC block.
        if not in_toc_block:
            if stripped == "<!--ts-->":
                in_toc_block = True
                continue
        else:
            if stripped == "<!--te-->":
                in_toc_block = False
            continue

        left_stripped = line.lstrip()

        # Track fenced code blocks (``` or ~~~). Headings inside them aren't headings.
        if not in_fence:
            m = re.match(r"^(`{3,}|~{3,})", left_stripped)
            if m:
                in_fence = True
                fence_marker = m.group(1)[0] * 3
                continue
        else:
            if left_stripped.startswith(fence_marker):
                in_fence = False
            continue

        m = heading_re.match(line)
        if m:
            level = len(m.group(1))
            title = m.group(2).strip()
            if title:
                yield level, title


def slugify(title: str, used: dict) -> str:
    """Generate a GitHub-style anchor slug. `used` tracks duplicates."""
    # Strip markdown formatting: links, code, bold/italic markers
    s = re.sub(r"\[([^\]]+)\]\([^)]+\)", r"\1", title)  # [text](url) -> text
    s = re.sub(r"`([^`]+)`", r"\1", s)                  # `code` -> code
    s = re.sub(r"[*_~]", "", s)                          # strip emphasis
    s = s.strip().lower()
    # GitHub keeps letters, numbers, hyphens, underscores; spaces become hyphens; other chars dropped
    s = re.sub(r"[^\w\s-]", "", s, flags=re.UNICODE)
    s = re.sub(r"\s+", "-", s)
    s = s.strip("-") or "section"

    count = used.get(s, 0)
    used[s] = count + 1
    return s if count == 0 else f"{s}-{count}"


def build_plain_toc(headings, indent: int) -> str:
    """Produce a simple bulleted markdown TOC."""
    if not headings:
        return ""
    base = min(lvl for lvl, _ in headings)
    lines = []
    used = {}
    for level, title in headings:
        anchor = slugify(title, used)
        pad = " " * ((level - base) * indent)
        lines.append(f"{pad}* [{title}](#{anchor})")
    return "\n".join(lines)


def build_collapsible_toc(headings, indent: int, collapse_level: int,
                          top_open: bool) -> str:
    """
    Produce a TOC where headings at level <= collapse_level become <details>
    blocks containing their descendants.
    """
    if not headings:
        return ""

    base = min(lvl for lvl, _ in headings)
    used = {}
    # Precompute anchors and depths
    items = []
    for level, title in headings:
        items.append({
            "level": level,
            "depth": level - base,        # 0-indexed depth
            "title": title,
            "anchor": slugify(title, used),
        })

    out = []
    # Stack of open <details> blocks, each entry is the heading level that opened it
    open_stack = []

    def close_to(target_level):
        """Close any open <details> whose owning level is >= target_level."""
        while open_stack and open_stack[-1] >= target_level:
            lvl = open_stack.pop()
            indent_str = " " * ((lvl - base) * indent)
            out.append(f"{indent_str}</details>")

    for idx, item in enumerate(items):
        close_to(item["level"])

        pad = " " * (item["depth"] * indent)
        link = f"[{item['title']}](#{item['anchor']})"

        # Should this heading become a collapsible? Only if it's at or above
        # the collapse threshold AND it actually has children beneath it.
        is_collapsible = item["level"] <= collapse_level
        has_children = (idx + 1 < len(items)
                        and items[idx + 1]["level"] > item["level"])

        if is_collapsible and has_children:
            opened = " open" if (top_open and item["level"] == base) else ""
            out.append(f"{pad}<details{opened}>")
            out.append(f"{pad}<summary>{link}</summary>")
            out.append("")  # blank line so markdown inside <details> renders
            open_stack.append(item["level"])
        else:
            out.append(f"{pad}- {link}")

    close_to(base)  # close everything still open
    return "\n".join(out)


def generate_toc(text: str) -> str:
    headings = [
        (lvl, title) for lvl, title in parse_headings(text)
        if MIN_LEVEL <= lvl <= MAX_LEVEL
    ]
    if SKIP_FIRST_HEADING and headings:
        headings = headings[1:]

    if not headings:
        return "_(No headings found.)_"

    if COLLAPSE_LEVEL and COLLAPSE_LEVEL > 0:
        body = build_collapsible_toc(headings, INDENT, COLLAPSE_LEVEL, COLLAPSE_TOP_OPEN)
    else:
        body = build_plain_toc(headings, INDENT)

    if ADD_TITLE:
        return f"## Table of Contents\n\n{body}\n"
    return body + "\n"


def insert_into_file(path: Path, toc: str) -> None:
    """Replace content between <!--ts--> and <!--te--> markers with the new TOC."""
    original = path.read_text(encoding="utf-8")
    if "<!--ts-->" not in original or "<!--te-->" not in original:
        print(
            "ERROR: To insert the TOC, the file must contain both <!--ts--> "
            "and <!--te--> marker lines surrounding the TOC location.",
            file=sys.stderr,
        )
        sys.exit(1)

    if BACKUP_ON_INSERT:
        backup = path.with_suffix(path.suffix + ".bak")
        backup.write_text(original, encoding="utf-8")
        print(f"Backup written to: {backup}")

    pattern = re.compile(r"(<!--ts-->)(.*?)(<!--te-->)", re.DOTALL)
    replacement = f"<!--ts-->\n{toc}\n<!--te-->"
    new_text, n = pattern.subn(replacement, original, count=1)
    if n == 0:
        print("ERROR: Could not find marker block to replace.", file=sys.stderr)
        sys.exit(1)
    path.write_text(new_text, encoding="utf-8")
    print(f"TOC inserted into: {path}")


def main() -> None:
    src = Path(INPUT_FILE)
    if not src.is_file():
        print(f"ERROR: Input file not found: {src}", file=sys.stderr)
        sys.exit(1)

    text = src.read_text(encoding="utf-8")
    toc = generate_toc(text)

    if OUTPUT_FILE is None:
        print(toc)
        return

    out_path = Path(OUTPUT_FILE)
    if out_path.resolve() == src.resolve():
        insert_into_file(src, toc)
    else:
        out_path.write_text(toc, encoding="utf-8")
        print(f"TOC written to: {out_path}")


if __name__ == "__main__":
    main()
