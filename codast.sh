#!/bin/sh
set -eu

command=${1:-start}
if [ "$#" -gt 1 ]; then
    printf 'Usage: sh ./codast.sh [init|start|test|help]\n' >&2
    exit 2
fi
case "$command" in
    init|start|test) ;;
    help)
        printf '%s\n' \
            'sh ./codast.sh init   - Install packages and shared Serena/Context7 tools' \
            'sh ./codast.sh start  - Prepare packages and start CODAST (default)' \
            'sh ./codast.sh test   - Prepare packages and run Python tests'
        exit 0
        ;;
    *)
        printf 'Unknown command: %s. Use init, start, test or help.\n' "$command" >&2
        exit 2
        ;;
esac

CDPATH= cd -P "$(dirname "$0")"
project_dir=$(pwd -P)
uv_path="$project_dir/.local/uv/uv"
if [ ! -x "$uv_path" ]; then
    if command -v uv >/dev/null 2>&1; then
        uv_path=$(command -v uv)
    else
        printf 'Installing uv from astral.sh...\n'
        mkdir -p "$project_dir/.local"
        installer="$project_dir/.local/uv-install.sh"
        if command -v curl >/dev/null 2>&1; then
            curl --fail --location --silent --show-error --max-time 60 \
                --output "$installer" https://astral.sh/uv/install.sh
        elif command -v wget >/dev/null 2>&1; then
            wget -q --timeout=60 -O "$installer" https://astral.sh/uv/install.sh
        else
            printf 'Install curl or wget, or install uv with your package manager first.\n' >&2
            exit 1
        fi
        if ! UV_UNMANAGED_INSTALL="$project_dir/.local/uv" sh "$installer"; then
            printf 'uv installation failed. Check the download output and try again.\n' >&2
            exit 1
        fi
        if [ ! -x "$uv_path" ]; then
            printf 'uv installation did not produce an executable. Try again.\n' >&2
            exit 1
        fi
    fi
fi

# Keep setup local even if a different project's environment is active.
export UV_PROJECT_ENVIRONMENT="$project_dir/.venv"
printf 'Preparing Python and project packages from uv.lock...\n'
set -- sync --locked --inexact
if [ ! -x "$UV_PROJECT_ENVIRONMENT/bin/python" ]; then
    set -- "$@" --python 3.12
fi
"$uv_path" "$@" || {
    status=$?
    printf 'Package setup failed. Fix the error above and run the command again.\n' >&2
    exit "$status"
}

case "$command" in
    init)
        "$uv_path" run --no-sync python -m app.core.toolchain --uv "$uv_path"
        printf '%s\n' \
            'Setup complete. Run sh ./codast.sh start to open the server.' \
            'Install and sign in to Codex or Claude Code separately to use AI.'
        ;;
    test) exec "$uv_path" run --no-sync python -m pytest -q ;;
    start)
        printf 'CODAST: http://127.0.0.1:8765 (Ctrl+C to stop)\n'
        exec "$uv_path" run --no-sync python start.py
        ;;
esac
