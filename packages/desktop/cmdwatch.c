// Emits "down"/"up" lines on Cmd-key transitions by polling the session's
// global modifier state. Exists because macOS never delivers the Meta keyup
// to a webContents after one of its Cmd-chords was consumed via
// before-input-event — the tab switcher's commit-on-release needs a signal
// that bypasses event routing entirely. CGEventSourceFlagsState is a state
// query, not an event tap: no Accessibility permission required.
// Compiled on first launch by main.cjs: cc -O2 -framework ApplicationServices
#include <ApplicationServices/ApplicationServices.h>
#include <stdbool.h>
#include <stdio.h>
#include <unistd.h>

int main(void) {
  bool down = false;
  setvbuf(stdout, NULL, _IOLBF, 0);
  for (;;) {
    CGEventFlags f = CGEventSourceFlagsState(kCGEventSourceStateCombinedSessionState);
    bool now = (f & kCGEventFlagMaskCommand) != 0;
    if (now != down) {
      puts(now ? "down" : "up");
      down = now;
    }
    usleep(16000);
  }
}
