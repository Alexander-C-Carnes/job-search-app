#!/bin/bash
# Start the web app: ./start.sh (the same as `./jobsearch run`; see `./jobsearch help`).
exec "$(dirname "$0")/jobsearch" run "$@"
