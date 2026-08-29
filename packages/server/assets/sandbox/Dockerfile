# packages/server/assets/sandbox/Dockerfile
# The Strado sandbox base: a toolchain plus the agent CLIs, built locally on
# the runner (no registry — a hard registry dependency is wrong for the
# air-gapped/in-VPC segment). Rebuilt per node major; project deps go in the
# worktree, never in here.
ARG NODE_MAJOR=22
FROM node:${NODE_MAJOR}-bookworm

# Basics agents lean on constantly. Kept deliberately short.
RUN apt-get update && apt-get install -y --no-install-recommends \
    git openssh-client curl ca-certificates ripgrep jq \
    && rm -rf /var/lib/apt/lists/*

# The agents. Baked into the image layer — installed once, shared by every
# sandbox, versioned with the image (spec decision 4).
RUN npm install -g @anthropic-ai/claude-code @openai/codex opencode-ai \
    @earendil-works/pi-coding-agent \
    && corepack enable

# askpass: answers git's credential prompt from env, so the push token is never
# written to disk inside the sandbox. Username line for the token; anything else
# (the password prompt) gets the token itself.
RUN printf '#!/bin/sh\ncase "$1" in *sername*) echo "${GIT_HTTP_USER:-x-access-token}";; *) echo "${GITHUB_TOKEN:-$GITLAB_TOKEN}";; esac\n' \
    > /usr/local/bin/strado-askpass && chmod +x /usr/local/bin/strado-askpass

# Trust bind-mounted repos regardless of the ownership git sees across the
# container boundary. Written as root so it lands in /etc/gitconfig and the
# unprivileged runtime user can't be blocked by "detected dubious ownership".
RUN git config --system --add safe.directory '*'

# Run as the base image's existing `node` user, which is uid 1000 — the same
# uid as the first non-root user on a stock Linux runner. With
# `--userns=keep-id` that maps to the host runner user, so files the agent
# writes in the bind-mounted worktree are owned by the runner user, not a
# subuid. Creating a NEW user here is wrong: node:bookworm already owns uid
# 1000, so `useradd strado` lands on 1001 and the container can no longer
# write the host-1000-owned worktree (verified on a real runner).
USER node
WORKDIR /home/node
