#!/usr/bin/env bash
# ADK launcher for macOS and Linux (Windows: adk.cmd).
#
#   ./adk.sh           start ADK; opens the setup wizard first when there is no configuration
#   ./adk.sh setup     open the setup wizard to change the configuration, then restart
#   ./adk.sh stop      stop ADK (data is kept)
#   ./adk.sh logs      follow the logs (optionally of one service: ./adk.sh logs api)
#   ./adk.sh status    list the services and their health
#   ./adk.sh update    download the latest version and restart
set -euo pipefail
cd "$(dirname "$0")"

SETUP_PORT="${ADK_SETUP_PORT:-4000}"
ALL_PROFILES=(--profile e2e --profile mcp --profile mail)

say() { printf '\033[36m›\033[0m %s\n' "$*"; }
ok() { printf '\033[32m✓\033[0m \033[1m%s\033[0m\n' "$*"; }
fail() {
  printf '\033[31m✗ %s\033[0m\n' "$*" >&2
  exit 1
}

# Reads KEY from .env (the wizard writes plain or single-quoted values).
env_value() {
  local value=""
  if [ -f .env ]; then
    value="$(grep -E "^$1=" .env | tail -n 1 | cut -d= -f2- | sed -e "s/^'\(.*\)'\$/\1/")"
  fi
  printf '%s' "${value:-$2}"
}

check_docker() {
  command -v docker >/dev/null 2>&1 ||
    fail "Docker is not installed. Install Docker Desktop: https://docs.docker.com/get-docker/"
  docker info >/dev/null 2>&1 ||
    fail "Docker is not running. Start Docker Desktop (or the Docker service) and try again."
  docker compose version >/dev/null 2>&1 ||
    fail "Docker Compose v2 is missing. Update Docker: https://docs.docker.com/compose/install/"
}

open_url() {
  if [ "$(uname)" = Darwin ]; then
    open "$1" >/dev/null 2>&1 || true
  elif command -v wslview >/dev/null 2>&1; then
    wslview "$1" >/dev/null 2>&1 || true
  elif command -v xdg-open >/dev/null 2>&1; then
    xdg-open "$1" >/dev/null 2>&1 || true
  fi
}

setup_down() {
  docker compose -f setup/compose.yaml down >/dev/null 2>&1 || true
}

# Runs the wizard and returns its exit code: 0 start now, 10 saved only, 2 cancelled.
run_setup() {
  export ADK_SETUP_LAUNCHER=1 ADK_SETUP_PORT="$SETUP_PORT"
  if [ "$(uname)" = Linux ]; then
    # Keeps .env owned by you instead of root.
    export ADK_UID ADK_GID
    ADK_UID="$(id -u)"
    ADK_GID="$(id -g)"
  fi
  say "Starting the setup wizard…"
  setup_down
  docker compose -f setup/compose.yaml up -d --wait >/dev/null ||
    fail "Could not start the setup wizard. Is port $SETUP_PORT free? Choose another one with ADK_SETUP_PORT=4100 ./adk.sh setup"
  trap 'setup_down; exit 130' INT TERM
  local url="http://localhost:$SETUP_PORT"
  ok "Setup wizard ready: $url"
  say "Finish the steps in your browser. Press Ctrl+C here to cancel."
  open_url "$url"
  local code
  code="$(docker wait adk-setup)"
  if [ "$code" != 0 ] && [ "$code" != 10 ] && [ "$code" != 2 ]; then
    docker logs adk-setup >&2 || true
  fi
  setup_down
  trap - INT TERM
  return "$code"
}

# Removes containers of optional services that the configuration turned off.
remove_disabled() {
  local profiles
  profiles=",$(env_value COMPOSE_PROFILES ''),"
  local disabled=()
  [[ "$profiles" == *",e2e,"* ]] || disabled+=(worker)
  [[ "$profiles" == *",mcp,"* ]] || disabled+=(mcp)
  [[ "$profiles" == *",mail,"* ]] || disabled+=(mailpit)
  if [ ${#disabled[@]} -gt 0 ]; then
    docker compose "${ALL_PROFILES[@]}" rm --stop --force "${disabled[@]}" >/dev/null 2>&1 || true
  fi
}

up() {
  local opened_by_setup="${1:-0}"
  remove_disabled
  say "Building and starting ADK. The first start can take 5 to 15 minutes; later starts take seconds."
  docker compose up -d --build --remove-orphans --wait --wait-timeout 1800 ||
    fail "ADK did not start. See what happened with: ./adk.sh logs"
  local web
  web="$(env_value FRONTEND_URL http://localhost:8080)"
  echo
  ok "ADK is running at $web"
  echo "  Stop it with ./adk.sh stop · change settings with ./adk.sh setup · logs with ./adk.sh logs"
  # The wizard page already follows the start and links to the app.
  [ "$opened_by_setup" = 1 ] || open_url "$web"
}

setup_then_start() {
  local code=0
  run_setup || code=$?
  case "$code" in
    0) up 1 ;;
    10) ok "Configuration saved. Start ADK with: ./adk.sh" ;;
    2) say "Setup cancelled. Nothing was changed." ;;
    *) fail "The setup wizard stopped unexpectedly (exit code $code)." ;;
  esac
}

command="${1:-start}"
[ $# -gt 0 ] && shift

case "$command" in
  start)
    check_docker
    if [ -f .env ]; then up; else setup_then_start; fi
    ;;
  setup)
    check_docker
    setup_then_start
    ;;
  stop)
    check_docker
    docker compose "${ALL_PROFILES[@]}" down
    ok "ADK stopped. Your data is kept; start again with ./adk.sh"
    ;;
  logs)
    check_docker
    docker compose logs --follow --tail 200 "$@"
    ;;
  status)
    check_docker
    docker compose ps
    ;;
  update)
    check_docker
    if [ -d .git ]; then
      say "Downloading the latest version…"
      git pull --ff-only || fail "Could not update. Commit or stash your local changes and try again."
    fi
    if [ -f .env ]; then up; else setup_then_start; fi
    ;;
  help | -h | --help)
    sed -n '2,9p' "$0" | sed 's/^# \{0,1\}//'
    ;;
  *)
    fail "Unknown command: $command. Run ./adk.sh help"
    ;;
esac
