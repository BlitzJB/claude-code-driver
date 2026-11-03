#!/bin/sh
# usage: launch.sh <tmux-session> <cwd> <session-uuid> <settings>
exec env -i HOME=$HOME PATH=/Users/dev/.nvm/versions/node/v23.6.0/bin:/opt/homebrew/bin:/usr/bin:/bin:/usr/sbin:/sbin TERM=xterm-256color USER=$USER LOGNAME=$USER SHELL=/bin/zsh LANG=en_US.UTF-8 TMPDIR=$TMPDIR DISABLE_AUTOUPDATER=1 HTTPS_PROXY=http://127.0.0.1:47602 HTTP_PROXY=http://127.0.0.1:47602 NO_PROXY=127.0.0.1,localhost \
  /Users/dev/Projects/claude-code-driver/node_modules/.bin/claude --session-id "$3" --settings "$4" --permission-mode default
