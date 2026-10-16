#!/bin/sh
# Requires Python >=3.12 and Node >=22. No network or delivery side effects.
set -eu
python3 tools/build.py
python3 tools/test_refresh_likes.py
node tools/test_form_endpoint.cjs
node tools/test_site_interactions.cjs
node tools/test_navigation_gate.cjs
node tools/test_font_loading.cjs
python3 tools/test_performance_budget.py
node tools/test_post_actions.cjs
python3 tools/test_security_policy.py
node tools/test_security_worker.mjs
python3 tools/check_secrets.py
