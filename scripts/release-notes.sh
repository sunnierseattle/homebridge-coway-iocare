#!/bin/sh
# Print the release notes for a tag from CHANGELOG.md, or fail if there are none.
#
#   sh scripts/release-notes.sh v1.4.1           # the section's body
#   sh scripts/release-notes.sh v1.4.1 --title   # its heading, e.g. "v1.4.1 — Title"
#
# Sections are headed "## <tag> — <title>". Both `npm version` and the release
# workflow run this, so a version cannot be tagged or published without notes.
set -eu

tag="${1:?usage: release-notes.sh <tag> [--title]}"
mode="${2:-}"
changelog="${CHANGELOG:-CHANGELOG.md}"

if [ ! -f "$changelog" ]; then
  echo "release-notes: $changelog not found" >&2
  exit 1
fi

# The heading must be the tag followed by a space or the end of the line, so
# v1.4.1 does not match v1.4.10.
heading=$(awk -v tag="$tag" '
  index($0, "## " tag) == 1 {
    rest = substr($0, length("## " tag) + 1)
    if (rest == "" || substr(rest, 1, 1) == " ") { print substr($0, 4); exit }
  }' "$changelog")

if [ -z "$heading" ]; then
  echo "release-notes: no \"## $tag\" section in $changelog. Add release notes before releasing." >&2
  exit 1
fi

if [ "$mode" = "--title" ]; then
  printf '%s\n' "$heading"
  exit 0
fi

body=$(awk -v heading="## $heading" '
  $0 == heading { inside = 1; next }
  inside && /^## v[0-9]/ { exit }
  inside && !started && /^[[:space:]]*$/ { next }
  inside { started = 1; print }' "$changelog")

if [ -z "$(printf '%s' "$body" | tr -d '[:space:]')" ]; then
  echo "release-notes: the \"## $tag\" section in $changelog is empty." >&2
  exit 1
fi

printf '%s\n' "$body"
