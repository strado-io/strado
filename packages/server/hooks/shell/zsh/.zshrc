# Loaded only for an interactive shell inside a Strado Shell tab. Source the
# user's real config first, then make the scoped agent launchers authoritative.
if [[ -n ${STRADO_USER_ZDOTDIR:-} && -r ${STRADO_USER_ZDOTDIR}/.zshrc ]]; then
  ZDOTDIR=${STRADO_USER_ZDOTDIR}
  source "${STRADO_USER_ZDOTDIR}/.zshrc"
fi

export PATH="${STRADO_AGENT_BIN_DIR}:${PATH}"

# macOS /etc/zshrc points HISTFILE at ${ZDOTDIR:-$HOME}, which is Strado's own
# hooks directory here — history would land inside the install (and split from
# the user's own) unless it is aimed back at their real profile.
export HISTFILE="${STRADO_USER_ZDOTDIR:-${HOME}}/.zsh_history"
