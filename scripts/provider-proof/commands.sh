#!/bin/sh
set -eu

SCRIPT_DIR=$(CDPATH= cd -- "$(dirname -- "$0")" && pwd)
PROOF="$SCRIPT_DIR/proof.mjs"

if [ "$#" -lt 1 ]; then
  printf '%s\n' 'USAGE: commands.sh <guard|run|external> ...' >&2
  exit 2
fi

mode=$1
shift

case "$mode" in
  guard)
    exec node "$PROOF" guard "$@"
    ;;
  run)
    if [ "$#" -lt 1 ]; then
      printf '%s\n' 'USAGE: commands.sh run <proof.mjs-subcommand> [options]' >&2
      exit 2
    fi
    subcommand=$1
    shift
    case "$subcommand" in
      seal|approval-prepare|approval-attach|verify-credentials|inventory|bootstrap-aws|delivery|failures|lifecycle|gzip|cleanup|cloudflare-api-get)
        exec node "$PROOF" "$subcommand" "$@"
        ;;
      *)
        printf '%s\n' 'COMMAND_NOT_IN_RUNBOOK' >&2
        exit 2
        ;;
    esac
    ;;
  external)
    exec node "$PROOF" external "$@"
    ;;
  *)
    printf '%s\n' 'UNKNOWN_COMMANDS_MODE' >&2
    exit 2
    ;;
esac
