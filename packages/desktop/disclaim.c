// strado-disclaim: run argv[1..] as its own "responsible process" (macOS
// privacy), inheriting every open fd, then mirror its exit status.
#include <dlfcn.h>
#include <errno.h>
#include <signal.h>
#include <spawn.h>
#include <stdio.h>
#include <sys/wait.h>
#include <string.h>
#include <unistd.h>
extern char **environ;
static pid_t child = 0;
static void forward(int sig) { if (child > 0) kill(child, sig); }
int main(int argc, char **argv) {
  if (argc < 2) { fprintf(stderr, "usage: strado-disclaim prog [args...]\n"); return 64; }
  posix_spawnattr_t attr;
  posix_spawnattr_init(&attr);
  typedef int (*disclaim_fn)(posix_spawnattr_t *, int);
  disclaim_fn setdisclaim = (disclaim_fn)dlsym(RTLD_DEFAULT, "responsibility_spawnattrs_setdisclaim");
  if (!setdisclaim || setdisclaim(&attr, 1) != 0) fprintf(stderr, "strado-disclaim: disclaim unavailable; running as-is\n");
  int rc = posix_spawn(&child, argv[1], NULL, &attr, &argv[1], environ);
  posix_spawnattr_destroy(&attr);
  if (rc != 0) { fprintf(stderr, "strado-disclaim: spawn %s: %s\n", argv[1], strerror(rc)); return 127; }
  signal(SIGTERM, forward); signal(SIGINT, forward); signal(SIGHUP, forward);
  int status = 0;
  while (waitpid(child, &status, 0) < 0 && errno == EINTR) {}
  if (WIFSIGNALED(status)) { signal(WTERMSIG(status), SIG_DFL); kill(getpid(), WTERMSIG(status)); }
  return WIFEXITED(status) ? WEXITSTATUS(status) : 1;
}
